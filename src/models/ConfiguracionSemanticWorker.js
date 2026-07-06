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
		// Router de consulta por prompt (planQuery con LLM). Opcional/experimental:
		// con enabled=true, POST /sentencias/ask interpreta el prompt del usuario
		// (deriva filtros juzgado/sala/fecha/tipo + estrategia). ON/OFF desde admin
		// para evaluar y desactivar si no rinde. Ver services/queryPlanner.js.
		searchQueryPlanner: {
			enabled: { type: Boolean, default: false },
			model:   { type: String, default: 'gpt-4o-mini' },
		},
		// Capa léxica: filtra por citas exactas (art/ley) usando el payload
		// `citations` de Qdrant + los lexicalTerms del planner. ON/OFF admin.
		// Ver services/citations.js + queryPlanner.js. Requiere el backfill de
		// `citations` en Qdrant para rendir sobre el corpus histórico.
		searchLexicalLayer: {
			enabled: { type: Boolean, default: false },
		},
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
