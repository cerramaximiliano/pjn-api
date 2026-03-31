'use strict';

const mongoose = require('mongoose');

const SaijSentenciaSchema = new mongoose.Schema(
    {
        saijId:           { type: String, trim: true },
        saijType:         { type: String, enum: ['jurisprudencia', 'sumario'], trim: true },
        url:              { type: String, trim: true },
        pdfUrl:           { type: String, trim: true },

        // jurisprudencia
        numeroFallo:      { type: String, trim: true },
        tipoFallo:        { type: String, trim: true },
        actor:            { type: String, trim: true },
        demandado:        { type: String, trim: true },
        sobre:            { type: String, trim: true },
        sumarios:         { type: [String], default: [] },

        // sumario
        numeroSumario:    { type: String, trim: true },
        texto:            { type: String, trim: true },

        // comunes
        titulo:           { type: String, trim: true },
        fecha:            { type: Date },
        fechaString:      { type: String, trim: true },
        fechaUmod:        { type: String, trim: true },
        tribunal:         { type: String, trim: true },
        tipoTribunal:     { type: String, trim: true },
        jurisdiccion: {
            codigo:       { type: String, trim: true },
            descripcion:  { type: String, trim: true },
            capital:      { type: String, trim: true },
            idPais:       { type: Number },
        },
        descriptores:     { type: [String], default: [] },

        saijSentenciaId:  { type: String, trim: true },
        saijSentenciaUrl: { type: String, trim: true },

        source:           { type: String, default: 'saij' },
        workerId:         { type: String, trim: true },
        scrapedAt:        { type: Date, default: Date.now },

        status: {
            type: String,
            enum: ['captured', 'processing', 'processed', 'error', 'duplicate'],
            default: 'captured',
        },
        errorMessage:     { type: String, trim: true },
        retryCount:       { type: Number, default: 0 },
    },
    {
        timestamps: true,
        collection: 'saij-sentencias',
    }
);

SaijSentenciaSchema.index({ saijId: 1 }, { sparse: true });
SaijSentenciaSchema.index({ numeroSumario: 1 }, { sparse: true });
SaijSentenciaSchema.index({ status: 1 });
SaijSentenciaSchema.index({ fecha: -1 });
SaijSentenciaSchema.index({ tribunal: 1 });
SaijSentenciaSchema.index({ saijType: 1 });
SaijSentenciaSchema.index({ workerId: 1, status: 1 });
SaijSentenciaSchema.index({ titulo: 'text', texto: 'text', sobre: 'text' });

module.exports = mongoose.model('SaijSentencia', SaijSentenciaSchema);
