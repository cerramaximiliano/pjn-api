'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema(
	{
		name: { type: String, default: 'sentencias-semantic', unique: true },
		enabled: { type: Boolean, default: true },
		minCorpusSize: { type: Number, default: 5000, min: 1 },
		similarityThreshold: { type: Number, default: 0.88, min: 0, max: 1 },
		filterByFuero: { type: Boolean, default: true },
		filterBySentenciaTipo: { type: Boolean, default: true },
		topK: { type: Number, default: 10, min: 1, max: 100 },
		batchSize: { type: Number, default: 10, min: 1, max: 100 },
		cronPattern: { type: String, default: '*/10 * * * *' },
		currentState: {
			isRunning:       { type: Boolean, default: false },
			workerId:        { type: String },
			lastRunAt:       { type: Date },
			lastRunDoubles:  { type: Number, default: 0 },
			lastRunRejected: { type: Number, default: 0 },
		},
	},
	{
		collection: 'configuracion-semantic-worker',
		timestamps: true,
	}
);

module.exports = mongoose.model('ConfiguracionSemanticWorker', schema);
