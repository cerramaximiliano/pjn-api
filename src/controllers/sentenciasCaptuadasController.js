const SentenciaCapturada = require('../models/SentenciaCapturada');
const { logger } = require('../config/pino');
const OpenAI = require('openai').default;

let _openai = null;
function getOpenAI() {
	if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	return _openai;
}

const SUMMARY_SYSTEM_PROMPT = `Eres un asistente jurídico especializado en derecho argentino. Tu tarea es analizar fallos judiciales y producir un resumen estructurado orientado a la divulgación jurídica.

El resumen debe tener EXACTAMENTE las siguientes tres secciones en formato Markdown:

## Resumen del fallo
Descripción clara y concisa de qué decidió el tribunal, las normas aplicadas y los fundamentos centrales del fallo. Máximo 3 párrafos.

## Pormenores
Contexto del caso: hechos relevantes, historial procesal, argumentos de las partes y aspectos destacados del razonamiento judicial. Máximo 4 párrafos.

## Resultado
Disposición final: quién ganó, qué se ordenó, montos o condenas si los hay, costas y cualquier otro punto resolutivo relevante. Máximo 2 párrafos.

Usa lenguaje claro y preciso, apto para abogados y público interesado en derecho. No inventes información que no esté en el texto. Si el texto está incompleto o ilegible en alguna parte, indícalo.`;

const MAX_TEXT_CHARS = 18000;

