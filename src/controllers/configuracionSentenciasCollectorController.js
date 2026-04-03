'use strict';

const ConfiguracionSentenciasCollector = require('../models/ConfiguracionSentenciasCollector');
const { logger } = require('../config/pino');

const ALLOWED_FIELDS = [
	'enabled',
	'cronPattern',
	'batchSize',
	'maxPendingQueue',
	'aiSummary.systemPrompt',
	'aiSummary.model',
];

const ALLOWED_FUERO_FIELDS = ['enabled', 'yearFrom', 'yearTo', 'collection'];

const configuracionSentenciasCollectorController = {

	async getConfig(req, res) {
		try {
			let config = await ConfiguracionSentenciasCollector.findOne({ name: 'sentencias-collector' }).select('-__v');
			if (!config) {
				config = await ConfiguracionSentenciasCollector.create({ name: 'sentencias-collector' });
			}
			res.json({ success: true, data: config });
		} catch (error) {
			logger.error(`Error obteniendo config sentencias-collector: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	async updateConfig(req, res) {
		try {
			const body = req.body;
			const setData = {};

			for (const field of ALLOWED_FIELDS) {
				// Soporta tanto flat ('enabled') como dot-notation ('aiSummary.systemPrompt')
				const value = field.includes('.')
					? field.split('.').reduce((obj, k) => obj?.[k], body)
					: body[field];
				if (value !== undefined) setData[field] = value;
			}

			// Actualización de fueros individuales: body.fueros[].{enabled,yearFrom,yearTo,collection}
			if (Array.isArray(body.fueros)) {
				for (const fueroUpdate of body.fueros) {
					if (!fueroUpdate.fuero) continue;
					for (const field of ALLOWED_FUERO_FIELDS) {
						if (fueroUpdate[field] !== undefined) {
							setData[`fueros.$[el].${field}`] = fueroUpdate[field];
						}
					}
				}
			}

			if (Object.keys(setData).length === 0) {
				return res.status(400).json({ success: false, message: 'No se enviaron campos válidos para actualizar' });
			}

			// Si hay updates de fueros, necesitamos arrayFilters
			const hasFueroUpdates = Array.isArray(body.fueros) && body.fueros.length > 0;

			let config;
			if (hasFueroUpdates) {
				// Actualizar cada fuero por separado para simplicidad
				config = await ConfiguracionSentenciasCollector.findOne({ name: 'sentencias-collector' });
				if (!config) return res.status(404).json({ success: false, message: 'Configuración no encontrada' });

				// Aplicar campos globales
				for (const field of ALLOWED_FIELDS) {
					if (body[field] !== undefined) config[field] = body[field];
				}

				// Aplicar cambios por fuero
				for (const fueroUpdate of body.fueros) {
					if (!fueroUpdate.fuero) continue;
					const fueroDoc = config.fueros.find(f => f.fuero === fueroUpdate.fuero);
					if (!fueroDoc) continue;
					for (const field of ALLOWED_FUERO_FIELDS) {
						if (fueroUpdate[field] !== undefined) fueroDoc[field] = fueroUpdate[field];
					}
				}

				await config.save();
			} else {
				config = await ConfiguracionSentenciasCollector.findOneAndUpdate(
					{ name: 'sentencias-collector' },
					{ $set: setData },
					{ new: true, runValidators: true }
				).select('-__v');
				if (!config) return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
			}

			res.json({ success: true, message: 'Configuración actualizada', data: config });
		} catch (error) {
			logger.error(`Error actualizando config sentencias-collector: ${error}`);
			if (error.name === 'ValidationError') {
				return res.status(400).json({ success: false, message: 'Error de validación', error: error.message });
			}
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	async resetFueroCursor(req, res) {
		try {
			const { fuero } = req.params;
			const validFueros = ['CIV', 'CSS', 'CNT', 'COM'];
			if (!validFueros.includes(fuero)) {
				return res.status(400).json({ success: false, message: `Fuero inválido. Debe ser uno de: ${validFueros.join(', ')}` });
			}

			const config = await ConfiguracionSentenciasCollector.findOneAndUpdate(
				{ name: 'sentencias-collector', 'fueros.fuero': fuero },
				{
					$set: {
						'fueros.$.lastScannedId': null,
						'fueros.$.completedFullScan': false,
					},
				},
				{ new: true }
			).select('-__v');

			if (!config) return res.status(404).json({ success: false, message: 'Configuración no encontrada' });

			res.json({ success: true, message: `Cursor del fuero ${fuero} reiniciado`, data: config });
		} catch (error) {
			logger.error(`Error reseteando cursor fuero ${req.params.fuero}: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	async resetAllCursors(req, res) {
		try {
			const config = await ConfiguracionSentenciasCollector.findOne({ name: 'sentencias-collector' });
			if (!config) return res.status(404).json({ success: false, message: 'Configuración no encontrada' });

			for (const fueroDoc of config.fueros) {
				fueroDoc.lastScannedId = null;
				fueroDoc.completedFullScan = false;
			}
			await config.save();

			res.json({ success: true, message: 'Todos los cursores reiniciados', data: config });
		} catch (error) {
			logger.error(`Error reseteando todos los cursores: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},
};

module.exports = configuracionSentenciasCollectorController;
