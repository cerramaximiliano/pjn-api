/**
 * Controller para HTML Drift del portal PJN.
 *
 * Expone los datos generados por el guard in-line (html-drift-guard.js en
 * pjn-models) y el cron analizador de fingerprints (pjn-html-fingerprint-analyzer
 * en pjn-workers).
 *
 * Endpoints:
 *   GET    /api/html-drift/incidents
 *   GET    /api/html-drift/fingerprints/stats
 *   POST   /api/html-drift/incidents/:id/close
 *   POST   /api/html-drift/analyzer/run   (no-op placeholder; el analyzer
 *                                          corre dentro del manager y no es
 *                                          triggereable remotamente sin más infra)
 */
const { PjnHtmlDriftIncident, PjnHtmlFingerprint } = require('pjn-models');
const { logger } = require('../config/pino');

const htmlDriftController = {
    /**
     * Listar drifts con filtros y summary.
     * GET /api/html-drift/incidents
     * Query: limit (1-200, default 50), skip (default 0),
     *        resolved (true|false), sinceDays (number), type (string)
     */
    async getIncidents(req, res) {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
            const sinceDays = parseInt(req.query.sinceDays, 10);
            const since = Number.isFinite(sinceDays) && sinceDays > 0
                ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
                : undefined;

            let resolved;
            if (req.query.resolved === 'true') resolved = true;
            else if (req.query.resolved === 'false') resolved = false;

            const type = req.query.type || undefined;

            const items = await PjnHtmlDriftIncident.listDrifts({
                limit, skip, resolved, since, type,
            });

            // Summary agregado.
            const matchOpen = { endedAt: null };
            if (since) matchOpen.startedAt = { $gte: since };

            const openCount = await PjnHtmlDriftIncident.countDocuments(matchOpen);
            const openCritical = await PjnHtmlDriftIncident.countDocuments({
                ...matchOpen, severity: 'critical',
            });

            // Conteo por tipo (open + closed combined) en la ventana.
            const matchAll = {};
            if (since) matchAll.startedAt = { $gte: since };
            const byType = await PjnHtmlDriftIncident.aggregate([
                { $match: matchAll },
                {
                    $group: {
                        _id: '$type',
                        total: { $sum: 1 },
                        open: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } },
                        totalDetections: { $sum: '$detectionCount' },
                    },
                },
                { $sort: { total: -1 } },
            ]);

            // Último drift (cualquier estado) para mostrar "hace X tiempo".
            const lastEvent = await PjnHtmlDriftIncident.findOne({})
                .sort({ startedAt: -1 })
                .lean();

            return res.json({
                success: true,
                message: 'Listado de HTML drifts',
                data: items,
                count: items.length,
                summary: {
                    openCount,
                    openCritical,
                    byType,
                    lastEventAt: lastEvent?.startedAt || null,
                    lastEventType: lastEvent?.type || null,
                },
                serverTime: new Date().toISOString(),
            });
        } catch (error) {
            logger.error(`Error obteniendo HTML drifts: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
            });
        }
    },

    /**
     * Estadísticas de fingerprints HTML del portal.
     * GET /api/html-drift/fingerprints/stats
     * Query: days (default 7, max 30)
     */
    async getFingerprintStats(req, res) {
        try {
            const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const total = await PjnHtmlFingerprint.countDocuments({ timestamp: { $gte: since } });

            if (total === 0) {
                return res.json({
                    success: true,
                    message: 'Sin fingerprints en la ventana solicitada',
                    data: {
                        windowDays: days,
                        total: 0,
                        avgTotalSpans: 0,
                        selectorFrequencies: [],
                        timeseries: [],
                    },
                });
            }

            // 1) Estadísticas agregadas: avg / min / max de totalSpans.
            const [agg] = await PjnHtmlFingerprint.aggregate([
                { $match: { timestamp: { $gte: since } } },
                {
                    $group: {
                        _id: null,
                        avgTotalSpans: { $avg: '$totalSpans' },
                        minTotalSpans: { $min: '$totalSpans' },
                        maxTotalSpans: { $max: '$totalSpans' },
                        count: { $sum: 1 },
                    },
                },
            ]);

            // 2) Frecuencia de cada selector (ids JSF detail*).
            const selectorAgg = await PjnHtmlFingerprint.aggregate([
                { $match: { timestamp: { $gte: since } } },
                { $unwind: '$idsPresentes' },
                {
                    $group: {
                        _id: '$idsPresentes',
                        count: { $sum: 1 },
                    },
                },
                { $sort: { count: -1 } },
            ]);
            const selectorFrequencies = selectorAgg.map((s) => ({
                id: s._id,
                count: s.count,
                pct: total > 0 ? s.count / total : 0,
            }));

            // 3) Serie temporal: avg totalSpans por día.
            const timeseries = await PjnHtmlFingerprint.aggregate([
                { $match: { timestamp: { $gte: since } } },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
                        },
                        avgTotalSpans: { $avg: '$totalSpans' },
                        count: { $sum: 1 },
                        situacionPct: { $avg: { $cond: ['$situacionPresent', 1, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]);

            // 4) Por fuero — útil para detectar si el drift es solo en un fuero.
            const byFuero = await PjnHtmlFingerprint.aggregate([
                { $match: { timestamp: { $gte: since } } },
                {
                    $group: {
                        _id: '$fuero',
                        count: { $sum: 1 },
                        avgTotalSpans: { $avg: '$totalSpans' },
                    },
                },
                { $sort: { count: -1 } },
            ]);

            return res.json({
                success: true,
                message: 'Estadísticas de fingerprints HTML',
                data: {
                    windowDays: days,
                    total,
                    avgTotalSpans: agg?.avgTotalSpans || 0,
                    minTotalSpans: agg?.minTotalSpans || 0,
                    maxTotalSpans: agg?.maxTotalSpans || 0,
                    selectorFrequencies,
                    timeseries: timeseries.map((t) => ({
                        date: t._id,
                        avgTotalSpans: t.avgTotalSpans,
                        count: t.count,
                        situacionPct: t.situacionPct,
                    })),
                    byFuero,
                },
                serverTime: new Date().toISOString(),
            });
        } catch (error) {
            logger.error(`Error obteniendo stats de fingerprints: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
            });
        }
    },

    /**
     * Cierra manualmente un drift (acknowledge).
     * POST /api/html-drift/incidents/:id/close
     * Body opcional: { notes }
     */
    async closeIncident(req, res) {
        try {
            const { id } = req.params;
            const { notes } = req.body || {};

            const incident = await PjnHtmlDriftIncident.findById(id);
            if (!incident) {
                return res.status(404).json({
                    success: false,
                    message: 'Drift no encontrado',
                });
            }
            if (incident.endedAt) {
                return res.json({
                    success: true,
                    message: 'El drift ya estaba cerrado',
                    data: incident,
                });
            }

            const now = new Date();
            incident.endedAt = now;
            incident.durationMs = now.getTime() - new Date(incident.startedAt).getTime();
            incident.resolvedBy = (req.user && (req.user.email || req.user.id)) || 'admin-panel';
            if (notes) incident.notes = notes;
            await incident.save();

            return res.json({
                success: true,
                message: 'Drift cerrado manualmente',
                data: incident,
            });
        } catch (error) {
            logger.error(`Error cerrando drift: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
            });
        }
    },

    /**
     * Stub para invocar el analyzer on-demand.
     * El analyzer corre dentro del proceso pjn-app-update-manager (otro host);
     * disparar desde acá requeriría un puente (Redis pub/sub o HTTP interno).
     * Por ahora documenta el endpoint y responde "not yet supported".
     * GET /api/html-drift/analyzer/run
     */
    async runAnalyzer(_req, res) {
        return res.status(501).json({
            success: false,
            message:
                'El analyzer corre dentro del manager (pjn-app-update-manager) cada 30 min. ' +
                'Disparo manual aún no soportado.',
        });
    },
};

module.exports = htmlDriftController;
