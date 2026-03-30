'use strict';

const ConfiguracionSemanticWorker = require('../models/ConfiguracionSemanticWorker');
const { logger } = require('../config/pino');

const ALLOWED_FIELDS = [
	'enabled',
	'minCorpusSize',
	'similarityThreshold',
	'filterByFuero',
	'filterBySentenciaTipo',
	'topK',
	'batchSize',
	'cronPattern',
];

const configuracionSemanticWorkerController = {

	async getConfig(req, res) {
		try {
			let config = await ConfiguracionSemanticWorker.findOne({ name: 'sentencias-semantic' }).select('-__v');
			if (!config) {
				config = await ConfiguracionSemanticWorker.create({ name: 'sentencias-semantic' });
			}
			res.json({ success: true, data: config });
		} catch (error) {
			logger.error(`Error obteniendo config semantic-worker: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	async updateConfig(req, res) {
		try {
			const setData = {};
			for (const field of ALLOWED_FIELDS) {
				if (req.body[field] !== undefined) setData[field] = req.body[field];
			}

			if (Object.keys(setData).length === 0) {
				return res.status(400).json({ success: false, message: 'No se enviaron campos válidos para actualizar' });
			}

			const config = await ConfiguracionSemanticWorker.findOneAndUpdate(
				{ name: 'sentencias-semantic' },
				{ $set: setData },
				{ new: true, runValidators: true, upsert: true }
			).select('-__v');

			res.json({ success: true, message: 'Configuración actualizada', data: config });
		} catch (error) {
			logger.error(`Error actualizando config semantic-worker: ${error}`);
			if (error.name === 'ValidationError') {
				return res.status(400).json({ success: false, message: 'Error de validación', error: error.message });
			}
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},
};

module.exports = configuracionSemanticWorkerController;
