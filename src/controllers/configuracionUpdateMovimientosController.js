const ConfiguracionUpdateMovimientos = require('../models/configuracionUpdateMovimientos');
const ConfiguracionUpdateMovimientosManager = require('../models/configuracionUpdateMovimientosManager');
const { logger } = require('../config/pino');

const ALLOWED_WORKER_FIELDS = [
	'enabled',
	'lockTimeoutMinutes',
	'errorCooldown.enabled',
	'errorCooldown.maxConsecutiveErrors',
	'errorCooldown.cooldownHours',
	'captcha.defaultProvider',
	'captcha.fallbackEnabled',
	'captcha.apiKeys.twocaptcha.key',
	'captcha.apiKeys.twocaptcha.enabled',
	'captcha.apiKeys.capsolver.key',
	'captcha.apiKeys.capsolver.enabled',
	'captcha.minimumBalance',
];

const ALLOWED_MANAGER_FIELDS = [
	'config.checkInterval',
	'config.maxWorkers',
	'config.minWorkers',
	'config.scaleThreshold',
	'config.scaleDownThreshold',
	'config.cpuThreshold',
	'config.memoryThreshold',
	'config.workStartHour',
	'config.workEndHour',
	'config.workDays',
	'config.fueros',
];

const configuracionUpdateMovimientosController = {
	// ── Worker configs (uno por fuero) ────────────────────────────────────────

	async findAll(req, res) {
		try {
			const configs = await ConfiguracionUpdateMovimientos.find({})
				.select('-__v')
				.sort({ fuero: 1 });

			res.json({
				success: true,
				count: configs.length,
				data: configs,
			});
		} catch (error) {
			logger.error(`Error obteniendo configuraciones update-movimientos: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	async updateById(req, res) {
		try {
			const { id } = req.params;
			const body = req.body;

			// Construir objeto $set solo con campos permitidos (soporte dot-notation)
			const setData = {};
			for (const field of ALLOWED_WORKER_FIELDS) {
				const keys = field.split('.');
				let val = body;
				for (const k of keys) {
					if (val == null || typeof val !== 'object') { val = undefined; break; }
					val = val[k];
				}
				if (val !== undefined) setData[field] = val;
			}

			if (Object.keys(setData).length === 0) {
				return res.status(400).json({ success: false, message: 'No se enviaron campos válidos para actualizar' });
			}

			const config = await ConfiguracionUpdateMovimientos.findByIdAndUpdate(
				id,
				{ $set: setData },
				{ new: true, runValidators: true }
			).select('-__v');

			if (!config) {
				return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
			}

			res.json({ success: true, message: 'Configuración actualizada', data: config });
		} catch (error) {
			logger.error(`Error actualizando configuración update-movimientos: ${error}`);
			if (error.name === 'ValidationError') {
				return res.status(400).json({ success: false, message: 'Error de validación', error: error.message });
			}
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	// ── Manager config ─────────────────────────────────────────────────────────

	async getManagerConfig(req, res) {
		try {
			let doc = await ConfiguracionUpdateMovimientosManager.findOne({ name: 'update-movimientos-manager' }).select('-__v');
			if (!doc) {
				doc = await ConfiguracionUpdateMovimientosManager.findOneAndUpdate(
					{ name: 'update-movimientos-manager' },
					{ $setOnInsert: { name: 'update-movimientos-manager', config: {}, currentState: {} } },
					{ upsert: true, new: true }
				);
			}
			res.json({ success: true, data: doc });
		} catch (error) {
			logger.error(`Error obteniendo manager config update-movimientos: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},

	async updateManagerConfig(req, res) {
		try {
			const body = req.body;

			const setData = {};
			for (const field of ALLOWED_MANAGER_FIELDS) {
				const keys = field.split('.');
				let val = body;
				for (const k of keys) {
					if (val == null || typeof val !== 'object') { val = undefined; break; }
					val = val[k];
				}
				if (val !== undefined) setData[field] = val;
			}

			// También soportar body.config aplanado directamente
			if (body.config && typeof body.config === 'object') {
				for (const [k, v] of Object.entries(body.config)) {
					const fullKey = `config.${k}`;
					if (ALLOWED_MANAGER_FIELDS.includes(fullKey)) {
						setData[fullKey] = v;
					}
				}
			}

			if (Object.keys(setData).length === 0) {
				return res.status(400).json({ success: false, message: 'No se enviaron campos válidos para actualizar' });
			}

			const doc = await ConfiguracionUpdateMovimientosManager.findOneAndUpdate(
				{ name: 'update-movimientos-manager' },
				{ $set: setData },
				{ new: true, runValidators: true, upsert: true }
			).select('-__v');

			res.json({ success: true, message: 'Configuración del manager actualizada', data: doc });
		} catch (error) {
			logger.error(`Error actualizando manager config update-movimientos: ${error}`);
			res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
		}
	},
};

module.exports = configuracionUpdateMovimientosController;
