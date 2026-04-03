const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const schema = new Schema(
	{
		causaId: { type: Schema.Types.ObjectId, required: true },
		number: { type: Number, required: true },
		year: { type: Number, required: true },
		fuero: { type: String, enum: ['CIV', 'CSS', 'CNT', 'COM'], required: true },
		caratula: { type: String },
		juzgado: { type: Number },
		secretaria: { type: Number },
		sala: { type: Number },
		organizacionTextoCompleto: { type: String },

		movimientoFecha: { type: Date },
		movimientoTipo: { type: String },
		movimientoDetalle: { type: String },
		url: { type: String, required: true },
		tipoDoc: { type: String },

		sentenciaTipo: {
			type: String,
			enum: ['primera_instancia', 'camara', 'interlocutoria', 'honorarios', 'definitiva', 'resolucion', 'otro'],
			default: 'otro',
		},

		category: { type: String, enum: ['novelty', 'rutina'], default: 'novelty' },
		source: {
			worker: { type: String },
			collectionName: { type: String },
			collectedAt: { type: Date },
		},

		detectedAt: { type: Date, default: Date.now },
		workerVersion: { type: String, default: '1.0' },
		collection: { type: String },

		processingLock: {
			workerId: { type: String },
			lockedAt: { type: Date },
			expiresAt: { type: Date },
		},

		processingStatus: {
			type: String,
			enum: ['pending', 'processing', 'extracted_needs_ocr', 'processed', 'error'],
			default: 'pending',
		},
		processedAt: { type: Date },
		processingError: { type: String },
		processingResult: { type: Schema.Types.Mixed },
		retryCount: { type: Number, default: 0 },

		ocrStatus: {
			type: String,
			enum: ['not_needed', 'pending', 'processing', 'completed', 'error'],
			default: 'not_needed',
		},
		ocrAttempts: { type: Number, default: 0 },
		ocrResult: {
			processedAt: { type: Date },
			text: { type: String },
			charCount: { type: Number },
			pageCount: { type: Number },
			method: { type: String },
			processingTimeMs: { type: Number },
			error: { type: String },
		},

		// Estado de indexación en Pinecone (embeddings)
		embeddingStatus: {
			type: String,
			enum: ['pending', 'processing', 'completed', 'error', 'skipped'],
			default: 'pending',
		},
		embeddedAt: { type: Date },
		embeddingError: { type: String },
		embeddingChunksCount: { type: Number, default: 0 },

		// Verificación de novedad (doble capa)
		// Layer 1 (estructural): category='novelty' + embedding completado → status='single'
		// Layer 2 (semántica, futuro): búsqueda cosine en Pinecone → status='double' | 'rejected'
		noveltyCheck: {
			status: {
				type: String,
				enum: ['single', 'double', 'rejected', 'pending_semantic'],
			},
			semanticScore: { type: Number },
			semanticTopMatchId: { type: String },
			verifiedAt: { type: Date },
			semanticVerifiedAt: { type: Date },
		},

		// Resumen generado por IA para publicación
		aiSummary: {
			content:     { type: String },
			status:      { type: String, enum: ['draft', 'approved'] },
			generatedAt: { type: Date },
			approvedAt:  { type: Date },
			model:       { type: String },
		},

		// Estado de publicación (solo relevante para category='novelty')
		publicationStatus: {
			type: String,
			enum: ['pending', 'published', 'skipped'],
		},
		publishedAt: { type: Date },
		publicationNotes: { type: String },

		processingHistory: [
			{
				status: { type: String },
				at: { type: Date },
				method: { type: String },
				notes: { type: String },
			},
		],
	},
	{
		collection: 'sentencias-capturadas',
		timestamps: true,
	}
);

schema.index({ causaId: 1, url: 1 }, { unique: true });
schema.index({ fuero: 1, sentenciaTipo: 1, processingStatus: 1 });
schema.index({ detectedAt: -1 });
schema.index({ processedAt: -1 });
schema.index({ ocrStatus: 1, processingStatus: 1 });
schema.index({ 'noveltyCheck.status': 1, category: 1 });
schema.index({ publicationStatus: 1, category: 1, embeddingStatus: 1 });

module.exports = mongoose.model('SentenciaCapturada', schema);
