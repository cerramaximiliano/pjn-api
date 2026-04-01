'use strict';

const mongoose = require('mongoose');
const SaijSentencia = require('../models/SaijSentencia');
const { logger } = require('../config/pino');

const saijSentenciasController = {

    /**
     * GET /api/saij/sentencias
     * Lista con filtros y paginación.
     * Query: page, limit, saijType, status, tribunal, fuero, yearFrom, yearTo,
     *        monthFrom, monthTo, workerId, q (text search)
     */
    async list(req, res) {
        try {
            const {
                page = 1,
                limit = 20,
                saijType,
                status,
                tribunal,
                fuero,
                expedienteNumero,
                expedienteAño,
                yearFrom,
                yearTo,
                monthFrom,
                monthTo,
                workerId,
                causaId,
                linked,
                saijSentenciaId,
                q,
            } = req.query;

            const filter = {};

            if (saijType) filter.saijType = saijType;
            if (status)   filter.status = status;
            if (tribunal) filter.tribunal = new RegExp(tribunal, 'i');
            if (fuero)    filter.fuero = fuero;
            if (workerId) filter.workerId = workerId;
            if (expedienteNumero) filter['expediente.numero'] = parseInt(expedienteNumero);
            if (expedienteAño)    filter['expediente.año'] = parseInt(expedienteAño);
            if (causaId)           filter['causaRefs.causaId'] = causaId;
            if (saijSentenciaId)   filter.saijSentenciaId = saijSentenciaId;
            if (linked === 'true')  filter['causaRefs.0'] = { $exists: true };
            if (linked === 'false') filter.$or = [{ causaRefs: { $exists: false } }, { causaRefs: { $size: 0 } }];

            if (yearFrom || yearTo || monthFrom || monthTo) {
                filter.fecha = {};
                const yFrom = parseInt(yearFrom || '1900');
                const mFrom = parseInt(monthFrom || '1');
                const yTo   = parseInt(yearTo || '2100');
                const mTo   = parseInt(monthTo || '12');
                filter.fecha.$gte = new Date(`${yFrom}-${String(mFrom).padStart(2, '0')}-01`);
                filter.fecha.$lte = new Date(`${yTo}-${String(mTo).padStart(2, '0')}-31`);
            }

            if (q) {
                filter.$text = { $search: q };
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const lim  = Math.min(parseInt(limit), 100);

            const [data, total] = await Promise.all([
                SaijSentencia.find(filter)
                    .select('-rawContent -descriptoresCompletos')
                    .sort({ fecha: -1 })
                    .skip(skip)
                    .limit(lim)
                    .lean(),
                SaijSentencia.countDocuments(filter),
            ]);

            res.json({
                success: true,
                data,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: lim,
                    pages: Math.ceil(total / lim),
                },
            });
        } catch (error) {
            logger.error(`[saij] Error listando sentencias: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/sentencias/stats
     * Conteos agrupados por tipo, status, año.
     */
    async stats(req, res) {
        try {
            const [byType, byStatus, byYear] = await Promise.all([
                SaijSentencia.aggregate([
                    { $group: { _id: '$saijType', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]),
                SaijSentencia.aggregate([
                    { $group: { _id: '$status', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]),
                SaijSentencia.aggregate([
                    { $match: { fecha: { $exists: true, $ne: null } } },
                    { $group: { _id: { $year: '$fecha' }, count: { $sum: 1 } } },
                    { $sort: { _id: -1 } },
                ]),
            ]);

            const total = await SaijSentencia.countDocuments();

            res.json({
                success: true,
                data: { total, byType, byStatus, byYear },
            });
        } catch (error) {
            logger.error(`[saij] Error obteniendo stats: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/sentencias/enrich/stats
     * Progreso del worker de enriquecimiento de texto completo de sumarios.
     */
    async enrichStats(req, res) {
        try {
            const base = { saijType: 'sumario' };

            const [total, enriched, pendingWithUrl, noUrl, recent] = await Promise.all([
                SaijSentencia.countDocuments(base),
                SaijSentencia.countDocuments({ ...base, textoCompleto: { $exists: true, $ne: '' } }),
                SaijSentencia.countDocuments({
                    ...base,
                    url: { $exists: true, $ne: '' },
                    $or: [{ textoCompleto: { $exists: false } }, { textoCompleto: '' }, { textoCompleto: null }],
                }),
                SaijSentencia.countDocuments({ ...base, $or: [{ url: { $exists: false } }, { url: '' }] }),
                SaijSentencia.find({ ...base, textoCompleto: { $exists: true, $ne: '' } })
                    .select('numeroSumario texto textoCompleto updatedAt')
                    .sort({ updatedAt: -1 })
                    .limit(10)
                    .lean(),
            ]);

            res.json({
                success: true,
                data: { total, enriched, pendingWithUrl, noUrl, recent },
            });
        } catch (error) {
            logger.error(`[saij] Error enrichStats: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/sentencias/:id
     * Obtener por MongoDB _id.
     */
    async getById(req, res) {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ success: false, message: 'ID inválido' });
            }

            const doc = await SaijSentencia.findById(req.params.id).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[saij] Error getById: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/saij/sentencias/saij/:saijId
     * Obtener por SAIJ UUID.
     */
    async getBySaijId(req, res) {
        try {
            const doc = await SaijSentencia.findOne({ saijId: req.params.saijId }).lean();
            if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[saij] Error getBySaijId: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * PATCH /api/saij/sentencias/:id
     * Actualizar campos editables (admin).
     */
    async update(req, res) {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ success: false, message: 'ID inválido' });
            }

            const allowed = ['status', 'pdfUrl', 'titulo', 'tribunal', 'errorMessage', 'retryCount'];
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[key] = req.body[key];
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Sin campos válidos para actualizar',
                    allowedFields: allowed,
                });
            }

            const doc = await SaijSentencia.findByIdAndUpdate(
                req.params.id,
                { $set: updates },
                { new: true }
            ).lean();

            if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

            logger.info(`[saij] Sentencia ${req.params.id} actualizada por ${req.userId}`);
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[saij] Error update: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * DELETE /api/saij/sentencias/:id
     * Eliminar por _id (admin).
     */
    async remove(req, res) {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ success: false, message: 'ID inválido' });
            }

            const doc = await SaijSentencia.findByIdAndDelete(req.params.id);
            if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

            logger.info(`[saij] Sentencia ${req.params.id} eliminada por ${req.userId}`);
            res.json({ success: true, message: 'Eliminado' });
        } catch (error) {
            logger.error(`[saij] Error delete: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },
};

module.exports = saijSentenciasController;
