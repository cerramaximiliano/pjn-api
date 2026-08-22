'use strict';

const mongoose = require('mongoose');
const { lazyModel } = require('../config/sentenciasConnection');

/**
 * Fallo de CIJur (Centro de Información Jurídica del Ministerio Público de
 * Buenos Aires). Lo escribe `cijur-workers`; acá es de solo lectura para la UI
 * admin.
 *
 * Selección curada, no exhaustiva: ~1 fallo por mes y por canal. Complementa a
 * SAIJ, que aporta volumen crudo.
 *
 * `voces` es redacción editorial de la Procuración, no del tribunal: sirve para
 * clasificar y buscar, pero NO se republica (mismo criterio que los sumarios de
 * SAIJ). Lo publicable es el PDF y los resúmenes propios sobre su texto.
 */
const CijurFalloSchema = new mongoose.Schema(
    {
        cijurId: { type: String, trim: true },
        canal: { type: String, enum: ['PROVINCIAL', 'NACIONAL'] },

        titulo: { type: String, trim: true },
        tribunal: { type: String, trim: true },
        caratula: { type: String, trim: true },
        fecha: { type: Date },
        fechaString: { type: String, trim: true },

        voces: { type: String, trim: true },
        contenido: { type: String },

        pdfUrl: { type: String, trim: true },
        pdfNombre: { type: String, trim: true },

        textoCompleto: { type: String },
        textoSource: { type: String, trim: true },
        textoExtraidoAt: { type: Date },

        publicadoEn: { type: Date },
        publicadoEnString: { type: String, trim: true },

        paginaOrigen: { type: Number },
        url: { type: String, trim: true },

        status: { type: String, enum: ['captured', 'processing', 'error'] },
        errorMessage: { type: String },
        workerId: { type: String, trim: true },
    },
    { timestamps: true, collection: 'cijur-fallos' }
);

CijurFalloSchema.index({ cijurId: 1 }, { unique: true, sparse: true });
CijurFalloSchema.index({ canal: 1, fecha: -1 });
CijurFalloSchema.index({ canal: 1, publicadoEn: -1 });

module.exports = lazyModel('CijurFallo', CijurFalloSchema);
