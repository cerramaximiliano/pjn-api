/**
 * Controller para Worker Daily Stats
 * Endpoints para consultar estadísticas de los workers
 */
const { WorkerDailyStats } = require('pjn-models');
const { logger } = require('../config/pino');

const workerStatsController = {
    /**
     * Obtener fechas disponibles con estadísticas
     * GET /api/workers/stats/available-dates
     */
    async getAvailableDates(req, res) {
        try {
            const { workerType } = req.query;

            const matchStage = {};
            if (workerType) {
                matchStage.workerType = workerType;
            }

            const pipeline = [
                ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
                {
                    $group: {
                        _id: '$date',
                        fuerosCount: { $addToSet: '$fuero' },
                        totalProcessed: { $sum: '$stats.processed' },
                        totalSuccessful: { $sum: '$stats.successful' },
                        totalFailed: { $sum: '$stats.failed' }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        date: '$_id',
                        fuerosCount: { $size: '$fuerosCount' },
                        totalProcessed: 1,
                        totalSuccessful: 1,
                        totalFailed: 1,
                        hasData: { $gt: ['$totalProcessed', 0] }
                    }
                },
                { $sort: { date: -1 } },
                { $limit: 90 } // Últimos 90 días
            ];

            const dates = await WorkerDailyStats.aggregate(pipeline);

            res.json({
                success: true,
                message: `${dates.length} fechas con datos disponibles`,
                count: dates.length,
                data: dates
            });
        } catch (error) {
            logger.error(`Error obteniendo fechas disponibles: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener resumen del día actual
     * GET /api/workers/stats/today
     */
    async getTodaySummary(req, res) {
        try {
            const { workerType } = req.query;
            const today = new Date().toISOString().split('T')[0];

            const query = { date: today };
            if (workerType) {
                query.workerType = workerType;
            }

            const stats = await WorkerDailyStats.find(query)
                .sort({ fuero: 1 })
                .lean();

            // Calcular totales
            const totals = {
                totalToProcess: 0,
                processed: 0,
                successful: 0,
                failed: 0,
                skipped: 0,
                movimientosFound: 0,
                privateCausas: 0,
                publicCausas: 0,
                captchaAttempts: 0,
                captchaSuccessful: 0,
                captchaFailed: 0
            };

            const byFuero = {};

            for (const stat of stats) {
                const fuero = stat.fuero;
                if (!byFuero[fuero]) {
                    byFuero[fuero] = {
                        fuero,
                        status: stat.status,
                        stats: { ...stat.stats },
                        runsCount: stat.runs?.length || 0,
                        errorsCount: stat.errors?.length || 0,
                        alerts: stat.alerts?.filter(a => !a.acknowledged) || [],
                        lastUpdate: stat.lastUpdate
                    };
                }

                // Acumular totales
                if (stat.stats) {
                    Object.keys(totals).forEach(key => {
                        if (stat.stats[key]) {
                            totals[key] += stat.stats[key];
                        }
                    });
                }
            }

            // Calcular porcentajes
            const successRate = totals.processed > 0
                ? ((totals.successful / totals.processed) * 100).toFixed(1)
                : 0;

            const captchaSuccessRate = totals.captchaAttempts > 0
                ? ((totals.captchaSuccessful / totals.captchaAttempts) * 100).toFixed(1)
                : 0;

            res.json({
                success: true,
                message: `Estadísticas del día ${today}`,
                date: today,
                totals: {
                    ...totals,
                    successRate: `${successRate}%`,
                    captchaSuccessRate: `${captchaSuccessRate}%`
                },
                byFuero: Object.values(byFuero),
                fueroCount: Object.keys(byFuero).length
            });
        } catch (error) {
            logger.error(`Error obteniendo resumen de hoy: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener estadísticas de un día específico
     * GET /api/workers/stats/:date
     */
    async getByDate(req, res) {
        try {
            const { date } = req.params;
            const { workerType, fuero } = req.query;

            // Validar formato de fecha
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: 'Formato de fecha inválido. Use YYYY-MM-DD'
                });
            }

            const query = { date };
            if (workerType) query.workerType = workerType;
            if (fuero) query.fuero = fuero.toUpperCase();

            const stats = await WorkerDailyStats.find(query)
                .sort({ fuero: 1 })
                .lean();

            res.json({
                success: true,
                message: `Estadísticas del ${date}`,
                date,
                count: stats.length,
                data: stats
            });
        } catch (error) {
            logger.error(`Error obteniendo stats por fecha: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener estadísticas por rango de fechas
     * GET /api/workers/stats/range?from=YYYY-MM-DD&to=YYYY-MM-DD
     */
    async getByDateRange(req, res) {
        try {
            const { from, to, workerType, fuero } = req.query;

            if (!from || !to) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros from y to son requeridos'
                });
            }

            // Validar formato de fechas
            if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
                return res.status(400).json({
                    success: false,
                    message: 'Formato de fecha inválido. Use YYYY-MM-DD'
                });
            }

            const query = {
                date: { $gte: from, $lte: to }
            };
            if (workerType) query.workerType = workerType;
            if (fuero) query.fuero = fuero.toUpperCase();

            const stats = await WorkerDailyStats.find(query)
                .sort({ date: -1, fuero: 1 })
                .lean();

            // Agrupar por fecha para resumen
            const byDate = {};
            for (const stat of stats) {
                if (!byDate[stat.date]) {
                    byDate[stat.date] = {
                        date: stat.date,
                        totalProcessed: 0,
                        totalSuccessful: 0,
                        totalFailed: 0,
                        totalMovimientos: 0,
                        fueros: []
                    };
                }
                byDate[stat.date].totalProcessed += stat.stats?.processed || 0;
                byDate[stat.date].totalSuccessful += stat.stats?.successful || 0;
                byDate[stat.date].totalFailed += stat.stats?.failed || 0;
                byDate[stat.date].totalMovimientos += stat.stats?.movimientosFound || 0;
                byDate[stat.date].fueros.push(stat.fuero);
            }

            res.json({
                success: true,
                message: `Estadísticas del ${from} al ${to}`,
                from,
                to,
                daysCount: Object.keys(byDate).length,
                summary: Object.values(byDate),
                data: stats
            });
        } catch (error) {
            logger.error(`Error obteniendo stats por rango: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener estado actual de un fuero específico
     * GET /api/workers/fuero/:fuero/status
     */
    async getFueroStatus(req, res) {
        try {
            const { fuero } = req.params;
            const { workerType } = req.query;
            const today = new Date().toISOString().split('T')[0];

            const query = {
                date: today,
                fuero: fuero.toUpperCase()
            };
            if (workerType) query.workerType = workerType;

            const stats = await WorkerDailyStats.find(query).lean();

            if (stats.length === 0) {
                return res.json({
                    success: true,
                    message: `No hay estadísticas para el fuero ${fuero} hoy`,
                    fuero: fuero.toUpperCase(),
                    date: today,
                    status: 'no_data',
                    data: null
                });
            }

            // Si hay múltiples workers para el mismo fuero, combinar
            const combined = {
                fuero: fuero.toUpperCase(),
                date: today,
                status: stats[0].status,
                stats: {
                    totalToProcess: 0,
                    processed: 0,
                    successful: 0,
                    failed: 0,
                    movimientosFound: 0,
                    privateCausas: 0,
                    publicCausas: 0
                },
                runs: [],
                recentErrors: [],
                alerts: [],
                lastUpdate: null
            };

            for (const stat of stats) {
                Object.keys(combined.stats).forEach(key => {
                    if (stat.stats?.[key]) {
                        combined.stats[key] += stat.stats[key];
                    }
                });

                if (stat.runs) combined.runs.push(...stat.runs);
                if (stat.errors) combined.recentErrors.push(...stat.errors.slice(-10));
                if (stat.alerts) combined.alerts.push(...stat.alerts.filter(a => !a.acknowledged));

                if (!combined.lastUpdate || stat.lastUpdate > combined.lastUpdate) {
                    combined.lastUpdate = stat.lastUpdate;
                }
            }

            // Determinar estado de salud
            const errorRate = combined.stats.processed > 0
                ? combined.stats.failed / combined.stats.processed
                : 0;

            let health = 'healthy';
            if (errorRate > 0.2) health = 'critical';
            else if (errorRate > 0.1) health = 'warning';
            else if (combined.stats.processed === 0) health = 'idle';

            combined.health = health;
            combined.errorRate = `${(errorRate * 100).toFixed(1)}%`;

            res.json({
                success: true,
                message: `Estado del fuero ${fuero}`,
                data: combined
            });
        } catch (error) {
            logger.error(`Error obteniendo estado de fuero: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener alertas activas
     * GET /api/workers/alerts
     */
    async getActiveAlerts(req, res) {
        try {
            const today = new Date().toISOString().split('T')[0];

            const statsWithAlerts = await WorkerDailyStats.find({
                date: today,
                'alerts.0': { $exists: true }
            }).select('date fuero workerType alerts status').lean();

            const alerts = [];
            for (const stat of statsWithAlerts) {
                const unacknowledged = stat.alerts.filter(a => !a.acknowledged);
                for (const alert of unacknowledged) {
                    alerts.push({
                        fuero: stat.fuero,
                        workerType: stat.workerType,
                        type: alert.type,
                        message: alert.message,
                        createdAt: alert.createdAt,
                        status: stat.status
                    });
                }
            }

            // Ordenar por fecha de creación descendente
            alerts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            res.json({
                success: true,
                message: `${alerts.length} alertas activas`,
                count: alerts.length,
                data: alerts
            });
        } catch (error) {
            logger.error(`Error obteniendo alertas: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Reconocer (acknowledge) una alerta
     * POST /api/workers/alerts/:fuero/:alertType/acknowledge
     */
    async acknowledgeAlert(req, res) {
        try {
            const { fuero, alertType } = req.params;
            const { workerType } = req.query;
            const today = new Date().toISOString().split('T')[0];

            const query = {
                date: today,
                fuero: fuero.toUpperCase(),
                'alerts.type': alertType,
                'alerts.acknowledged': false
            };
            if (workerType) query.workerType = workerType;

            const result = await WorkerDailyStats.updateMany(
                query,
                {
                    $set: { 'alerts.$[elem].acknowledged': true }
                },
                {
                    arrayFilters: [{ 'elem.type': alertType, 'elem.acknowledged': false }]
                }
            );

            res.json({
                success: true,
                message: `Alertas reconocidas`,
                modifiedCount: result.modifiedCount
            });
        } catch (error) {
            logger.error(`Error reconociendo alerta: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener errores recientes de un fuero
     * GET /api/workers/fuero/:fuero/errors
     */
    async getFueroErrors(req, res) {
        try {
            const { fuero } = req.params;
            const { workerType, limit = 50 } = req.query;
            const today = new Date().toISOString().split('T')[0];

            const query = {
                date: today,
                fuero: fuero.toUpperCase(),
                'errors.0': { $exists: true }
            };
            if (workerType) query.workerType = workerType;

            const stats = await WorkerDailyStats.find(query)
                .select('errors workerType')
                .lean();

            let allErrors = [];
            for (const stat of stats) {
                const errorsWithWorker = stat.errors.map(e => ({
                    ...e,
                    workerType: stat.workerType
                }));
                allErrors.push(...errorsWithWorker);
            }

            // Ordenar por timestamp descendente y limitar
            allErrors.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            allErrors = allErrors.slice(0, parseInt(limit));

            // Agrupar por tipo de error
            const byType = {};
            for (const error of allErrors) {
                const type = error.errorType || 'unknown';
                if (!byType[type]) byType[type] = 0;
                byType[type]++;
            }

            res.json({
                success: true,
                message: `Errores del fuero ${fuero}`,
                fuero: fuero.toUpperCase(),
                date: today,
                totalErrors: allErrors.length,
                byType,
                data: allErrors
            });
        } catch (error) {
            logger.error(`Error obteniendo errores de fuero: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    }
};

module.exports = workerStatsController;