const sentenciasCapturadasController = {

	// GET /api/sentencias-capturadas/stats
	async getStats(req, res) {
		try {
			const [byStatus, byTipo, byFuero, recientes, errores, ocrByStatus, ocrRecientes, byCategory, noveltyRecientes, embeddingByStatus, embeddingRecientes, embeddingErrors, noveltyCheckByStatus] = await Promise.all([
				// Por status
				SentenciaCapturada.aggregate([
					{ $group: { _id: '$processingStatus', count: { $sum: 1 } } },
					{ $sort: { _id: 1 } },
				]),

				// Por tipo (solo procesadas)
				SentenciaCapturada.aggregate([
					{ $match: { processingStatus: { $in: ['processed', 'extracted_needs_ocr'] } } },
					{ $group: {
						_id: '$sentenciaTipo',
						count: { $sum: 1 },
						avgChars: { $avg: '$processingResult.charCount' },
						avgPages: { $avg: '$processingResult.pageCount' },
					}},
					{ $sort: { count: -1 } },
				]),

				// Por fuero
				SentenciaCapturada.aggregate([
					{ $group: {
						_id: '$fuero',
						total: { $sum: 1 },
						processed: { $sum: { $cond: [{ $eq: ['$processingStatus', 'processed'] }, 1, 0] } },
						pending: { $sum: { $cond: [{ $eq: ['$processingStatus', 'pending'] }, 1, 0] } },
						error: { $sum: { $cond: [{ $eq: ['$processingStatus', 'error'] }, 1, 0] } },
					}},
					{ $sort: { _id: 1 } },
				]),

				// Últimas 10 procesadas
				SentenciaCapturada
					.find({ processingStatus: { $in: ['processed', 'extracted_needs_ocr'] } })
					.sort({ processedAt: -1 })
					.limit(10)
					.select('number year fuero caratula sentenciaTipo processedAt processingResult.charCount processingResult.pageCount processingResult.method processingResult.isScanned movimientoTipo movimientoFecha url ocrStatus ocrResult.processedAt ocrResult.charCount ocrResult.method')
					.lean(),

				// Errores recientes
				SentenciaCapturada
					.find({ processingStatus: 'error' })
					.sort({ processedAt: -1 })
					.limit(10)
					.select('number year fuero caratula sentenciaTipo processedAt processingError retryCount url ocrStatus ocrAttempts')
					.lean(),

				// OCR stats: por estado de OCR
				SentenciaCapturada.aggregate([
					{ $match: { ocrStatus: { $ne: 'not_needed' } } },
					{ $group: { _id: '$ocrStatus', count: { $sum: 1 }, avgMs: { $avg: '$ocrResult.processingTimeMs' } } },
					{ $sort: { _id: 1 } },
				]),

				// Últimas 5 procesadas por OCR
				SentenciaCapturada
					.find({ ocrStatus: 'completed' })
					.sort({ 'ocrResult.processedAt': -1 })
					.limit(5)
					.select('number year fuero caratula sentenciaTipo ocrResult.processedAt ocrResult.charCount ocrResult.pageCount ocrResult.method ocrResult.processingTimeMs')
					.lean(),

				// Por categoría (novelty / rutina)
				SentenciaCapturada.aggregate([
					{ $group: {
						_id: '$category',
						total: { $sum: 1 },
						processed: { $sum: { $cond: [{ $eq: ['$processingStatus', 'processed'] }, 1, 0] } },
						pending: { $sum: { $cond: [{ $eq: ['$processingStatus', 'pending'] }, 1, 0] } },
					}},
					{ $sort: { _id: 1 } },
				]),

				// Últimas 10 novelty procesadas (para newsletter)
				SentenciaCapturada
					.find({ category: 'novelty', processingStatus: { $in: ['processed', 'extracted_needs_ocr'] } })
					.sort({ processedAt: -1 })
					.limit(10)
					.select('number year fuero caratula sentenciaTipo processedAt processingResult.charCount processingResult.pageCount processingResult.method movimientoTipo movimientoFecha url ocrStatus ocrResult.charCount category')
					.lean(),

				// Embeddings: por estado
				SentenciaCapturada.aggregate([
					{ $match: { processingStatus: 'processed' } },
					{ $group: {
						_id: '$embeddingStatus',
						count: { $sum: 1 },
						avgChunks: { $avg: '$embeddingChunksCount' },
					}},
					{ $sort: { _id: 1 } },
				]),

				// Últimas 8 indexadas en Pinecone
				SentenciaCapturada
					.find({ embeddingStatus: 'completed' })
					.sort({ embeddedAt: -1 })
					.limit(8)
					.select('number year fuero caratula sentenciaTipo embeddedAt embeddingChunksCount category')
					.lean(),

				// Últimas 5 con error de embedding
				SentenciaCapturada
					.find({ embeddingStatus: 'error' })
					.sort({ embeddedAt: -1 })
					.limit(5)
					.select('number year fuero caratula sentenciaTipo embeddingError embeddedAt')
					.lean(),

				// Novelty check: distribución por estado de verificación
				// _id=null → novelty embebidas sin noveltyCheck.status aún
				SentenciaCapturada.aggregate([
					{ $match: { category: 'novelty' } },
					{ $group: { _id: '$noveltyCheck.status', count: { $sum: 1 } } },
					{ $sort: { _id: 1 } },
				]),
			]);

			// Totales globales
			const total = byStatus.reduce((acc, s) => acc + s.count, 0);
			const totalProcessed = byStatus.find(s => s._id === 'processed')?.count || 0;
			const totalPending = byStatus.find(s => s._id === 'pending')?.count || 0;
			const totalProcessing = byStatus.find(s => s._id === 'processing')?.count || 0;
			const totalNeedsOcr = byStatus.find(s => s._id === 'extracted_needs_ocr')?.count || 0;
			const totalError = byStatus.find(s => s._id === 'error')?.count || 0;

			res.json({
				success: true,
				data: {
					totals: { total, processed: totalProcessed, pending: totalPending, processing: totalProcessing, needsOcr: totalNeedsOcr, error: totalError },
					byStatus,
					byTipo,
					byFuero,
					recientes,
					errores,
					ocr: { byStatus: ocrByStatus, recientes: ocrRecientes },
					byCategory,
					noveltyRecientes,
					embeddings: { byStatus: embeddingByStatus, recientes: embeddingRecientes, errors: embeddingErrors },
					noveltyCheck: { byStatus: noveltyCheckByStatus },
				},
			});
		} catch (error) {
			logger.error(`Error obteniendo stats de sentencias: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// GET /api/sentencias-capturadas — lista paginada con filtros
	async findAll(req, res) {
		try {
			const { status, fuero, tipo, category, page = 1, limit = 20 } = req.query;
			const filter = {};
			if (status) filter.processingStatus = status;
			if (fuero) filter.fuero = fuero;
			if (tipo) filter.sentenciaTipo = tipo;
			if (category) filter.category = category;

			const skip = (parseInt(page) - 1) * parseInt(limit);
			const [docs, total] = await Promise.all([
				SentenciaCapturada
					.find(filter)
					.sort({ detectedAt: -1 })
					.skip(skip)
					.limit(parseInt(limit))
					.select('-processingResult.text -processingLock -__v')
					.lean(),
				SentenciaCapturada.countDocuments(filter),
			]);

			res.json({ success: true, data: docs, total, page: parseInt(page), limit: parseInt(limit) });
		} catch (error) {
			logger.error(`Error listando sentencias: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// GET /api/sentencias-capturadas/:id — detalle con texto completo
	async findById(req, res) {
		try {
			const doc = await SentenciaCapturada.findById(req.params.id).select('-processingLock -__v').lean();
			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });
			res.json({ success: true, data: doc });
		} catch (error) {
			logger.error(`Error obteniendo sentencia ${req.params.id}: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// POST /api/sentencias-capturadas/:id/retry — reencolar como pending
	async retry(req, res) {
		try {
			const doc = await SentenciaCapturada.findByIdAndUpdate(
				req.params.id,
				{
					$set: { processingStatus: 'pending', retryCount: 0, processingError: null, ocrStatus: 'not_needed' },
					$unset: { processingLock: '' },
				},
				{ new: true }
			).select('-processingLock -__v');
			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });
			res.json({ success: true, message: 'Reencola como pending', data: doc });
		} catch (error) {
			logger.error(`Error reintentando sentencia ${req.params.id}: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// POST /api/sentencias-capturadas/:id/retry-embedding — reencolar para embeddings
	async retryEmbedding(req, res) {
		try {
			const doc = await SentenciaCapturada.findByIdAndUpdate(
				req.params.id,
				{ $set: { embeddingStatus: 'pending', embeddingError: null } },
				{ new: true }
			).select('-processingLock -__v');
			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });
			res.json({ success: true, message: 'Reencola para embedding', data: doc });
		} catch (error) {
			logger.error(`Error reintentando embedding de sentencia ${req.params.id}: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// POST /api/sentencias-capturadas/:id/retry-ocr — reencolar para OCR
	async retryOcr(req, res) {
		try {
			const doc = await SentenciaCapturada.findByIdAndUpdate(
				req.params.id,
				{
					$set: { processingStatus: 'extracted_needs_ocr', ocrStatus: 'pending', ocrAttempts: 0, 'ocrResult.error': null },
					$unset: { processingLock: '' },
				},
				{ new: true }
			).select('-processingLock -__v');
			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });
			res.json({ success: true, message: 'Reencola para OCR', data: doc });
		} catch (error) {
			logger.error(`Error reintentando OCR de sentencia ${req.params.id}: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// GET /api/sentencias-capturadas/publication-queue — sentencias novelty listas para publicar
	async getPublicationQueue(req, res) {
		try {
			const page   = Math.max(0, parseInt(req.query.page  || '0', 10));
			const limit  = Math.min(50, parseInt(req.query.limit || '20', 10));
			const fuero  = req.query.fuero;
			const tipo   = req.query.tipo;
			const status = ['pending', 'skipped', 'published'].includes(req.query.publicationStatus)
				? req.query.publicationStatus
				: 'pending';

			const filter = {
				category:          'novelty',
				embeddingStatus:   'completed',
				publicationStatus: status,
			};
			if (fuero) filter.fuero = fuero;
			if (tipo)  filter.sentenciaTipo = tipo;

			const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
			const sort = status === 'published' ? { publishedAt: sortOrder } : { movimientoFecha: sortOrder };

			const [docs, total] = await Promise.all([
				SentenciaCapturada.find(filter)
					.sort(sort)
					.skip(page * limit)
					.limit(limit)
					.select('causaId fuero caratula juzgado sentenciaTipo movimientoFecha movimientoDetalle url tipoDoc embeddedAt noveltyCheck publicationStatus publishedAt publicationNotes aiSummary detectedAt')
					.lean(),
				SentenciaCapturada.countDocuments(filter),
			]);

			res.json({ success: true, data: docs, total, page, limit });
		} catch (error) {
			logger.error(`Error obteniendo publication queue: ${error.message}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// PATCH /api/sentencias-capturadas/:id/publication — actualizar estado de publicación
	async updatePublicationStatus(req, res) {
		try {
			const { status, notes } = req.body;
			if (!['published', 'skipped', 'pending'].includes(status)) {
				return res.status(400).json({ success: false, message: "status debe ser 'published', 'skipped' o 'pending'" });
			}

			const update = {
				$set: {
					publicationStatus: status,
					publicationNotes:  notes || null,
					...(status === 'published' ? { publishedAt: new Date() } : {}),
				},
			};

			const doc = await SentenciaCapturada.findByIdAndUpdate(req.params.id, update, { new: true })
				.select('causaId fuero caratula sentenciaTipo publicationStatus publishedAt publicationNotes');

			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

			logger.info(`Sentencia ${req.params.id} marcada como ${status} por usuario ${req.userId}`);
			res.json({ success: true, message: `Sentencia marcada como ${status}`, data: doc });
		} catch (error) {
			logger.error(`Error actualizando publicationStatus: ${error.message}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// POST /api/sentencias-capturadas/:id/summary — generar resumen con IA
	async generateSummary(req, res) {
		try {
			const doc = await SentenciaCapturada.findById(req.params.id)
				.select('caratula fuero sentenciaTipo movimientoFecha juzgado sala processingStatus processingResult ocrStatus ocrResult aiSummary')
				.lean();

			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

			// Obtener el texto del documento
			const text = (doc.ocrStatus === 'completed' && doc.ocrResult?.text)
				? doc.ocrResult.text
				: doc.processingResult?.text;

			if (!text || text.trim().length < 100) {
				return res.status(422).json({ success: false, message: 'El documento no tiene texto extraído disponible para resumir' });
			}

			const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n\n[Texto truncado por longitud]' : text;

			// Contexto del caso para el prompt
			const fueroLabel = { CIV: 'Civil', CSS: 'Seguridad Social', CNT: 'Trabajo', COM: 'Comercial' }[doc.fuero] || doc.fuero;
			const tipoLabel = {
				primera_instancia: 'Primera Instancia', camara: 'Cámara', interlocutoria: 'Interlocutoria',
				honorarios: 'Honorarios', definitiva: 'Definitiva', resolucion: 'Resolución', otro: 'Otro',
			}[doc.sentenciaTipo] || doc.sentenciaTipo;

			const userMessage = [
				`**Expediente:** ${doc.caratula || 'Sin carátula'}`,
				`**Fuero:** ${fueroLabel}`,
				`**Tipo de resolución:** ${tipoLabel}`,
				doc.juzgado   ? `**Juzgado:** ${doc.juzgado}` : null,
				doc.sala      ? `**Sala:** ${doc.sala}`        : null,
				doc.movimientoFecha ? `**Fecha:** ${new Date(doc.movimientoFecha).toLocaleDateString('es-AR')}` : null,
				'',
				'**Texto del fallo:**',
				truncated,
			].filter(Boolean).join('\n');

			const openai = getOpenAI();
			const completion = await openai.chat.completions.create({
				model:       'gpt-4o-mini',
				max_tokens:  1500,
				temperature: 0.3,
				messages: [
					{ role: 'system', content: SUMMARY_SYSTEM_PROMPT },
					{ role: 'user',   content: userMessage },
				],
			});

			const content = completion.choices[0]?.message?.content || '';
			const model   = completion.model;

			const updated = await SentenciaCapturada.findByIdAndUpdate(
				req.params.id,
				{ $set: { aiSummary: { content, status: 'draft', generatedAt: new Date(), model } } },
				{ new: true }
			).select('aiSummary');

			logger.info({ id: req.params.id, model, chars: content.length }, 'AI summary generated');
			res.json({ success: true, data: updated.aiSummary });
		} catch (error) {
			logger.error(`Error generando resumen IA: ${error.message}`);
			res.status(500).json({ success: false, message: 'Error al generar resumen', error: error.message });
		}
	},

	// PATCH /api/sentencias-capturadas/:id/summary — aprobar o editar resumen
	async saveSummary(req, res) {
		try {
			const { content, action } = req.body; // action: 'approve' | 'save'
			if (!content || typeof content !== 'string') {
				return res.status(400).json({ success: false, message: 'content requerido' });
			}

			const set = {
				'aiSummary.content':     content,
				'aiSummary.status':      action === 'approve' ? 'approved' : 'draft',
				...(action === 'approve' ? { 'aiSummary.approvedAt': new Date() } : {}),
			};

			const doc = await SentenciaCapturada.findByIdAndUpdate(req.params.id, { $set: set }, { new: true })
				.select('aiSummary');

			if (!doc) return res.status(404).json({ success: false, message: 'No encontrado' });

			logger.info({ id: req.params.id, action }, 'AI summary saved');
			res.json({ success: true, data: doc.aiSummary });
		} catch (error) {
			logger.error(`Error guardando resumen IA: ${error.message}`);
			res.status(500).json({ success: false, message: 'Error al guardar resumen', error: error.message });
		}
	},
};

module.exports = sentenciasCapturadasController;
