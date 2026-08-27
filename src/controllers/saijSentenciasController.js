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
                pipelineStatus,
                hasExpediente,
                expedienteSource,
                embeddingStatus,
                hasSentenciaCapturada,
                userNotified,
                userCampaignExcluded,
                userCampaignId,
                hasSocialPost,
                hasAiSummary,
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
            if (pipelineStatus)    filter.pipelineStatus = pipelineStatus;
            if (hasExpediente === 'true')  filter['expediente.numero'] = { $exists: true };
            if (hasExpediente === 'false') filter['expediente.numero'] = { $exists: false };
            if (expedienteSource)  filter['expediente.source'] = expedienteSource;

            // Campañas de novedades a usuarios. Los flags son sparse: los docs
            // viejos no tienen el campo, así que 'false' se resuelve con $ne.
            if (userNotified === 'true')  filter.userNotified = true;
            if (userNotified === 'false') filter.userNotified = { $ne: true };
            if (userCampaignExcluded === 'true')  filter.userCampaignExcluded = true;
            if (userCampaignExcluded === 'false') filter.userCampaignExcluded = { $ne: true };
            if (userCampaignId) filter.userCampaignId = userCampaignId;
            if (hasSocialPost === 'true')  filter['socialPost.generado'] = true;
            if (hasSocialPost === 'false') filter['socialPost.generado'] = { $ne: true };

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

            // Filtros post-lookup (dependen del SC asociado)
            const postLookupMatch = {};
            if (embeddingStatus) {
                postLookupMatch['sentenciaCapturada.embeddingStatus'] = embeddingStatus;
            }
            // Después del $arrayElemAt el campo siempre existe (null si el
            // lookup no devolvió nada). Filtramos por sub-field _id en true y
            // por igualdad a null en false.
            if (hasSentenciaCapturada === 'true') {
                postLookupMatch['sentenciaCapturada._id'] = { $exists: true };
            }
            if (hasSentenciaCapturada === 'false') {
                postLookupMatch['sentenciaCapturada'] = null;
            }
            // Resumen IA: vive en la SentenciaCapturada, así que es post-lookup.
            // Es además el requisito de la vista pública de jurisprudencia.
            if (hasAiSummary === 'true') {
                postLookupMatch['sentenciaCapturada.aiSummary.content'] = { $exists: true, $nin: [null, ''] };
            }
            if (hasAiSummary === 'false') {
                postLookupMatch['$or'] = [
                    { 'sentenciaCapturada': null },
                    { 'sentenciaCapturada.aiSummary.content': { $in: [null, ''] } },
                    { 'sentenciaCapturada.aiSummary.content': { $exists: false } },
                ];
            }
            const hasPostMatch = Object.keys(postLookupMatch).length > 0;

            const lookupStage = { $lookup: {
                from: 'sentencias-capturadas',
                localField: '_id',
                foreignField: 'source.saijDocId',
                as: 'sentenciaCapturada',
                pipeline: [{
                    $project: {
                        processingStatus: 1, embeddingStatus: 1,
                        embeddedAt: 1, embeddingChunksCount: 1,
                        processedAt: 1, category: 1,
                        'source.origin': 1, 'source.saijDocId': 1,
                        causaId: 1, fuero: 1, number: 1, year: 1,
                        // Estado de publicación en la vista pública: el resumen
                        // IA y el kill-switch editorial. Se proyecta la longitud
                        // del resumen en vez del texto para no inflar la respuesta.
                        publicationStatus: 1,
                        'aiSummary.status': 1,
                        'aiSummary.generatedAt': 1,
                        'aiSummary.skipReason': 1,
                        aiSummaryChars: { $strLenCP: { $ifNull: ['$aiSummary.content', ''] } },
                    },
                }],
            }};
            const addFieldsStage = { $addFields: {
                sentenciaCapturada: { $arrayElemAt: ['$sentenciaCapturada', 0] },
            }};

            // Data pipeline — orden importante: pre-match → lookup → post-match →
            // sort → skip/limit. El lookup es caro, así que el pre-match (que
            // usa índices) filtra primero. Si hay post-match, se aplica después.
            const dataPipeline = [
                { $match: filter },
                lookupStage,
                addFieldsStage,
                ...(hasPostMatch ? [{ $match: postLookupMatch }] : []),
                { $sort: { fecha: -1 } },
                { $skip: skip },
                { $limit: lim },
                { $project: { rawContent: 0, descriptoresCompletos: 0 } },
            ];

            // Count pipeline. Si no hay post-match, alcanza con countDocuments
            // directo del filter (más barato). Si hay, hay que armar pipeline
            // equivalente con $count al final.
            let totalPromise;
            if (hasPostMatch) {
                const countPipeline = [
                    { $match: filter },
                    lookupStage,
                    addFieldsStage,
                    { $match: postLookupMatch },
                    { $count: 'total' },
                ];
                totalPromise = SaijSentencia.aggregate(countPipeline).then(r => r[0]?.total || 0);
            } else {
                totalPromise = SaijSentencia.countDocuments(filter);
            }

            const [data, total] = await Promise.all([
                SaijSentencia.aggregate(dataPipeline),
                totalPromise,
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
     * Conteos agrupados — incluye pipeline downstream:
     *   - byType / byStatus / byYear         (legacy)
     *   - byPipelineStatus / byFuero          (nuevos)
     *   - withCausaRef / withExpediente / withExpedientePdf  (counts)
     *   - sentenciasCapturadas: cross-join con la colección sentencias-capturadas
     *     filtrando source.origin='saij'. Trae byProcessingStatus + byEmbeddingStatus
     *     + total para visualizar el avance del pipeline de embeddings.
     */
    async stats(req, res) {
        try {
            const scCollection = SaijSentencia.db.collection('sentencias-capturadas');

            const [
                byType, byStatus, byYear,
                byPipelineStatus, byFuero,
                withCausaRef, withExpediente, withExpedientePdf,
                total,
                scTotal, scByProcessing, scByEmbedding,
                userNotifiedCount, userExcludedCount, socialPostCount,
                scWithAiSummary, scPublicationSkipped,
            ] = await Promise.all([
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
                SaijSentencia.aggregate([
                    { $group: { _id: '$pipelineStatus', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]),
                SaijSentencia.aggregate([
                    { $match: { fuero: { $ne: null, $ne: '' } } },
                    { $group: { _id: '$fuero', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]),
                SaijSentencia.countDocuments({ 'causaRefs.0': { $exists: true } }),
                SaijSentencia.countDocuments({ 'expediente.numero': { $exists: true } }),
                SaijSentencia.countDocuments({ 'expediente.source': 'pdf' }),
                SaijSentencia.countDocuments(),
                scCollection.countDocuments({ 'source.origin': 'saij' }),
                scCollection.aggregate([
                    { $match: { 'source.origin': 'saij' } },
                    { $group: { _id: '$processingStatus', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]).toArray(),
                scCollection.aggregate([
                    { $match: { 'source.origin': 'saij' } },
                    { $group: { _id: '$embeddingStatus', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]).toArray(),
                // Campañas a usuarios y difusión social (solo aplican a fallos)
                SaijSentencia.countDocuments({ userNotified: true }),
                SaijSentencia.countDocuments({ userCampaignExcluded: true }),
                SaijSentencia.countDocuments({ 'socialPost.generado': true }),
                scCollection.countDocuments({ 'source.origin': 'saij', 'aiSummary.content': { $exists: true, $nin: [null, ''] } }),
                scCollection.countDocuments({ 'source.origin': 'saij', publicationStatus: 'skipped' }),
            ]);

            res.json({
                success: true,
                data: {
                    total,
                    byType, byStatus, byYear,
                    byPipelineStatus, byFuero,
                    withCausaRef, withExpediente, withExpedientePdf,
                    sentenciasCapturadas: {
                        total: scTotal,
                        byProcessingStatus: scByProcessing,
                        byEmbeddingStatus: scByEmbedding,
                        withAiSummary: scWithAiSummary,
                        publicationSkipped: scPublicationSkipped,
                    },
                    // Difusión: campañas de novedades a usuarios + redes sociales
                    difusion: {
                        userNotified: userNotifiedCount,
                        userCampaignExcluded: userExcludedCount,
                        socialPost: socialPostCount,
                    },
                },
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
     * PATCH /api/saij/sentencias/:id/social-post
     * Marca (o desmarca) que se generó una pieza para redes por este fallo.
     * Body: { generado: bool, postId?: string, estado?: string }
     *
     * `postId` es opcional: permite marcar a mano sin tener el post creado
     * todavía. Cuando se pasa, apunta a socialposts de la-marketing-service.
     */
    async setSocialPost(req, res) {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ success: false, message: 'ID inválido' });
            }

            const { generado, postId, estado } = req.body;
            if (typeof generado !== 'boolean') {
                return res.status(400).json({ success: false, message: 'Campo `generado` (boolean) requerido' });
            }

            const update = generado
                ? {
                    $set: {
                        'socialPost.generado': true,
                        'socialPost.postId': postId || '',
                        'socialPost.estado': estado || '',
                        'socialPost.markedAt': new Date(),
                        'socialPost.markedBy': req.userId || 'admin',
                    },
                }
                : { $set: { 'socialPost.generado': false, 'socialPost.markedAt': new Date(), 'socialPost.markedBy': req.userId || 'admin' } };

            const doc = await SaijSentencia.findByIdAndUpdate(req.params.id, update, { new: true })
                .select('titulo socialPost')
                .lean();

            if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

            logger.info(`[saij] socialPost.generado=${generado} en ${req.params.id} por ${req.userId}`);
            res.json({ success: true, data: doc });
        } catch (error) {
            logger.error(`[saij] Error setSocialPost: ${error.message}`);
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
    /**
     * PATCH /api/saij/sentencias/:id/causa
     * Vincula (o desvincula) a mano un fallo con una causa PJN.
     *
     * El pipeline vincula solo cuando puede parsear el expediente del PDF, y
     * hay fallos importantes cuyo expediente no matchea. Esto permite hacerlo
     * a mano desde el admin: se busca la causa por fuero/numero/anio, se
     * escribe causaRefs en el doc SAIJ y se actualiza su SentenciaCapturada
     * para que quede colgada de esa causa.
     *
     * Body: { fuero, number, year }  ·  { desvincular: true } para soltarla.
     */
    async vincularCausa(req, res) {
        try {
            const doc = await SaijSentencia.findById(req.params.id);
            if (!doc) return res.status(404).json({ success: false, message: 'Sentencia no encontrada' });

            const SentenciaCapturada = mongoose.connection.collection('sentencias-capturadas');

            if (req.body.desvincular) {
                await SaijSentencia.updateOne({ _id: doc._id }, {
                    $set: { causaRefs: [], pipelineUpdatedAt: new Date(), pipelineError: 'desvinculado a mano desde el admin' },
                });
                await SentenciaCapturada.updateMany({ 'source.saijDocId': doc._id }, { $set: { causaId: null } });
                return res.json({ success: true, data: { desvinculada: true } });
            }

            const { fuero, number, year } = req.body;
            const { getModel } = require('./causasController');
            let Causa;
            try {
                Causa = getModel(String(fuero || '').toUpperCase());
            } catch (e) {
                return res.status(400).json({ success: false, message: e.message });
            }

            const causa = await Causa.findOne({ number: String(number), year: String(year) })
                .select('_id caratula number year')
                .lean();
            if (!causa) {
                return res.status(404).json({
                    success: false,
                    message: `No existe la causa ${fuero} ${number}/${year} en la base`,
                });
            }

            const ref = {
                causaId: causa._id,
                caratula: causa.caratula,
                fuero: String(fuero).toUpperCase(),
                source: 'app',
            };
            await SaijSentencia.updateOne({ _id: doc._id }, {
                $set: {
                    causaRefs: [ref],
                    fuero: ref.fuero,
                    'expediente.numero': Number(number),
                    'expediente.año': Number(year),
                    'expediente.source': 'manual',
                    'expediente.confidence': 'high',
                    pipelineUpdatedAt: new Date(),
                    pipelineError: null,
                },
            });

            // La SC hereda la causa: es lo que la vuelve a colgar del expediente.
            const r = await SentenciaCapturada.updateMany(
                { 'source.saijDocId': doc._id },
                { $set: { causaId: causa._id, fuero: ref.fuero, number: Number(number), year: Number(year), caratula: causa.caratula } }
            );

            logger.info(`[saij] Fallo ${doc._id} vinculado a mano con ${ref.fuero} ${number}/${year} (${causa._id}); ${r.modifiedCount} SC actualizada(s)`);
            res.json({ success: true, data: { causa: ref, sentenciasCapturadas: r.modifiedCount } });
        } catch (error) {
            logger.error(`[saij] Error vinculando causa: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

};

module.exports = saijSentenciasController;
