const SentenciaCapturada = require('../models/SentenciaCapturada');
const { logger } = require('../config/pino');

const sentenciasCapturadasController = {

	// GET /api/sentencias-capturadas/stats
	async getStats(req, res) {
		try {
			const [byStatus, byTipo, byFuero, recientes, errores, ocrByStatus, ocrRecientes] = await Promise.all([
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
			const { status, fuero, tipo, page = 1, limit = 20 } = req.query;
			const filter = {};
			if (status) filter.processingStatus = status;
			if (fuero) filter.fuero = fuero;
			if (tipo) filter.sentenciaTipo = tipo;

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
};

module.exports = sentenciasCapturadasController;
