'use strict';

const ConfiguracionCijur = require('../models/ConfiguracionCijur');
const CijurFallo = require('../models/CijurFallo');
const { logger } = require('../config/pino');

/** Campos de la config que la UI puede editar. Todo lo demás lo escribe el worker. */
const EDITABLES_SCRAPING = [
    'canales', 'cronPattern', 'paginasPorCiclo', 'maxPaginas',
    'rateLimit', 'delayBetweenRequests', 'descargarPdf',
];
const EDITABLES_NOTIFICATION = ['errorEmail', 'newDocumentsEmail', 'recipientEmail'];

function tomarCampos(origen, permitidos) {
    const out = {};
    for (const k of permitidos) {
        if (origen[k] !== undefined) out[`__${k}`] = origen[k];
    }
    return out;
}

const cijurController = {

    /** GET /api/cijur/config — todos los workers */
    async listConfigs(req, res) {
        try {
            const docs = await ConfiguracionCijur.find().lean();
            res.json({ success: true, data: docs });
        } catch (error) {
            logger.error(`[cijur] Error listando config: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/cijur/progress
     * Estado de captura: cuánto lleva cada canal y hasta qué fecha llegó.
     *
     * Las cantidades salen de contar la colección, no de stats.totalSuccess:
     * ese contador acumula intentos y se desfasa con los reinicios y los
     * documentos salteados por ya existir.
     */
    async progress(req, res) {
        try {
            const [configs, porCanal, totales] = await Promise.all([
                ConfiguracionCijur.find().lean(),
                CijurFallo.aggregate([
                    {
                        $group: {
                            _id: '$canal',
                            docs: { $sum: 1 },
                            conTexto: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$textoCompleto', ''] } }, 1500] }, 1, 0] } },
                            conVoces: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$voces', ''] } }, 0] }, 1, 0] } },
                            errores: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                            chars: { $sum: { $strLenCP: { $ifNull: ['$textoCompleto', ''] } } },
                            masReciente: { $max: '$publicadoEn' },
                            masAntiguo: { $min: '$publicadoEn' },
                            ultimoCapturado: { $max: '$createdAt' },
                        },
                    },
                    { $sort: { _id: 1 } },
                ]),
                CijurFallo.countDocuments({}),
            ]);

            const canales = porCanal.map((c) => ({
                canal: c._id,
                docs: c.docs,
                conTexto: c.conTexto,
                conVoces: c.conVoces,
                errores: c.errores,
                chars: c.chars,
                masReciente: c.masReciente,
                masAntiguo: c.masAntiguo,
                ultimoCapturado: c.ultimoCapturado,
            }));

            const workers = configs.map((c) => ({
                workerId: c.worker_id,
                enabled: !!c.enabled,
                canales: c.scraping?.canales || [],
                cronPattern: c.scraping?.cronPattern || null,
                paginasPorCiclo: c.scraping?.paginasPorCiclo ?? null,
                rateLimit: c.scraping?.rateLimit ?? null,
                lastRunAt: c.stats?.lastRunAt || null,
                lastSuccessAt: c.stats?.lastSuccessAt || null,
                lastErrorAt: c.stats?.lastErrorAt || null,
                lastErrorMessage: c.stats?.lastErrorMessage || null,
                totalSuccess: c.stats?.totalSuccess || 0,
                totalErrors: c.stats?.totalErrors || 0,
            }));

            res.json({
                success: true,
                data: {
                    workers,
                    canales,
                    totales: {
                        docs: totales,
                        chars: canales.reduce((a, c) => a + c.chars, 0),
                        conTexto: canales.reduce((a, c) => a + c.conTexto, 0),
                        errores: canales.reduce((a, c) => a + c.errores, 0),
                    },
                },
            });
        } catch (error) {
            logger.error(`[cijur] Error progress: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /** POST /api/cijur/config/:workerId/enable|disable */
    async setEnabled(req, res) {
        try {
            const enabled = req.path.endsWith('/enable');
            const doc = await ConfiguracionCijur.findOneAndUpdate(
                { worker_id: req.params.workerId },
                { $set: { enabled, lastUpdate: new Date() } },
                { new: true }
            ).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });
            logger.info(`[cijur] ${req.params.workerId} ${enabled ? 'habilitado' : 'deshabilitado'}`);
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[cijur] Error setEnabled: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /** PATCH /api/cijur/config/:workerId/scraping */
    async updateScraping(req, res) {
        try {
            const $set = { lastUpdate: new Date() };
            for (const k of EDITABLES_SCRAPING) {
                if (req.body[k] !== undefined) $set[`scraping.${k}`] = req.body[k];
            }
            if (Object.keys($set).length === 1) {
                return res.status(400).json({ success: false, message: 'Nada para actualizar' });
            }
            const doc = await ConfiguracionCijur.findOneAndUpdate(
                { worker_id: req.params.workerId }, { $set }, { new: true }
            ).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[cijur] Error updateScraping: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /** PATCH /api/cijur/config/:workerId/notification */
    async updateNotification(req, res) {
        try {
            const $set = { lastUpdate: new Date() };
            for (const k of EDITABLES_NOTIFICATION) {
                if (req.body[k] !== undefined) $set[`notification.${k}`] = req.body[k];
            }
            if (Object.keys($set).length === 1) {
                return res.status(400).json({ success: false, message: 'Nada para actualizar' });
            }
            const doc = await ConfiguracionCijur.findOneAndUpdate(
                { worker_id: req.params.workerId }, { $set }, { new: true }
            ).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'Worker no encontrado' });
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[cijur] Error updateNotification: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/cijur/fallos — listado paginado con filtros.
     *
     * No devuelve `textoCompleto` ni `contenido`: son cientos de miles de
     * caracteres por documento y harían la respuesta impracticable. El detalle
     * los trae por separado.
     */
    async listFallos(req, res) {
        try {
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
            const { canal, status, q, conTexto, desde, hasta } = req.query;

            const filtro = {};
            if (canal) filtro.canal = canal;
            if (status) filtro.status = status;
            if (conTexto === 'true') filtro.textoCompleto = { $exists: true, $ne: '' };
            if (conTexto === 'false') filtro.$or = [{ textoCompleto: '' }, { textoCompleto: { $exists: false } }];
            if (desde || hasta) {
                filtro.fecha = {};
                if (desde) filtro.fecha.$gte = new Date(desde);
                if (hasta) filtro.fecha.$lte = new Date(hasta);
            }
            if (q) {
                const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                filtro.$or = [{ titulo: rx }, { caratula: rx }, { tribunal: rx }, { voces: rx }];
            }

            const [items, total] = await Promise.all([
                CijurFallo.find(filtro, {
                    textoCompleto: 0, contenido: 0,
                })
                    .sort({ publicadoEn: -1, fecha: -1 })
                    .skip((page - 1) * limit)
                    .limit(limit)
                    .lean(),
                CijurFallo.countDocuments(filtro),
            ]);

            // Se informa el largo del texto sin mandarlo: alcanza para que la UI
            // muestre si el fallo tiene contenido aprovechable.
            const ids = items.map((i) => i._id);
            const largos = await CijurFallo.aggregate([
                { $match: { _id: { $in: ids } } },
                { $project: { chars: { $strLenCP: { $ifNull: ['$textoCompleto', ''] } } } },
            ]);
            const mapa = Object.fromEntries(largos.map((l) => [String(l._id), l.chars]));

            res.json({
                success: true,
                data: items.map((i) => ({ ...i, textoChars: mapa[String(i._id)] || 0 })),
                pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            });
        } catch (error) {
            logger.error(`[cijur] Error listFallos: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /** GET /api/cijur/fallos/stats — agregados para el panel */
    async statsFallos(req, res) {
        try {
            const [porTribunal, porAño, general] = await Promise.all([
                CijurFallo.aggregate([
                    { $match: { tribunal: { $nin: [null, ''] } } },
                    { $group: { _id: '$tribunal', n: { $sum: 1 } } },
                    { $sort: { n: -1 } }, { $limit: 12 },
                ]),
                CijurFallo.aggregate([
                    { $match: { fecha: { $type: 'date' } } },
                    { $group: { _id: { $year: '$fecha' }, n: { $sum: 1 } } },
                    { $sort: { _id: 1 } },
                ]),
                CijurFallo.aggregate([
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            conPdf: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$pdfUrl', ''] } }, 0] }, 1, 0] } },
                            conTexto: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$textoCompleto', ''] } }, 1500] }, 1, 0] } },
                            charsProm: { $avg: { $strLenCP: { $ifNull: ['$textoCompleto', ''] } } },
                        },
                    },
                ]),
            ]);

            res.json({
                success: true,
                data: {
                    porTribunal: porTribunal.map((t) => ({ tribunal: t._id, n: t.n })),
                    porAño: porAño.map((a) => ({ año: a._id, n: a.n })),
                    general: general[0] || { total: 0, conPdf: 0, conTexto: 0, charsProm: 0 },
                },
            });
        } catch (error) {
            logger.error(`[cijur] Error statsFallos: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /** GET /api/cijur/fallos/:id — detalle, con el texto completo */
    async getFallo(req, res) {
        try {
            const doc = await CijurFallo.findById(req.params.id).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'Fallo no encontrado' });
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[cijur] Error getFallo: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },
};

module.exports = cijurController;
