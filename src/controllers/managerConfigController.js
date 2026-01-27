/**
 * Controller para Manager Config
 * Endpoints para gestionar la configuración del App Update Manager
 */
const { ManagerConfig } = require('pjn-models');
const { logger } = require('../config/pino');

const managerConfigController = {
    /**
     * Obtener configuración completa del manager
     * GET /api/manager-config
     */
    async getConfig(req, res) {
        try {
            const config = await ManagerConfig.getOrCreate();

            res.json({
                success: true,
                message: 'Configuración del manager obtenida',
                data: config
            });
        } catch (error) {
            logger.error(`Error obteniendo configuración del manager: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener solo los valores de configuración (sin estado ni historial)
     * GET /api/manager-config/settings
     */
    async getSettings(req, res) {
        try {
            const config = await ManagerConfig.getConfig();

            if (!config) {
                return res.status(404).json({
                    success: false,
                    message: 'Configuración no encontrada'
                });
            }

            res.json({
                success: true,
                message: 'Configuración obtenida',
                data: config
            });
        } catch (error) {
            logger.error(`Error obteniendo settings: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Actualizar valores de configuración
     * PATCH /api/manager-config/settings
     */
    async updateSettings(req, res) {
        try {
            const allowedFields = [
                'checkInterval',
                'maxWorkers',
                'minWorkers',
                'scaleThreshold',
                'scaleDownThreshold',
                'updateThresholdHours',
                'cpuThreshold',
                'memoryThreshold',
                'workStartHour',
                'workEndHour',
                'workDays',
                'workerNames'
            ];

            // Filtrar solo campos permitidos
            const updates = {};
            for (const field of allowedFields) {
                if (req.body[field] !== undefined) {
                    updates[field] = req.body[field];
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No se proporcionaron campos válidos para actualizar',
                    allowedFields
                });
            }

            // Validaciones
            if (updates.maxWorkers !== undefined && (updates.maxWorkers < 0 || updates.maxWorkers > 20)) {
                return res.status(400).json({
                    success: false,
                    message: 'maxWorkers debe estar entre 0 y 20'
                });
            }

            if (updates.minWorkers !== undefined && updates.minWorkers < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'minWorkers no puede ser negativo'
                });
            }

            if (updates.checkInterval !== undefined && updates.checkInterval < 10000) {
                return res.status(400).json({
                    success: false,
                    message: 'checkInterval debe ser al menos 10000ms (10 segundos)'
                });
            }

            if (updates.workStartHour !== undefined && (updates.workStartHour < 0 || updates.workStartHour > 23)) {
                return res.status(400).json({
                    success: false,
                    message: 'workStartHour debe estar entre 0 y 23'
                });
            }

            if (updates.workEndHour !== undefined && (updates.workEndHour < 0 || updates.workEndHour > 24)) {
                return res.status(400).json({
                    success: false,
                    message: 'workEndHour debe estar entre 0 y 24'
                });
            }

            const result = await ManagerConfig.updateConfig(updates);

            logger.info(`Configuración del manager actualizada: ${JSON.stringify(updates)}`);

            res.json({
                success: true,
                message: 'Configuración actualizada exitosamente',
                updatedFields: Object.keys(updates),
                data: result.config
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
     * Obtener estado actual del manager
     * GET /api/manager-config/status
     */
    async getCurrentStatus(req, res) {
        try {
            const config = await ManagerConfig.findOne({ name: 'app-update-manager' })
                .select('currentState lastUpdate')
                .lean();

            if (!config) {
                return res.json({
                    success: true,
                    message: 'Manager no inicializado',
                    data: {
                        isRunning: false,
                        initialized: false
                    }
                });
            }

            // Calcular tiempo desde última actualización
            const lastUpdateMs = config.lastUpdate ? new Date() - new Date(config.lastUpdate) : null;
            const isStale = lastUpdateMs ? lastUpdateMs > 5 * 60 * 1000 : true; // >5 min = stale

            res.json({
                success: true,
                message: 'Estado actual del manager',
                data: {
                    ...config.currentState,
                    lastUpdate: config.lastUpdate,
                    lastUpdateAgo: lastUpdateMs ? `${Math.round(lastUpdateMs / 1000)}s` : null,
                    isStale,
                    totalWorkers: config.currentState?.workers
                        ? Object.values(config.currentState.workers).reduce((a, b) => a + b, 0)
                        : 0,
                    totalPending: config.currentState?.pending
                        ? Object.values(config.currentState.pending).reduce((a, b) => a + b, 0)
                        : 0
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo estado del manager: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener historial de snapshots
     * GET /api/manager-config/history
     */
    async getHistory(req, res) {
        try {
            const { hours = 24 } = req.query;
            const hoursBack = Math.min(parseInt(hours), 72); // Máximo 72 horas

            const history = await ManagerConfig.getHistory(hoursBack);

            // Calcular estadísticas del historial
            let stats = {
                avgWorkers: 0,
                avgPending: 0,
                avgCpu: 0,
                avgMemory: 0,
                maxWorkers: 0,
                maxPending: 0,
                snapshotCount: history.length
            };

            if (history.length > 0) {
                for (const snapshot of history) {
                    const totalWorkers = snapshot.workers
                        ? Object.values(snapshot.workers).reduce((a, b) => a + b, 0)
                        : 0;
                    const totalPending = snapshot.pending
                        ? Object.values(snapshot.pending).reduce((a, b) => a + b, 0)
                        : 0;

                    stats.avgWorkers += totalWorkers;
                    stats.avgPending += totalPending;
                    stats.avgCpu += snapshot.systemResources?.cpuUsage || 0;
                    stats.avgMemory += snapshot.systemResources?.memoryUsage || 0;
                    stats.maxWorkers = Math.max(stats.maxWorkers, totalWorkers);
                    stats.maxPending = Math.max(stats.maxPending, totalPending);
                }

                stats.avgWorkers = (stats.avgWorkers / history.length).toFixed(1);
                stats.avgPending = Math.round(stats.avgPending / history.length);
                stats.avgCpu = ((stats.avgCpu / history.length) * 100).toFixed(1) + '%';
                stats.avgMemory = ((stats.avgMemory / history.length) * 100).toFixed(1) + '%';
            }

            res.json({
                success: true,
                message: `Historial de las últimas ${hoursBack} horas`,
                hoursBack,
                stats,
                data: history
            });
        } catch (error) {
            logger.error(`Error obteniendo historial: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    },

    /**
     * Obtener alertas activas del manager
     * GET /api/manager-config/alerts
     */
    async getAlerts(req, res) {
        try {
            const alerts = await ManagerConfig.getActiveAlerts();

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
     * Reconocer una alerta
     * POST /api/manager-config/alerts/:index/acknowledge
     */
    async acknowledgeAlert(req, res) {
        try {
            const { index } = req.params;
            const alertIndex = parseInt(index);

            const config = await ManagerConfig.findOne({ name: 'app-update-manager' });

            if (!config || !config.alerts || !config.alerts[alertIndex]) {
                return res.status(404).json({
                    success: false,
                    message: 'Alerta no encontrada'
                });
            }

            config.alerts[alertIndex].acknowledged = true;
            config.lastUpdate = new Date();
            await config.save();

            res.json({
                success: true,
                message: 'Alerta reconocida'
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
     * Resetear configuración a valores por defecto
     * POST /api/manager-config/reset
     */
    async resetToDefaults(req, res) {
        try {
            const defaults = {
                checkInterval: 60000,
                maxWorkers: 3,
                minWorkers: 0,
                scaleThreshold: 500,
                scaleDownThreshold: 50,
                updateThresholdHours: 12,
                cpuThreshold: 0.75,
                memoryThreshold: 0.80,
                workStartHour: 8,
                workEndHour: 22,
                workDays: [1, 2, 3, 4, 5],
                workerNames: {
                    civil: 'pjn-app-update-civil',
                    ss: 'pjn-app-update-ss',
                    trabajo: 'pjn-app-update-trabajo',
                    comercial: 'pjn-app-update-comercial'
                }
            };

            const result = await ManagerConfig.updateConfig(defaults);

            logger.info('Configuración del manager reseteada a valores por defecto');

            res.json({
                success: true,
                message: 'Configuración reseteada a valores por defecto',
                data: result.config
            });
        } catch (error) {
            logger.error(`Error reseteando configuración: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message
            });
        }
    }
};

module.exports = managerConfigController;
