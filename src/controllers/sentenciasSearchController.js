const { searchByQuery, searchBySimilarity, getChunks } = require('../services/sentenciasSearchService');
const { logger } = require('../config/pino');

const sentenciasSearchController = {

	// POST /sentencias/buscar
	async buscar(req, res) {
		try {
			const { query, filters = {}, options = {} } = req.body;

			if (!query || typeof query !== 'string' || query.trim().length < 3) {
				return res.status(400).json({
					success: false,
					message: 'El campo "query" es requerido y debe tener al menos 3 caracteres',
				});
			}

			const topK = Math.min(parseInt(options.topK) || 5, 20);
			const clientMinScore = parseFloat(options.minScore);
			const minScore = isNaN(clientMinScore) ? 0.55 : Math.min(clientMinScore, 0.60);
			const includeFullText = options.includeFullText === true;

			const result = await searchByQuery(query.trim(), { filters, topK, minScore, includeFullText });

			logger.info(
				{ query: query.trim(), topK, results: result.total, latencyMs: result.latencyMs.total },
				'[SentenciasSearch] búsqueda semántica'
			);

			res.json({
				success: true,
				...result,
				query: query.trim(),
				filters,
			});
		} catch (error) {
			logger.error({ err: error.message }, '[SentenciasSearch] error en búsqueda semántica');
			res.status(500).json({ success: false, message: 'Error al ejecutar la búsqueda', error: error.message });
		}
	},

	// POST /sentencias/buscar/similar
	async buscarSimilares(req, res) {
		try {
			const { sentenciaId, options = {} } = req.body;

			if (!sentenciaId || typeof sentenciaId !== 'string') {
				return res.status(400).json({
					success: false,
					message: 'El campo "sentenciaId" es requerido',
				});
			}

			const topK = Math.min(parseInt(options.topK) || 5, 20);
			const clientMinScore = parseFloat(options.minScore);
			const minScore = isNaN(clientMinScore) ? 0.55 : Math.min(clientMinScore, 0.60);
			const includeFullText = options.includeFullText === true;

			const result = await searchBySimilarity(sentenciaId, { topK, minScore, includeFullText });

			logger.info(
				{ sentenciaId, topK, results: result.total, latencyMs: result.latencyMs.total },
				'[SentenciasSearch] búsqueda por similitud'
			);

			res.json({ success: true, ...result });
		} catch (error) {
			if (error.message === 'Sentencia no encontrada') {
				return res.status(404).json({ success: false, message: error.message });
			}
			if (error.message === 'La sentencia no tiene embeddings indexados' ||
				error.message === 'No se encontraron chunks en S3 para esta sentencia') {
				return res.status(422).json({ success: false, message: error.message });
			}
			logger.error({ err: error.message }, '[SentenciasSearch] error en búsqueda por similitud');
			res.status(500).json({ success: false, message: 'Error al ejecutar la búsqueda', error: error.message });
		}
	},
	// GET /sentencias/:id/chunks — texto completo de una sentencia
	async getChunks(req, res) {
		try {
			const { id } = req.params;
			if (!id || typeof id !== 'string') {
				return res.status(400).json({ success: false, message: 'ID de sentencia requerido' });
			}

			const chunks = await getChunks(id);
			res.json({ success: true, chunks, total: chunks.length });
		} catch (error) {
			if (error.message === 'Sentencia no encontrada') {
				return res.status(404).json({ success: false, message: error.message });
			}
			if (error.message === 'La sentencia no tiene chunks indexados' ||
				error.message === 'No se encontraron chunks en S3 para esta sentencia') {
				return res.status(422).json({ success: false, message: error.message });
			}
			logger.error({ err: error.message }, '[SentenciasSearch] error obteniendo chunks');
			res.status(500).json({ success: false, message: 'Error al obtener el texto de la sentencia', error: error.message });
		}
	},
};

module.exports = sentenciasSearchController;
