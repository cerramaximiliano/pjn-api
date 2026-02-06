/**
 * Controller para Stuck Documents Worker Stats
 * Endpoints para consultar estadísticas y gestionar documentos atorados
 */
const { CausasCivil, CausasComercial, CausasSegSoc, CausasTrabajo } = require('pjn-models');
const ConfiguracionStuckDocuments = require('../models/configuracionStuckDocuments');
const WorkerLog = require('../models/workerLog');
const { logger } = require('../config/pino');

// Helper para obtener modelo por fuero
const getModel = (fuero) => {
    switch (fuero) {
        case 'CIV': return CausasCivil;
        case 'COM': return CausasComercial;
        case 'CSS': return CausasSegSoc;
        case 'CNT': return CausasTrabajo;
        default: throw new Error('Fuero no válido');
    }
};

// Query base para documentos stuck (sin movimientos)
const getStuckQuery = (sources = ['app']) => ({
    source: { $in: sources },
    verified: true,
    isValid: true,
    isArchived: { $ne: true }, // Excluir archivados
    $or: [
        { movimientosCount: 0 },
        { movimientosCount: { $exists: false } },
        {
            $and: [
                { movimiento: { $exists: true } },
                { movimiento: { $size: 0 } }
            ]
        }
    ]
});

const stuckDocumentsController = {
    /**
     * Obtener estadísticas completas del stuck documents worker
     * GET /api/workers/stuck-documents/stats
     */
    async getStats(req, res) {
        try {
            const { hours = 24 } = req.query;
            const hoursNum = parseInt(hours);

            // 1. Obtener configuración del worker
            const config = await ConfiguracionStuckDocuments.findOne({
                worker_id: 'stuck_documents_main'
            }).lean();

            // 2. Contar documentos stuck por fuero y source
            const models = [
                { model: CausasCivil, name: 'Civil', fuero: 'CIV' },
                { model: CausasComercial, name: 'Comercial', fuero: 'COM' },
                { model: CausasSegSoc, name: 'Seg. Social', fuero: 'CSS' },
                { model: CausasTrabajo, name: 'Trabajo', fuero: 'CNT' }
            ];

            const pendingByFuero = {};
            let totalPendingApp = 0;
            let totalPendingPjnLogin = 0;

            for (const { model, name, fuero } of models) {
                // Documentos con source: app (procesados por el worker actualmente)
                const appCount = await model.countDocuments(getStuckQuery(['app']));
                // Documentos con source: pjn-login (NO procesados actualmente)
                const pjnLoginCount = await model.countDocuments(getStuckQuery(['pjn-login']));
                // Documentos con source: cache
                const cacheCount = await model.countDocuments(getStuckQuery(['cache']));

                pendingByFuero[fuero] = {
                    name,
                    app: appCount,
                    pjnLogin: pjnLoginCount,
                    cache: cacheCount,
                    total: appCount + pjnLoginCount + cacheCount
                };

                totalPendingApp += appCount;
                totalPendingPjnLogin += pjnLoginCount;
            }

            // 3. Obtener logs recientes
            const since = new Date();
            since.setHours(since.getHours() - hoursNum);

            const recentLogs = await WorkerLog.find({
                workerType: 'stuck_documents',
                startTime: { $gte: since }
            })
                .sort({ startTime: -1 })
                .limit(100)
                .lean();

            // Agrupar por status
            const logsByStatus = { success: 0, partial: 0, failed: 0, in_progress: 0 };
            const processedDocuments = new Set();
            let totalMovimientosAdded = 0;

            for (const log of recentLogs) {
                logsByStatus[log.status] = (logsByStatus[log.status] || 0) + 1;
                if (log.document?.documentId) {
                    processedDocuments.add(log.document.documentId.toString());
                }
                totalMovimientosAdded += log.changes?.movimientosAdded || 0;
            }

            // 4. Identificar documentos que fallan repetidamente (logs recientes)
            const repeatedFailures = await WorkerLog.aggregate([
                {
                    $match: {
                        workerType: 'stuck_documents',
                        startTime: { $gte: since },
                        status: { $in: ['partial', 'failed'] }
                    }
                },
                {
                    $group: {
                        _id: '$document.documentId',
                        count: { $sum: 1 },
                        number: { $first: '$document.number' },
                        year: { $first: '$document.year' },
                        fuero: { $first: '$document.fuero' },
                        model: { $first: '$document.model' },
                        lastAttempt: { $max: '$startTime' },
                        lastStatus: { $last: '$status' },
                        lastMessage: { $last: '$result.message' }
                    }
                },
                { $match: { count: { $gte: 3 } } },
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]);

            // 4.1 Identificar documentos crónicamente atorados (busca en documentos directamente)
            // Documentos que siguen atorados y tienen múltiples intentos del worker
            const chronicStuck = [];
            for (const { model, fuero } of models) {
                const stuckDocs = await model.aggregate([
                    {
                        $match: {
                            source: { $in: ['app', 'cache'] },
                            verified: true,
                            isValid: true,
                            isArchived: { $ne: true },
                            $or: [
                                { movimientosCount: 0 },
                                { movimientosCount: { $exists: false } }
                            ],
                            'updateHistory.source': 'stuck_documents_worker'
                        }
                    },
                    {
                        $project: {
                            number: 1,
                            year: 1,
                            caratula: 1,
                            folderIds: 1,
                            fechaUltimoMovimiento: 1,
                            stuckAttempts: {
                                $filter: {
                                    input: { $ifNull: ['$updateHistory', []] },
                                    as: 'h',
                                    cond: { $eq: ['$$h.source', 'stuck_documents_worker'] }
                                }
                            }
                        }
                    },
                    {
                        $addFields: {
                            attemptCount: { $size: '$stuckAttempts' },
                            firstAttempt: { $arrayElemAt: ['$stuckAttempts.timestamp', 0] },
                            lastAttempt: { $arrayElemAt: ['$stuckAttempts.timestamp', -1] }
                        }
                    },
                    { $match: { attemptCount: { $gte: 2 } } },
                    { $sort: { attemptCount: -1 } },
                    { $limit: 10 }
                ]);

                for (const doc of stuckDocs) {
                    const daysSinceFirst = doc.firstAttempt
                        ? Math.floor((Date.now() - new Date(doc.firstAttempt).getTime()) / (1000 * 60 * 60 * 24))
                        : null;

                    chronicStuck.push({
                        documentId: doc._id,
                        expediente: `${doc.number}/${doc.year}`,
                        fuero,
                        caratula: doc.caratula,
                        hasFolders: doc.folderIds && doc.folderIds.length > 0,
                        foldersCount: doc.folderIds?.length || 0,
                        attemptCount: doc.attemptCount,
                        firstAttempt: doc.firstAttempt,
                        lastAttempt: doc.lastAttempt,
                        daysSinceFirst,
                        hasDateDiscordance: !!doc.fechaUltimoMovimiento
                    });
                }
            }

            // Ordenar por días atorado descendente
            chronicStuck.sort((a, b) => (b.daysSinceFirst || 0) - (a.daysSinceFirst || 0));

            // 5. Calcular tiempo desde última ejecución
            let timeSinceLastCheck = null;
            if (config?.last_check) {
                const diffMs = Date.now() - new Date(config.last_check).getTime();
                const diffMins = Math.floor(diffMs / (1000 * 60));
                const diffHours = Math.floor(diffMins / 60);
                timeSinceLastCheck = diffHours > 0
                    ? `${diffHours}h ${diffMins % 60}m`
                    : `${diffMins}m`;
            }

            // 6. Determinar estado de salud
            let health = 'healthy';
            let healthMessage = 'Worker funcionando correctamente';

            if (!config?.enabled) {
                health = 'disabled';
                healthMessage = 'Worker deshabilitado';
            } else if (!config?.last_check) {
                health = 'unknown';
                healthMessage = 'Sin datos de última ejecución';
            } else {
                const diffMs = Date.now() - new Date(config.last_check).getTime();
                const diffMins = Math.floor(diffMs / (1000 * 60));

                if (diffMins > 30) {
                    health = 'warning';
                    healthMessage = 'Worker no ejecuta hace más de 30 minutos';
                }
                if (diffMins > 60) {
                    health = 'critical';
                    healthMessage = 'Worker no ejecuta hace más de 1 hora';
                }
            }

            // También verificar tasa de éxito
            const totalAttempts = recentLogs.length;
            const successRate = totalAttempts > 0
                ? ((logsByStatus.success / totalAttempts) * 100).toFixed(1)
                : 0;

            if (totalAttempts > 10 && parseFloat(successRate) < 10) {
                health = 'critical';
                healthMessage = `Tasa de éxito muy baja: ${successRate}%`;
            }

            res.json({
                success: true,
                message: 'Estadísticas del stuck documents worker',
                data: {
                    worker: {
                        enabled: config?.enabled || false,
                        processingMode: config?.processing_mode || 'all',
                        lastCheck: config?.last_check || null,
                        timeSinceLastCheck,
                        health,
                        healthMessage
                    },
                    totals: {
                        processed: config?.documents_processed || 0,
                        fixed: config?.documents_fixed || 0,
                        failed: config?.documents_failed || 0,
                        successRate: config?.documents_processed > 0
                            ? ((config.documents_fixed / config.documents_processed) * 100).toFixed(1)
                            : 0
                    },
                    pending: {
                        byFuero: pendingByFuero,
                        totalApp: totalPendingApp,
                        totalPjnLogin: totalPendingPjnLogin,
                        total: totalPendingApp + totalPendingPjnLogin,
                        note: totalPendingPjnLogin > 0
                            ? `⚠️ ${totalPendingPjnLogin} documentos pjn-login NO están siendo procesados`
                            : null
                    },
                    recent: {
                        period: `${hoursNum}h`,
                        totalLogs: recentLogs.length,
                        uniqueDocuments: processedDocuments.size,
                        byStatus: logsByStatus,
                        movimientosAdded: totalMovimientosAdded,
                        successRate: `${successRate}%`
                    },
                    repeatedFailures: repeatedFailures.map(doc => ({
                        documentId: doc._id,
                        expediente: `${doc.number}/${doc.year}`,
                        fuero: doc.fuero || doc.model?.replace('Causas', ''),
                        attempts: doc.count,
                        lastAttempt: doc.lastAttempt,
                        lastStatus: doc.lastStatus,
                        lastMessage: doc.lastMessage
                    })),
                    chronicStuck: chronicStuck.slice(0, 20) // Limitar a 20
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo stats de stuck documents: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener lista de documentos stuck pendientes
     * GET /api/workers/stuck-documents/pending
     */
    async getPendingDocuments(req, res) {
        try {
            const { fuero, source = 'all', page = 1, limit = 20 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);

            const models = fuero
                ? [{ model: getModel(fuero), fuero }]
                : [
                    { model: CausasCivil, fuero: 'CIV' },
                    { model: CausasComercial, fuero: 'COM' },
                    { model: CausasSegSoc, fuero: 'CSS' },
                    { model: CausasTrabajo, fuero: 'CNT' }
                ];

            const sources = source === 'all'
                ? ['app', 'pjn-login', 'cache']
                : [source];

            let allDocuments = [];
            let totalCount = 0;

            for (const { model, fuero: f } of models) {
                const query = getStuckQuery(sources);
                const count = await model.countDocuments(query);
                totalCount += count;

                const docs = await model.find(query)
                    .select('number year caratula juzgado objeto source createdAt lastUpdate scrapingProgress updateHistory')
                    .sort({ createdAt: 1 })
                    .skip(skip)
                    .limit(parseInt(limit))
                    .lean();

                allDocuments.push(...docs.map(doc => ({
                    ...doc,
                    fuero: f,
                    retryCount: doc.updateHistory?.filter(h => h.source === 'stuck_documents_worker').length || 0
                })));
            }

            // Ordenar por fecha de creación y limitar
            allDocuments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            allDocuments = allDocuments.slice(0, parseInt(limit));

            res.json({
                success: true,
                message: `${allDocuments.length} documentos stuck encontrados`,
                count: allDocuments.length,
                total: totalCount,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(totalCount / parseInt(limit)),
                    hasMore: skip + allDocuments.length < totalCount
                },
                data: allDocuments
            });
        } catch (error) {
            logger.error(`Error obteniendo documentos pendientes: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener logs recientes del stuck documents worker
     * GET /api/workers/stuck-documents/logs
     */
    async getRecentLogs(req, res) {
        try {
            const { hours = 24, status, limit = 50 } = req.query;

            const since = new Date();
            since.setHours(since.getHours() - parseInt(hours));

            const query = {
                workerType: 'stuck_documents',
                startTime: { $gte: since }
            };

            if (status) {
                query.status = status;
            }

            const logs = await WorkerLog.find(query)
                .sort({ startTime: -1 })
                .limit(parseInt(limit))
                .lean();

            res.json({
                success: true,
                message: `${logs.length} logs encontrados`,
                period: `${hours}h`,
                count: logs.length,
                data: logs.map(log => ({
                    id: log._id,
                    status: log.status,
                    startTime: log.startTime,
                    endTime: log.endTime,
                    duration: log.duration,
                    document: log.document ? {
                        id: log.document.documentId,
                        expediente: `${log.document.number}/${log.document.year}`,
                        fuero: log.document.fuero || log.document.model?.replace('Causas', ''),
                        movimientosBefore: log.document.stateBefore?.movimientosCount || 0,
                        movimientosAfter: log.document.stateAfter?.movimientosCount
                    } : null,
                    movimientosAdded: log.changes?.movimientosAdded || 0,
                    message: log.result?.message,
                    error: log.result?.error?.message
                }))
            });
        } catch (error) {
            logger.error(`Error obteniendo logs: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Marcar un documento como archivado (excluirlo del procesamiento)
     * POST /api/workers/stuck-documents/archive/:fuero/:id
     */
    async archiveDocument(req, res) {
        try {
            const { fuero, id } = req.params;
            const { reason } = req.body;

            const Model = getModel(fuero);

            const doc = await Model.findById(id);
            if (!doc) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado'
                });
            }

            // Marcar como archivado
            doc.isArchived = true;
            doc.archivedDetectedAt = new Date();
            doc.archivedReason = reason || 'Marcado manualmente como sin movimientos';

            // Agregar al historial
            if (!doc.updateHistory) doc.updateHistory = [];
            doc.updateHistory.push({
                timestamp: new Date(),
                source: 'admin_manual',
                updateType: 'archive',
                success: true,
                details: {
                    reason: reason || 'Marcado manualmente como sin movimientos',
                    archivedBy: 'admin'
                }
            });

            await doc.save();

            logger.info(`Documento ${doc.number}/${doc.year} (${fuero}) marcado como archivado`);

            res.json({
                success: true,
                message: `Documento ${doc.number}/${doc.year} marcado como archivado`,
                data: {
                    id: doc._id,
                    number: doc.number,
                    year: doc.year,
                    fuero,
                    isArchived: true,
                    archivedAt: doc.archivedDetectedAt
                }
            });
        } catch (error) {
            logger.error(`Error archivando documento: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Desarchivar un documento (volver a incluirlo en el procesamiento)
     * POST /api/workers/stuck-documents/unarchive/:fuero/:id
     */
    async unarchiveDocument(req, res) {
        try {
            const { fuero, id } = req.params;

            const Model = getModel(fuero);

            const doc = await Model.findById(id);
            if (!doc) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado'
                });
            }

            // Quitar marca de archivado
            doc.isArchived = false;
            doc.archivedDetectedAt = null;
            doc.archivedReason = null;

            // Agregar al historial
            if (!doc.updateHistory) doc.updateHistory = [];
            doc.updateHistory.push({
                timestamp: new Date(),
                source: 'admin_manual',
                updateType: 'unarchive',
                success: true,
                details: {
                    reason: 'Desarchivado manualmente',
                    unarchivedBy: 'admin'
                }
            });

            await doc.save();

            logger.info(`Documento ${doc.number}/${doc.year} (${fuero}) desarchivado`);

            res.json({
                success: true,
                message: `Documento ${doc.number}/${doc.year} desarchivado`,
                data: {
                    id: doc._id,
                    number: doc.number,
                    year: doc.year,
                    fuero,
                    isArchived: false
                }
            });
        } catch (error) {
            logger.error(`Error desarchivando documento: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Habilitar/deshabilitar el worker
     * POST /api/workers/stuck-documents/toggle
     */
    async toggleWorker(req, res) {
        try {
            const { enabled } = req.body;

            const config = await ConfiguracionStuckDocuments.findOneAndUpdate(
                { worker_id: 'stuck_documents_main' },
                { $set: { enabled: enabled } },
                { new: true }
            );

            if (!config) {
                return res.status(404).json({
                    success: false,
                    message: 'Configuración del worker no encontrada'
                });
            }

            logger.info(`Stuck documents worker ${enabled ? 'habilitado' : 'deshabilitado'}`);

            res.json({
                success: true,
                message: `Worker ${enabled ? 'habilitado' : 'deshabilitado'}`,
                data: {
                    enabled: config.enabled,
                    worker_id: config.worker_id
                }
            });
        } catch (error) {
            logger.error(`Error toggling worker: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener configuración completa del worker
     * GET /api/workers/stuck-documents/config
     */
    async getConfig(req, res) {
        try {
            let config = await ConfiguracionStuckDocuments.findOne({
                worker_id: 'stuck_documents_main'
            });

            // Si no existe, crear con valores por defecto
            if (!config) {
                config = await ConfiguracionStuckDocuments.create({
                    worker_id: 'stuck_documents_main',
                    fuero: 'CIV',
                    processing_mode: 'all',
                    enabled: true,
                    batch_size: 3,
                    lock_timeout_minutes: 20,
                    schedule: {
                        cronPattern: '*/10 * * * *',
                        workingDays: [1, 2, 3, 4, 5],
                        workingHoursStart: 8,
                        workingHoursEnd: 22,
                        timezone: 'America/Argentina/Buenos_Aires',
                        pauseOnWeekends: true,
                        pauseOnHolidays: false
                    }
                });
            }

            res.json({
                success: true,
                message: 'Configuración del stuck documents worker',
                data: config
            });
        } catch (error) {
            logger.error(`Error obteniendo configuración: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Actualizar configuración del worker
     * PATCH /api/workers/stuck-documents/config
     */
    async updateConfig(req, res) {
        try {
            const allowedFields = [
                'enabled',
                'processing_mode',
                'batch_size',
                'lock_timeout_minutes',
                'schedule.cronPattern',
                'schedule.workingDays',
                'schedule.workingHoursStart',
                'schedule.workingHoursEnd',
                'schedule.timezone',
                'schedule.pauseOnWeekends',
                'schedule.pauseOnHolidays'
            ];

            const updates = {};

            // Procesar campos permitidos
            for (const field of allowedFields) {
                const value = field.includes('.')
                    ? req.body[field.split('.')[0]]?.[field.split('.')[1]]
                    : req.body[field];

                if (value !== undefined) {
                    updates[field] = value;
                }
            }

            // También aceptar schedule como objeto completo
            if (req.body.schedule && typeof req.body.schedule === 'object') {
                const scheduleFields = ['cronPattern', 'workingDays', 'workingHoursStart', 'workingHoursEnd', 'timezone', 'pauseOnWeekends', 'pauseOnHolidays'];
                for (const sf of scheduleFields) {
                    if (req.body.schedule[sf] !== undefined) {
                        updates[`schedule.${sf}`] = req.body.schedule[sf];
                    }
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No se proporcionaron campos válidos para actualizar'
                });
            }

            const config = await ConfiguracionStuckDocuments.findOneAndUpdate(
                { worker_id: 'stuck_documents_main' },
                { $set: updates },
                { new: true, runValidators: true }
            );

            if (!config) {
                return res.status(404).json({
                    success: false,
                    message: 'Configuración del worker no encontrada'
                });
            }

            logger.info(`Configuración de stuck documents actualizada: ${JSON.stringify(updates)}`);

            res.json({
                success: true,
                message: 'Configuración actualizada correctamente',
                data: config
            });
        } catch (error) {
            logger.error(`Error actualizando configuración: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Resetear estadísticas del worker
     * POST /api/workers/stuck-documents/reset-stats
     */
    async resetStats(req, res) {
        try {
            const config = await ConfiguracionStuckDocuments.findOneAndUpdate(
                { worker_id: 'stuck_documents_main' },
                {
                    $set: {
                        documents_processed: 0,
                        documents_fixed: 0,
                        documents_failed: 0
                    }
                },
                { new: true }
            );

            if (!config) {
                return res.status(404).json({
                    success: false,
                    message: 'Configuración del worker no encontrada'
                });
            }

            logger.info('Estadísticas de stuck documents reseteadas');

            res.json({
                success: true,
                message: 'Estadísticas reseteadas correctamente',
                data: {
                    documents_processed: config.documents_processed,
                    documents_fixed: config.documents_fixed,
                    documents_failed: config.documents_failed
                }
            });
        } catch (error) {
            logger.error(`Error reseteando estadísticas: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    }
};

module.exports = stuckDocumentsController;
