const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { lazyModel } = require('../config/sentenciasConnection');

/**
 * SaijConciliacion
 *
 * Cola de revisión de apareos SAIJ ↔ causas PJN.
 *
 * El apareo se hacía sólo por (fuero, número, año) y eso alcanza para colgar un
 * fallo de la causa equivocada: el número se repite entre fueros y el parser
 * del PDF a veces toma el expediente de una cita del cuerpo. La auditoría del
 * 2026-08-31 sobre 10.798 causas apareadas encontró 159 sospechosas, de las
 * cuales 130 tenían nombres completos en ambos lados y cero palabras en común.
 *
 * Un documento por par (causa, fallo). Lo puebla el escaneo
 * (`POST /saij/conciliacion/escanear`) y lo resuelve una persona desde la vista
 * de conciliación del admin.
 *
 * Vive en rs0/law_analytics, la misma base que las causas del caché,
 * `saij-sentencias` y `sentencias-capturadas`. Se registra sobre la conexión
 * del corpus (sentenciasConnection) y NO sobre la default: pjn-api es dual
 * (hub → Atlas, worker_01 → local) y la conciliación debe operar sobre rs0
 * desde cualquiera de las dos instancias — la UI admin habla con la del hub.
 */
const schema = new Schema(
	{
		// ── Lado causa ───────────────────────────────────────────────────────
		causaId: { type: Schema.Types.ObjectId, required: true, index: true },
		causaCollection: { type: String, required: true }, // 'causas-civil' | …
		fuero: { type: String, required: true, index: true },
		number: { type: String },
		year: { type: String },
		caratulaCausa: { type: String },
		causaSource: { type: String },   // 'scraping' | 'cache' | 'app'
		causaVerified: { type: Boolean },
		// Shell creada por SAIJ (todos sus movimientos son 'SENTENCIA SAIJ').
		// Su carátula viene del propio fallo, así que la similitud es ~1 por
		// construcción y no aporta señal: se guardan para poder revisarlas,
		// pero no cuentan como sospechosas.
		esShell: { type: Boolean, default: false },

		// ── Lado fallo ───────────────────────────────────────────────────────
		saijDocId: { type: Schema.Types.ObjectId, required: true, index: true },
		caratulaFallo: { type: String },
		saijUrl: { type: String },
		expedienteFallo: {
			numero: Number,
			año: Number,
			fuero: String,
			confidence: String,   // high | medium | low
			source: String,       // pdf-encabezado | metadata | url | manual
		},

		// ── Veredicto del comparador ─────────────────────────────────────────
		veredicto: {
			type: String,
			enum: ['coincide', 'no_coincide', 'indeterminado'],
			index: true,
		},
		jaccard: { type: Number },
		containment: { type: Number },
		objetoJaccard: { type: Number },
		// CARATULA | FUERO | NUMERO | ANIO | INSTANCIA | CARATULA_PLACEHOLDER |
		// FALLO_ANONIMIZADO | SIN_COMPARABLE
		flags: [{ type: String }],
		sospechoso: { type: Boolean, default: false, index: true },

		// ── Resolución manual ────────────────────────────────────────────────
		estado: {
			type: String,
			enum: ['pendiente', 'confirmado', 'desvinculado', 'reapareado', 'ignorado'],
			default: 'pendiente',
			index: true,
		},
		resueltoPor: { type: String },   // email del admin
		resueltoAt: { type: Date },
		notas: { type: String },
		// Qué se hizo efectivamente al resolver, para poder auditar y revertir.
		resultado: {
			movimientoQuitado: { type: Boolean },
			sentenciasCapturadasTocadas: { type: Number },
			embeddingReencolado: { type: Number },
			causaNueva: { type: Schema.Types.ObjectId },
			backupId: { type: Schema.Types.ObjectId },
		},

		detectadoAt: { type: Date, default: Date.now },
		escaneoId: { type: String, index: true }, // agrupa los hallazgos de una corrida
	},
	{
		collection: 'saij-conciliacion',
		timestamps: true,
	}
);

// Un par (causa, fallo) es único: re-escanear actualiza, no duplica.
schema.index({ causaId: 1, saijDocId: 1 }, { unique: true });
// Query principal de la vista: pendientes sospechosas, peores primero.
schema.index({ estado: 1, sospechoso: 1, jaccard: 1 });

module.exports = lazyModel('SaijConciliacion', schema);
