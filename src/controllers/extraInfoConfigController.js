/**
 * Controller para Extra-Info Config
 * Endpoints para gestionar la configuración del Extra-Info Worker
 * (Extracción de intervinientes desde PJN)
 */
const { ConfiguracionExtraInfo } = require('pjn-models');
const mongoose = require('mongoose');
const { logger } = require('../config/pino');

const extraInfoConfigController = {
    /**
     * Obtener configuración completa del worker
     * GET /api/extra-info-config
     */
    async getConfig(req, res) {
        try {
            const config = await ConfiguracionExtraInfo.getOrCreate();

            res.json({
                success: true,
                message: 'Configuración del extra-info worker obtenida',
                data: config
            });
        } catch (error) {
            logger.error(`Error obteniendo configuración extra-info: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener resumen de estadísticas
     * GET /api/extra-info-config/stats
     */
    async getStats(req, res) {
        try {
            const summary = await ConfiguracionExtraInfo.getStatsSummary();

            if (!summary) {
                return res.json({
                    success: true,
                    message: 'Worker no inicializado',
                    data: null
                });
            }

            res.json({
                success: true,
                message: 'Estadísticas del extra-info worker',
                data: summary
            });
        } catch (error) {
            logger.error(`Error obteniendo estadísticas: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener estado actual del worker
     * GET /api/extra-info-config/status
     */
    async getStatus(req, res) {
        try {
            const config = await ConfiguracionExtraInfo.findOne({ worker_id: 'extra_info_main' })
                .select('state enabled syncContactsEnabled processing_mode batch_size schedule updatedAt')
                .lean();

            if (!config) {
                return res.json({
                    success: true,
                    message: 'Worker no inicializado',
                    data: {
                        initialized: false,
                        isRunning: false
                    }
                });
            }

            // Verificar si está dentro del horario de trabajo
            const isWithinHours = await ConfiguracionExtraInfo.isWithinWorkingHours();

            // Calcular tiempo desde última actualización
            const lastUpdateMs = config.updatedAt ? new Date() - new Date(config.updatedAt) : null;
            const isStale = lastUpdateMs ? lastUpdateMs > 60 * 60 * 1000 : true; // >1 hora = stale

            res.json({
                success: true,
                message: 'Estado actual del extra-info worker',
                data: {
                    initialized: true,
                    enabled: config.enabled,
                    syncContactsEnabled: config.syncContactsEnabled,
                    processingMode: config.processing_mode,
                    batchSize: config.batch_size,
                    isRunning: config.state?.isRunning || false,
                    isWithinWorkingHours: isWithinHours,
                    lastCycleAt: config.state?.lastCycleAt,
                    cycleCount: config.state?.cycleCount || 0,
                    lastError: config.state?.lastError,
                    schedule: config.schedule,
                    lastUpdate: config.updatedAt,
                    lastUpdateAgo: lastUpdateMs ? `${Math.round(lastUpdateMs / 1000)}s` : null,
                    isStale
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo estado: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Actualizar configuración del worker
     * PATCH /api/extra-info-config
     */
    async updateConfig(req, res) {
        try {
            const allowedFields = [
                'enabled',
                'syncContactsEnabled',
                'processing_mode',
                'batch_size',
                'documentDelay'
            ];

            const allowedScheduleFields = [
                'cronExpression',
                'workStartHour',
                'workEndHour',
                'workDays',
                'timezone',
                'respectWorkingHours'
            ];

            const allowedEligibilityFields = [
                'requireVerified',
                'requireValid',
                'excludePrivate',
                'requireLastUpdate'
            ];

            // Construir objeto de actualización
            const updates = {};

            // Campos de nivel superior
            for (const field of allowedFields) {
                if (req.body[field] !== undefined) {
                    updates[field] = req.body[field];
                }
            }

            // Campos de schedule
            if (req.body.schedule) {
                for (const field of allowedScheduleFields) {
                    if (req.body.schedule[field] !== undefined) {
                        updates[`schedule.${field}`] = req.body.schedule[field];
                    }
                }
            }

            // Campos de eligibility
            if (req.body.eligibility) {
                for (const field of allowedEligibilityFields) {
                    if (req.body.eligibility[field] !== undefined) {
                        updates[`eligibility.${field}`] = req.body.eligibility[field];
                    }
                }

                // testMode anidado
                if (req.body.eligibility.testMode) {
                    if (req.body.eligibility.testMode.enabled !== undefined) {
                        updates['eligibility.testMode.enabled'] = req.body.eligibility.testMode.enabled;
                    }
                    if (req.body.eligibility.testMode.testUserIds !== undefined) {
                        updates['eligibility.testMode.testUserIds'] = req.body.eligibility.testMode.testUserIds;
                    }
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No se proporcionaron campos válidos para actualizar'
                });
            }

            // Validaciones
            if (updates.batch_size !== undefined && (updates.batch_size < 1 || updates.batch_size > 20)) {
                return res.status(400).json({
                    success: false,
                    message: 'batch_size debe estar entre 1 y 20'
                });
            }

            if (updates['schedule.workStartHour'] !== undefined) {
                const hour = updates['schedule.workStartHour'];
                if (hour < 0 || hour > 23) {
                    return res.status(400).json({
                        success: false,
                        message: 'workStartHour debe estar entre 0 y 23'
                    });
                }
            }

            if (updates['schedule.workEndHour'] !== undefined) {
                const hour = updates['schedule.workEndHour'];
                if (hour < 0 || hour > 24) {
                    return res.status(400).json({
                        success: false,
                        message: 'workEndHour debe estar entre 0 y 24'
                    });
                }
            }

            if (updates['schedule.workDays'] !== undefined) {
                const days = updates['schedule.workDays'];
                if (!Array.isArray(days) || !days.every(d => d >= 0 && d <= 6)) {
                    return res.status(400).json({
                        success: false,
                        message: 'workDays debe ser un array de números entre 0 (Domingo) y 6 (Sábado)'
                    });
                }
            }

            const result = await ConfiguracionExtraInfo.updateConfig(updates);

            logger.info(`Configuración extra-info actualizada: ${JSON.stringify(updates)}`);

            res.json({
                success: true,
                message: 'Configuración actualizada exitosamente',
                updatedFields: Object.keys(updates),
                data: result
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
     * Habilitar/deshabilitar worker
     * POST /api/extra-info-config/toggle
     */
    async toggleEnabled(req, res) {
        try {
            const config = await ConfiguracionExtraInfo.findOne({ worker_id: 'extra_info_main' });

            if (!config) {
                return res.status(404).json({
                    success: false,
                    message: 'Configuración no encontrada'
                });
            }

            const newEnabled = !config.enabled;
            await ConfiguracionExtraInfo.updateConfig({ enabled: newEnabled });

            logger.info(`Extra-info worker ${newEnabled ? 'habilitado' : 'deshabilitado'}`);

            res.json({
                success: true,
                message: `Worker ${newEnabled ? 'habilitado' : 'deshabilitado'}`,
                data: { enabled: newEnabled }
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
     * Resetear estadísticas
     * POST /api/extra-info-config/reset-stats
     */
    async resetStats(req, res) {
        try {
            await ConfiguracionExtraInfo.resetStats();

            logger.info('Estadísticas del extra-info worker reseteadas');

            res.json({
                success: true,
                message: 'Estadísticas reseteadas exitosamente'
            });
        } catch (error) {
            logger.error(`Error reseteando estadísticas: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener usuarios con sincronización habilitada
     * GET /api/extra-info-config/users-with-sync
     */
    async getUsersWithSyncEnabled(req, res) {
        try {
            const db = mongoose.connection.db;

            // Buscar usuarios que tienen la preferencia habilitada
            const users = await db.collection('usuarios').find(
                { 'preferences.pjn.syncContactsFromIntervinientes': true },
                {
                    projection: {
                        email: 1,
                        name: 1,
                        'preferences.pjn': 1,
                        createdAt: 1
                    }
                }
            ).toArray();

            // Contar total de usuarios
            const totalUsers = await db.collection('usuarios').countDocuments({});

            res.json({
                success: true,
                message: `${users.length} usuarios con sincronización habilitada`,
                data: {
                    totalUsers,
                    usersWithSyncEnabled: users.length,
                    percentage: totalUsers > 0 ? ((users.length / totalUsers) * 100).toFixed(1) : 0,
                    users: users.map(u => ({
                        _id: u._id,
                        email: u.email,
                        name: u.name,
                        syncEnabled: u.preferences?.pjn?.syncContactsFromIntervinientes || false
                    }))
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo usuarios: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener todos los usuarios con su estado de sincronización
     * GET /api/extra-info-config/users
     * Query params: page, limit, search, filterSync (all|enabled|disabled)
     */
    async getAllUsers(req, res) {
        try {
            const db = mongoose.connection.db;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const skip = (page - 1) * limit;
            const search = req.query.search || '';
            const filterSync = req.query.filterSync || 'all';

            // Construir query de búsqueda
            const query = {};

            if (search) {
                query.$or = [
                    { email: { $regex: search, $options: 'i' } },
                    { name: { $regex: search, $options: 'i' } }
                ];
            }

            if (filterSync === 'enabled') {
                query['preferences.pjn.syncContactsFromIntervinientes'] = true;
            } else if (filterSync === 'disabled') {
                query.$or = query.$or || [];
                query['preferences.pjn.syncContactsFromIntervinientes'] = { $ne: true };
            }

            // Contar total
            const totalUsers = await db.collection('usuarios').countDocuments(query);
            const totalPages = Math.ceil(totalUsers / limit);

            // Obtener usuarios paginados
            const users = await db.collection('usuarios').find(
                query,
                {
                    projection: {
                        email: 1,
                        name: 1,
                        'preferences.pjn': 1,
                        createdAt: 1
                    }
                }
            )
            .sort({ email: 1 })
            .skip(skip)
            .limit(limit)
            .toArray();

            // Contar usuarios con sync habilitado (del total sin paginación)
            const usersWithSyncEnabled = await db.collection('usuarios').countDocuments({
                'preferences.pjn.syncContactsFromIntervinientes': true
            });

            res.json({
                success: true,
                message: `${users.length} usuarios obtenidos`,
                data: {
                    users: users.map(u => ({
                        _id: u._id,
                        email: u.email,
                        name: u.name,
                        syncEnabled: u.preferences?.pjn?.syncContactsFromIntervinientes === true,
                        createdAt: u.createdAt
                    })),
                    pagination: {
                        page,
                        limit,
                        totalUsers,
                        totalPages,
                        hasMore: page < totalPages
                    },
                    summary: {
                        totalUsersInSystem: await db.collection('usuarios').countDocuments({}),
                        usersWithSyncEnabled,
                        usersWithSyncDisabled: await db.collection('usuarios').countDocuments({}) - usersWithSyncEnabled
                    }
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo usuarios: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Actualizar preferencia de sincronización de un usuario
     * PATCH /api/extra-info-config/users/:userId/sync
     */
    async updateUserSyncPreference(req, res) {
        try {
            const { userId } = req.params;
            const { syncEnabled } = req.body;

            if (typeof syncEnabled !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'syncEnabled debe ser un booleano'
                });
            }

            // Validar ObjectId
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(400).json({
                    success: false,
                    message: 'userId inválido'
                });
            }

            const db = mongoose.connection.db;

            const result = await db.collection('usuarios').updateOne(
                { _id: new mongoose.Types.ObjectId(userId) },
                {
                    $set: {
                        'preferences.pjn.syncContactsFromIntervinientes': syncEnabled,
                        updatedAt: new Date()
                    }
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            // Obtener datos actualizados del usuario
            const user = await db.collection('usuarios').findOne(
                { _id: new mongoose.Types.ObjectId(userId) },
                { projection: { email: 1, name: 1, 'preferences.pjn': 1 } }
            );

            logger.info(`Preferencia de sincronización actualizada para usuario ${userId}: ${syncEnabled}`);

            res.json({
                success: true,
                message: `Sincronización ${syncEnabled ? 'habilitada' : 'deshabilitada'} para el usuario`,
                data: {
                    _id: user._id,
                    email: user.email,
                    name: user.name,
                    syncEnabled: user.preferences?.pjn?.syncContactsFromIntervinientes === true
                }
            });
        } catch (error) {
            logger.error(`Error actualizando preferencia de usuario: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Actualizar preferencia de sincronización para múltiples usuarios
     * PATCH /api/extra-info-config/users/bulk-sync
     */
    async bulkUpdateUserSyncPreference(req, res) {
        try {
            const { userIds, syncEnabled } = req.body;

            if (!Array.isArray(userIds) || userIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'userIds debe ser un array no vacío'
                });
            }

            if (typeof syncEnabled !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'syncEnabled debe ser un booleano'
                });
            }

            // Validar ObjectIds
            const validIds = userIds.filter(id => mongoose.Types.ObjectId.isValid(id));
            if (validIds.length !== userIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Algunos userIds son inválidos'
                });
            }

            const db = mongoose.connection.db;

            const result = await db.collection('usuarios').updateMany(
                { _id: { $in: validIds.map(id => new mongoose.Types.ObjectId(id)) } },
                {
                    $set: {
                        'preferences.pjn.syncContactsFromIntervinientes': syncEnabled,
                        updatedAt: new Date()
                    }
                }
            );

            logger.info(`Preferencia de sincronización actualizada en lote: ${result.modifiedCount} usuarios -> ${syncEnabled}`);

            res.json({
                success: true,
                message: `Sincronización ${syncEnabled ? 'habilitada' : 'deshabilitada'} para ${result.modifiedCount} usuarios`,
                data: {
                    matched: result.matchedCount,
                    modified: result.modifiedCount
                }
            });
        } catch (error) {
            logger.error(`Error en actualización masiva: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener documentos elegibles para procesamiento
     * GET /api/extra-info-config/eligible-count
     */
    async getEligibleCount(req, res) {
        try {
            const config = await ConfiguracionExtraInfo.findOne({ worker_id: 'extra_info_main' }).lean();
            const db = mongoose.connection.db;

            const collections = ['causas-civil', 'causas-comercial', 'causas-segsocial', 'causas-trabajo'];
            const counts = {};
            let totalEligible = 0;

            // Obtener IDs de causas de usuarios de prueba si está en modo test
            let testUserCausaIds = [];
            if (config?.eligibility?.testMode?.enabled) {
                const testUserIds = config.eligibility.testMode.testUserIds || [];
                const folders = await db.collection('folders').find({
                    userId: { $in: testUserIds.map(id => new mongoose.Types.ObjectId(id)) },
                    causaId: { $exists: true, $ne: null }
                }).toArray();
                testUserCausaIds = folders.map(f => f.causaId);
            }

            // Construir query de elegibilidad
            const buildQuery = () => {
                const query = {
                    verified: true,
                    isValid: true,
                    isPrivate: { $ne: true },
                    lastUpdate: { $exists: true },
                    $or: [
                        { detailsLoaded: { $exists: false } },
                        { detailsLoaded: false },
                        { detailsLoaded: null }
                    ]
                };

                if (config?.eligibility?.testMode?.enabled && testUserCausaIds.length > 0) {
                    query._id = { $in: testUserCausaIds };
                }

                return query;
            };

            const query = buildQuery();

            for (const collection of collections) {
                const count = await db.collection(collection).countDocuments(query);
                const fueroName = collection.replace('causas-', '');
                counts[fueroName] = count;
                totalEligible += count;
            }

            // Actualizar el progreso en la configuración
            await ConfiguracionExtraInfo.updateConfig({
                'processingProgress.totalEligible': totalEligible,
                'processingProgress.lastEligibleCalculation': new Date()
            });

            res.json({
                success: true,
                message: 'Conteo de documentos elegibles',
                data: {
                    total: totalEligible,
                    byFuero: counts,
                    testMode: config?.eligibility?.testMode?.enabled || false,
                    testUserCausasCount: testUserCausaIds.length,
                    calculatedAt: new Date()
                }
            });
        } catch (error) {
            logger.error(`Error contando documentos elegibles: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener estadísticas de intervinientes extraídos
     * GET /api/extra-info-config/intervinientes-stats
     */
    async getIntervinientesStats(req, res) {
        try {
            const db = mongoose.connection.db;

            // Contar intervinientes por tipo
            const pipeline = [
                {
                    $group: {
                        _id: '$tipoInterviniente',
                        count: { $sum: 1 }
                    }
                }
            ];

            const byTipo = await db.collection('intervinientes').aggregate(pipeline).toArray();

            // Contar total
            const totalIntervinientes = await db.collection('intervinientes').countDocuments({});

            // Contar documentos con detailsLoaded = true
            const collections = ['causas-civil', 'causas-comercial', 'causas-segsocial', 'causas-trabajo'];
            let totalProcessed = 0;
            const processedByFuero = {};

            for (const collection of collections) {
                const count = await db.collection(collection).countDocuments({ detailsLoaded: true });
                const fueroName = collection.replace('causas-', '');
                processedByFuero[fueroName] = count;
                totalProcessed += count;
            }

            res.json({
                success: true,
                message: 'Estadísticas de intervinientes',
                data: {
                    totalIntervinientes,
                    byTipo: byTipo.reduce((acc, item) => {
                        acc[item._id || 'unknown'] = item.count;
                        return acc;
                    }, {}),
                    documentsProcessed: {
                        total: totalProcessed,
                        byFuero: processedByFuero
                    }
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo estadísticas de intervinientes: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    }
};

module.exports = extraInfoConfigController;
