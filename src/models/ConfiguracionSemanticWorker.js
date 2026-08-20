'use strict';

const mongoose = require('mongoose');
const { lazyModel } = require('../config/sentenciasConnection');

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
		// Corpus habilitado para la búsqueda semántica, POR CONSUMIDOR:
		//   'saij' = solo el corpus curado público (~10k fallos SAIJ con resumen,
		//            mismo universo que /jurisprudencia pública)
		//   'all'  = todo el corpus embebido (~320k, incluye sentencias PJN
		//            capturadas de causas de usuarios)
		// Lo lee pjn-rag-api en caliente (cache 30s) y lo ENFUERZA server-side:
		// el cliente puede acotar más, nunca ampliar. 'app' gobierna la vista
		// in-app de law-analytics-front; 'mcp' el tool search_sentencias de
		// la-mcp-server (Claude.ai / IA externas).
		searchCorpus: {
			app: { type: String, enum: ['saij', 'all'], default: 'saij' },
			mcp: { type: String, enum: ['saij', 'all'], default: 'saij' },
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

// Registrado sobre la conexión de sentencias (SENTENCIAS_MONGO_URI || URLDB):
// la colección migra junto con el resto del subsistema de sentencias al rs0.
module.exports = lazyModel('ConfiguracionSemanticWorker', schema);
