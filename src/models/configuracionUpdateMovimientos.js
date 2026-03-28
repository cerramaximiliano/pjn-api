const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Configuración del worker update-movimientos (pjn-workers-scraping).
 * Refleja el mismo schema de /pjn-workers-scraping/src/models/ConfiguracionUpdateMovimientos.js
 * Un documento por fuero activo.
 */
const schema = new Schema(
	{
		worker_id: { type: String, required: true, unique: true },
		fuero: { type: String, enum: ['CIV', 'CSS', 'CNT', 'COM'], required: true },
		enabled: { type: Boolean, default: false },
		lockTimeoutMinutes: { type: Number, default: 5 },
		errorCooldown: {
			enabled: { type: Boolean, default: true },
			maxConsecutiveErrors: { type: Number, default: 3 },
			cooldownHours: { type: Number, default: 6 },
		},
		captcha: {
			defaultProvider: { type: String, enum: ['2captcha', 'capsolver'], default: 'capsolver' },
			fallbackEnabled: { type: Boolean, default: true },
			apiKeys: {
				twocaptcha: { key: { type: String, default: '' }, enabled: { type: Boolean, default: false } },
				capsolver: { key: { type: String, default: '' }, enabled: { type: Boolean, default: true } },
			},
			minimumBalance: { type: Number, default: 0.5 },
		},
		updateProgress: {
			totalEligible: { type: Number, default: 0 },
			processedToday: { type: Number, default: 0 },
			lastEligibleCalculation: { type: Date },
			currentCycleStart: { type: Date },
			completionPercentage: { type: Number, default: 0 },
		},
		stats: {
			totalProcessed: { type: Number, default: 0 },
			totalSuccess: { type: Number, default: 0 },
			totalFailed: { type: Number, default: 0 },
			totalNewMovimientos: { type: Number, default: 0 },
			lastRun: { type: Date },
			lastSuccessfulRun: { type: Date },
		},
		statsToday: {
			date: { type: String },
			processed: { type: Number, default: 0 },
			success: { type: Number, default: 0 },
			failed: { type: Number, default: 0 },
			newMovimientos: { type: Number, default: 0 },
		},
	},
	{ collection: 'configuracion-update-movimientos', timestamps: true }
);

module.exports = mongoose.model('ConfiguracionUpdateMovimientos', schema);
