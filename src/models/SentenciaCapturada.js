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

module.exports = mongoose.model('SentenciaCapturada', schema);
