'use strict';

const mongoose = require('mongoose');

const fueroConfigSchema = new mongoose.Schema(
	{
		fuero: { type: String, enum: ['CIV', 'CSS', 'CNT', 'COM'], required: true },
		enabled: { type: Boolean, default: false },
		collection: { type: String },
		yearFrom: { type: Number, default: 2020 },
		yearTo: { type: Number, default: new Date().getFullYear() },
		lastScannedId: { type: mongoose.Schema.Types.ObjectId, default: null },
		totalScanned: { type: Number, default: 0 },
		totalEnqueued: { type: Number, default: 0 },
		completedFullScan: { type: Boolean, default: false },
		lastScanCompletedAt: { type: Date },
	},
	{ _id: false }
);

const schema = new mongoose.Schema(
	{
		name: { type: String, default: 'sentencias-collector', unique: true },
		enabled: { type: Boolean, default: false },
		cronPattern: { type: String, default: '*/10 * * * *' },
		batchSize: { type: Number, default: 100 },
		maxPendingQueue: { type: Number, default: 50 },
		fueros: { type: [fueroConfigSchema], default: () => [
			{ fuero: 'CIV', enabled: false, collection: 'causas-civil', yearFrom: 2020, yearTo: new Date().getFullYear() },
			{ fuero: 'CSS', enabled: false, collection: 'causas-segsocial', yearFrom: 2020, yearTo: new Date().getFullYear() },
			{ fuero: 'CNT', enabled: false, collection: 'causas-trabajo', yearFrom: 2020, yearTo: new Date().getFullYear() },
			{ fuero: 'COM', enabled: false, collection: 'causas-comercial', yearFrom: 2020, yearTo: new Date().getFullYear() },
		]},
		currentState: {
			isRunning: { type: Boolean, default: false },
			workerId: { type: String },
			startedAt: { type: Date },
			currentFuero: { type: String },
		},
		stats: {
			lastRunAt: { type: Date },
			lastRunEnqueued: { type: Number, default: 0 },
			lastRunScanned: { type: Number, default: 0 },
			totalEnqueuedAllTime: { type: Number, default: 0 },
			totalScannedAllTime: { type: Number, default: 0 },
		},
	},
	{
		collection: 'configuracion-sentencias-collector',
		timestamps: true,
	}
);

module.exports = mongoose.model('ConfiguracionSentenciasCollector', schema);
