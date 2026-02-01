/**
 * Controller para Worker Hourly Stats y Daily Summary
 * Endpoints para consultar estadísticas horarias y resúmenes diarios
 */
const { WorkerHourlyStats, WorkerDailySummary } = require('pjn-models');
const { logger } = require('../config/pino');

const workerStatsExtendedController = {
    // ==================== HOURLY STATS ====================

    /**
     * Obtener estadísticas de las últimas N horas
     * GET /api/workers/hourly/last/:hours
     */
    async getLastNHours(req, res) {
        try {
            const hours = parseInt(req.params.hours) || 24;
            const { fuero, workerType } = req.query;

            const maxHours = Math.min(hours, 168); // Máximo 7 días
            const data = await WorkerHourlyStats.getLastNHours(maxHours, fuero || null, workerType || 'app-update');

            res.json({
                success: true,
                message: `Estadísticas de las últimas ${maxHours} horas`,
                count: data.length,
                data
            });
        } catch (error) {
            logger.error(`Error obteniendo stats horarias: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener resumen del día agrupado por hora
     * GET /api/workers/hourly/day/:date
     */
    async getDaySummaryByHour(req, res) {
        try {
            const { date } = req.params;
            const { fuero, workerType } = req.query;

            // Validar formato de fecha
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: 'Formato de fecha inválido. Use YYYY-MM-DD'
                });
            }

            const byHour = await WorkerHourlyStats.getDaySummary(date, fuero || null, workerType || 'app-update');

            // Calcular totales del día
            const totals = {
                processed: 0,
                successful: 0,
                failed: 0,
                movimientosFound: 0,
                activeHours: 0
            };

            for (const hour in byHour) {
                totals.processed += byHour[hour].processed;
                totals.successful += byHour[hour].successful;
                totals.failed += byHour[hour].failed;
                totals.movimientosFound += byHour[hour].movimientosFound;
                if (byHour[hour].processed > 0) totals.activeHours++;
            }

            res.json({
                success: true,
                message: `Estadísticas horarias para ${date}`,
                data: {
                    date,
                    totals,
                    byHour
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo resumen por hora: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener estadísticas de la hora actual
     * GET /api/workers/hourly/current
     */
    async getCurrentHourStats(req, res) {
        try {
            const { workerType } = req.query;
            const now = new Date();
            const date = now.toISOString().split('T')[0];
            const hour = now.getHours();

            const query = { date, hour };
            if (workerType) query.workerType = workerType;

            const stats = await WorkerHourlyStats.find(query).lean();

            // Agrupar por fuero
            const byFuero = {};
            const totals = {
                processed: 0,
                successful: 0,
                failed: 0,
                movimientosFound: 0,
                managerCycles: 0
            };

            for (const s of stats) {
                byFuero[s.fuero] = {
                    processed: s.stats.processed || 0,
                    successful: s.stats.successful || 0,
                    failed: s.stats.failed || 0,
                    movimientosFound: s.stats.movimientosFound || 0,
                    avgWorkers: s.stats.avgActiveWorkers || 0,
                    maxWorkers: s.stats.maxActiveWorkers || 0,
                    pendingAtEnd: s.stats.pendingAtEnd,
                    scalingEvents: s.scalingEvents?.length || 0
                };

                totals.processed += s.stats.processed || 0;
                totals.successful += s.stats.successful || 0;
                totals.failed += s.stats.failed || 0;
                totals.movimientosFound += s.stats.movimientosFound || 0;
                totals.managerCycles += s.managerCycles || 0;
            }

            res.json({
                success: true,
                message: `Estadísticas de la hora ${hour}:00`,
                data: {
                    date,
                    hour,
                    totals,
                    byFuero
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo stats de hora actual: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener eventos de escalado de las últimas horas
     * GET /api/workers/hourly/scaling-events
     */
    async getScalingEvents(req, res) {
        try {
            const { hours = 24, fuero, workerType } = req.query;
            const maxHours = Math.min(parseInt(hours), 168);

            const now = new Date();
            const events = [];

            for (let i = 0; i < maxHours; i++) {
                const time = new Date(now.getTime() - (i * 60 * 60 * 1000));
                const date = time.toISOString().split('T')[0];
                const hour = time.getHours();

                const query = { date, hour };
                if (fuero) query.fuero = fuero;
                if (workerType) query.workerType = workerType;

                const stats = await WorkerHourlyStats.find(query).lean();

                for (const s of stats) {
                    if (s.scalingEvents && s.scalingEvents.length > 0) {
                        for (const event of s.scalingEvents) {
                            events.push({
                                date,
                                hour,
                                fuero: s.fuero,
                                ...event
                            });
                        }
                    }
                }
            }

            // Ordenar por timestamp descendente
            events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            res.json({
                success: true,
                message: `${events.length} eventos de escalado en las últimas ${maxHours} horas`,
                count: events.length,
                data: events
            });
        } catch (error) {
            logger.error(`Error obteniendo eventos de escalado: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    // ==================== DAILY SUMMARY ====================

    /**
     * Obtener resumen del día actual
     * GET /api/workers/summary/today
     */
    async getTodaySummary(req, res) {
        try {
            const { workerType } = req.query;
            const today = new Date().toISOString().split('T')[0];

            // Intentar obtener el resumen existente o generarlo
            let summary = await WorkerDailySummary.findOne({
                date: today,
                workerType: workerType || 'app-update'
            }).lean();

            if (!summary) {
                // Generar si no existe
                summary = await WorkerDailySummary.generateSummary(today, workerType || 'app-update');
                summary = summary.toObject ? summary.toObject() : summary;
            }

            res.json({
                success: true,
                message: `Resumen del día ${today}`,
                data: summary
            });
        } catch (error) {
            logger.error(`Error obteniendo resumen diario: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener resumen de un día específico
     * GET /api/workers/summary/date/:date
     */
    async getSummaryByDate(req, res) {
        try {
            const { date } = req.params;
            const { workerType } = req.query;

            // Validar formato de fecha
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: 'Formato de fecha inválido. Use YYYY-MM-DD'
                });
            }

            let summary = await WorkerDailySummary.findOne({
                date,
                workerType: workerType || 'app-update'
            }).lean();

            if (!summary) {
                // Intentar generar si es una fecha pasada
                const requestedDate = new Date(date);
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                if (requestedDate < today) {
                    summary = await WorkerDailySummary.generateSummary(date, workerType || 'app-update');
                    summary = summary.toObject ? summary.toObject() : summary;
                } else {
                    return res.status(404).json({
                        success: false,
                        message: `No hay resumen disponible para ${date}`
                    });
                }
            }

            res.json({
                success: true,
                message: `Resumen del día ${date}`,
                data: summary
            });
        } catch (error) {
            logger.error(`Error obteniendo resumen por fecha: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener resúmenes de los últimos N días
     * GET /api/workers/summary/last/:days
     */
    async getLastNDays(req, res) {
        try {
            const days = parseInt(req.params.days) || 7;
            const { workerType } = req.query;

            const maxDays = Math.min(days, 90); // Máximo 90 días
            const summaries = await WorkerDailySummary.getLastNDays(maxDays, workerType || 'app-update');

            res.json({
                success: true,
                message: `Resúmenes de los últimos ${maxDays} días`,
                count: summaries.length,
                data: summaries
            });
        } catch (error) {
            logger.error(`Error obteniendo últimos días: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener datos para gráficos
     * GET /api/workers/summary/chart
     */
    async getChartData(req, res) {
        try {
            const { days = 30, workerType } = req.query;
            const maxDays = Math.min(parseInt(days), 90);

            const chartData = await WorkerDailySummary.getChartData(maxDays, workerType || 'app-update');

            res.json({
                success: true,
                message: `Datos para gráfico de ${chartData.length} días`,
                count: chartData.length,
                data: chartData
            });
        } catch (error) {
            logger.error(`Error obteniendo datos de gráfico: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Regenerar resumen de un día
     * POST /api/workers/summary/regenerate/:date
     */
    async regenerateSummary(req, res) {
        try {
            const { date } = req.params;
            const { workerType } = req.query;

            // Validar formato de fecha
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: 'Formato de fecha inválido. Use YYYY-MM-DD'
                });
            }

            const summary = await WorkerDailySummary.generateSummary(date, workerType || 'app-update');

            res.json({
                success: true,
                message: `Resumen regenerado para ${date}`,
                data: summary
            });
        } catch (error) {
            logger.error(`Error regenerando resumen: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Comparar dos días
     * GET /api/workers/summary/compare
     */
    async compareDays(req, res) {
        try {
            const { date1, date2, workerType } = req.query;

            if (!date1 || !date2) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requieren date1 y date2 en query params'
                });
            }

            // Validar formato de fechas
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date1) || !/^\d{4}-\d{2}-\d{2}$/.test(date2)) {
                return res.status(400).json({
                    success: false,
                    message: 'Formato de fecha inválido. Use YYYY-MM-DD'
                });
            }

            const [summary1, summary2] = await Promise.all([
                WorkerDailySummary.findOne({ date: date1, workerType: workerType || 'app-update' }).lean(),
                WorkerDailySummary.findOne({ date: date2, workerType: workerType || 'app-update' }).lean()
            ]);

            if (!summary1 || !summary2) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontraron datos para una o ambas fechas'
                });
            }

            // Calcular diferencias
            const comparison = {
                date1: {
                    date: date1,
                    totals: summary1.totals
                },
                date2: {
                    date: date2,
                    totals: summary2.totals
                },
                differences: {
                    processed: summary2.totals.processed - summary1.totals.processed,
                    successful: summary2.totals.successful - summary1.totals.successful,
                    failed: summary2.totals.failed - summary1.totals.failed,
                    movimientosFound: summary2.totals.movimientosFound - summary1.totals.movimientosFound,
                    successRate: summary2.totals.successRate - summary1.totals.successRate
                },
                percentageChanges: {
                    processed: summary1.totals.processed > 0
                        ? Math.round(((summary2.totals.processed - summary1.totals.processed) / summary1.totals.processed) * 100)
                        : 0,
                    movimientosFound: summary1.totals.movimientosFound > 0
                        ? Math.round(((summary2.totals.movimientosFound - summary1.totals.movimientosFound) / summary1.totals.movimientosFound) * 100)
                        : 0
                }
            };

            res.json({
                success: true,
                message: `Comparación entre ${date1} y ${date2}`,
                data: comparison
            });
        } catch (error) {
            logger.error(`Error comparando días: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    }
};

module.exports = workerStatsExtendedController;
