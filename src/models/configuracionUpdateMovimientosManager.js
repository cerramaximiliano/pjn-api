const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Configuración del manager de update-movimientos (pjn-workers-scraping).
 * Refleja el schema de update-movimientos-manager.js.
 * Un único documento con name='update-movimientos-manager'.
 */
const schema = new Schema(
	{
		name: { type: String, unique: true, default: 'update-movimientos-manager' },
		config: {
			checkInterval: { type: Number, default: 60000 },
			maxWorkers: { type: Number, default: 3 },
			minWorkers: { type: Number, default: 0 },
			scaleThreshold: { type: Number, default: 100 },
			scaleDownThreshold: { type: Number, default: 10 },
			cpuThreshold: { type: Number, default: 0.75 },
			memoryThreshold: { type: Number, default: 0.80 },
			workStartHour: { type: Number, default: 7 },
			workEndHour: { type: Number, default: 23 },
			workDays: { type: [Number], default: [1, 2, 3, 4, 5] },
			fueros: { type: [String], default: ['CIV'] },
		},
		currentState: { type: Schema.Types.Mixed, default: {} },
	},
	{ collection: 'configuracion-update-movimientos-manager', timestamps: true }
);

module.exports = mongoose.model('ConfiguracionUpdateMovimientosManager', schema);
