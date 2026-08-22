'use strict';

const mongoose = require('mongoose');
const { lazyModel } = require('../config/sentenciasConnection');

/**
 * Config del worker de CIJur. La escribe `cijur-workers` (que la relee en cada
 * ciclo) y la edita la UI admin, así que el schema debe reflejar TODOS los
 * campos: con `.lean()` sobre un modelo Mongoose, lo que no está declarado se
 * descarta en silencio — fue lo que dejó a la UI de SAIJ sin ver `jurisdiccion`.
 */
const ConfiguracionCijurSchema = new mongoose.Schema(
    {
        worker_id: { type: String, trim: true },
        enabled: { type: Boolean, default: false },

        scraping: {
            canales: { type: [String], enum: ['PROVINCIAL', 'NACIONAL'], default: ['PROVINCIAL', 'NACIONAL'] },
            cronPattern: { type: String, default: '0 10 * * *' },
            paginasPorCiclo: { type: Number, default: 3 },
            maxPaginas: { type: Number, default: 80 },
            rateLimit: { type: Number, default: 20 },
            delayBetweenRequests: { type: Number, default: 1500 },
            descargarPdf: { type: Boolean, default: true },
        },

        notification: {
            errorEmail: { type: Boolean, default: true },
            newDocumentsEmail: { type: Boolean, default: true },
            recipientEmail: { type: String, default: '' },
        },

        stats: {
            totalProcessed: { type: Number, default: 0 },
            totalSuccess: { type: Number, default: 0 },
            totalErrors: { type: Number, default: 0 },
            lastRunAt: { type: Date },
            lastSuccessAt: { type: Date },
            lastErrorAt: { type: Date },
            lastErrorMessage: { type: String },
            backfillCompletadoAt: { type: Map, of: Date },
        },

        lastUpdate: { type: Date },
    },
    { timestamps: true, collection: 'cijur-workers-config' }
);

ConfiguracionCijurSchema.index({ worker_id: 1 }, { unique: true });

module.exports = lazyModel('ConfiguracionCijur', ConfiguracionCijurSchema);
