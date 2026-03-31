'use strict';

const ConfiguracionScrapingSaij = require('../models/ConfiguracionScrapingSaij');
const { logger } = require('../config/pino');

const saijConfigController = {

    /**
     * GET /api/saij/config
     * Lista todos los workers.
     */
    async list(req, res) {
        try {
            const docs = await ConfiguracionScrapingSaij.find().lean();
            res.json({ success: true, data: docs });
        } catch (error) {
            logger.error(`[saij] Error listando config: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/config/:workerId
     * Obtener config de un worker.
     */
    async getOne(req, res) {
        try {
            const doc = await ConfiguracionScrapingSaij.findOne({ worker_id: req.params.workerId }).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[saij] Error getOne config: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * POST /api/saij/config/:workerId/enable
     * Habilitar worker.
     */
    async enable(req, res) {
        try {
            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                { $set: { enabled: true, lastUpdate: new Date() } },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });
            logger.info(`[saij] Worker ${req.params.workerId} habilitado por ${req.userId}`);
            res.json({ success: true, message: 'Worker habilitado', data: { enabled: doc.enabled } });
        } catch (error) {
            logger.error(`[saij] Error enable: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * POST /api/saij/config/:workerId/disable
     * Deshabilitar worker.
     */
    async disable(req, res) {
        try {
            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                { $set: { enabled: false, lastUpdate: new Date() } },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });
            logger.info(`[saij] Worker ${req.params.workerId} deshabilitado por ${req.userId}`);
            res.json({ success: true, message: 'Worker deshabilitado', data: { enabled: doc.enabled } });
        } catch (error) {
            logger.error(`[saij] Error disable: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * POST /api/saij/config/:workerId/pause
     * Pausar worker manualmente.
     * Body: { reason, resumeAt? }
     */
    async pause(req, res) {
        try {
            const { reason, resumeAt } = req.body;

            if (!reason) {
                return res.status(400).json({ success: false, message: 'Se requiere una razón para pausar' });
            }

            let resumeDate = null;
            if (resumeAt) {
                resumeDate = new Date(resumeAt);
                if (isNaN(resumeDate.getTime())) {
                    return res.status(400).json({ success: false, message: 'Fecha de reanudación inválida' });
                }
            }

            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                {
                    $set: {
                        'pause.isPaused': true,
                        'pause.pausedAt': new Date(),
                        'pause.pauseReason': reason,
                        ...(resumeDate && { 'pause.resumeAt': resumeDate }),
                        'availability.manualPause': true,
                        'availability.manualPauseReason': reason,
                        lastUpdate: new Date(),
                    },
                },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            logger.info(`[saij] Worker ${req.params.workerId} pausado por ${req.userId}: ${reason}`);
            res.json({ success: true, message: 'Worker pausado', data: { pause: doc.pause } });
        } catch (error) {
            logger.error(`[saij] Error pause: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * POST /api/saij/config/:workerId/resume
     * Reanudar worker.
     */
    async resume(req, res) {
        try {
            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                {
                    $set: {
                        'pause.isPaused': false,
                        'pause.consecutiveErrors': 0,
                        'availability.manualPause': false,
                        'availability.manualPauseReason': '',
                        lastUpdate: new Date(),
                    },
                    $unset: { 'pause.resumeAt': '', 'pause.pauseReason': '' },
                },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            logger.info(`[saij] Worker ${req.params.workerId} reanudado por ${req.userId}`);
            res.json({ success: true, message: 'Worker reanudado', data: { pause: doc.pause } });
        } catch (error) {
            logger.error(`[saij] Error resume: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * PATCH /api/saij/config/:workerId/cursor
     * Mover cursor de scraping.
     * Body: { year, month, offset? }
     */
    async resetCursor(req, res) {
        try {
            const { year, month, offset = 0 } = req.body;

            if (!year || !month) {
                return res.status(400).json({ success: false, message: 'year y month son requeridos' });
            }

            const y = parseInt(year);
            const m = parseInt(month);

            if (y < 1900 || y > 2100 || m < 1 || m > 12) {
                return res.status(400).json({ success: false, message: 'year o month fuera de rango' });
            }

            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                {
                    $set: {
                        'scraping.currentYear': y,
                        'scraping.currentMonth': m,
                        'scraping.currentOffset': parseInt(offset),
                        lastUpdate: new Date(),
                    },
                },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            logger.info(`[saij] Cursor de ${req.params.workerId} movido a ${y}/${m} por ${req.userId}`);
            res.json({
                success: true,
                message: 'Cursor actualizado',
                data: {
                    currentYear:   doc.scraping.currentYear,
                    currentMonth:  doc.scraping.currentMonth,
                    currentOffset: doc.scraping.currentOffset,
                },
            });
        } catch (error) {
            logger.error(`[saij] Error resetCursor: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * PATCH /api/saij/config/:workerId/scraping
     * Actualizar parámetros de scraping.
     * Body: campos opcionales de scraping (batchSize, delayBetweenRequests, etc.)
     */
    async updateScraping(req, res) {
        try {
            const allowed = [
                'batchSize', 'delayBetweenRequests', 'rateLimit',
                'pageTimeout', 'maxRetries', 'downloadPdf', 'yearFrom',
            ];

            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) {
                    updates[`scraping.${key}`] = req.body[key];
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Sin campos válidos',
                    allowedFields: allowed,
                });
            }

            updates.lastUpdate = new Date();

            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                { $set: updates },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            logger.info(`[saij] Config scraping de ${req.params.workerId} actualizada por ${req.userId}`);
            res.json({ success: true, message: 'Configuración actualizada', data: { scraping: doc.scraping } });
        } catch (error) {
            logger.error(`[saij] Error updateScraping: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * PATCH /api/saij/config/:workerId/notification
     * Actualizar configuración de notificaciones.
     */
    async updateNotification(req, res) {
        try {
            const allowed = ['startupEmail', 'errorEmail', 'dailyReport', 'recipientEmail'];
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[`notification.${key}`] = req.body[key];
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ success: false, message: 'Sin campos válidos', allowedFields: allowed });
            }

            updates.lastUpdate = new Date();

            const doc = await ConfiguracionScrapingSaij.findOneAndUpdate(
                { worker_id: req.params.workerId },
                { $set: updates },
                { new: true }
            );
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            res.json({ success: true, message: 'Notificaciones actualizadas', data: { notification: doc.notification } });
        } catch (error) {
            logger.error(`[saij] Error updateNotification: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/config/:workerId/history
     * Historial de meses completados.
     * Query: page, limit
     */
    async getHistory(req, res) {
        try {
            const { page = 1, limit = 24 } = req.query;
            const doc = await ConfiguracionScrapingSaij.findOne(
                { worker_id: req.params.workerId },
                { history: 1, worker_id: 1 }
            ).lean();

            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            const history = [...doc.history].reverse();
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const lim  = Math.min(parseInt(limit), 120);
            const page_data = history.slice(skip, skip + lim);

            res.json({
                success: true,
                data: page_data,
                pagination: {
                    total: history.length,
                    page: parseInt(page),
                    limit: lim,
                    pages: Math.ceil(history.length / lim),
                },
            });
        } catch (error) {
            logger.error(`[saij] Error getHistory: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/config/:workerId/stats
     * Estadísticas del worker.
     */
    async getStats(req, res) {
        try {
            const doc = await ConfiguracionScrapingSaij.findOne(
                { worker_id: req.params.workerId },
                { stats: 1, scraping: 1, enabled: 1, pause: 1, worker_id: 1 }
            ).lean();

            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });

            res.json({
                success: true,
                data: {
                    worker_id:    doc.worker_id,
                    enabled:      doc.enabled,
                    pause:        doc.pause,
                    cursor: {
                        currentYear:   doc.scraping.currentYear,
                        currentMonth:  doc.scraping.currentMonth,
                        currentOffset: doc.scraping.currentOffset,
                        yearFrom:      doc.scraping.yearFrom,
                    },
                    stats: doc.stats,
                },
            });
        } catch (error) {
            logger.error(`[saij] Error getStats: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },
};

module.exports = saijConfigController;
