'use strict';

const mongoose = require('mongoose');

const MonthHistorySchema = new mongoose.Schema({
    year:              { type: Number },
    month:             { type: Number },
    totalDocuments:    { type: Number, default: 0 },
    completed:         { type: Boolean, default: false },
    completedAt:       { type: Date },
    startedAt:         { type: Date },
}, { _id: false });

const ConfiguracionScrapingSaijSchema = new mongoose.Schema(
    {
        worker_id: { type: String, required: true, unique: true, trim: true },
        enabled:   { type: Boolean, default: false },

        scraping: {
            url:                    { type: String, default: 'https://www.saij.gob.ar/home' },
            apiUrl:                 { type: String, default: 'https://www.saij.gob.ar/busqueda' },
            yearFrom:               { type: Number, default: 2010 },
            currentYear:            { type: Number, default: 2010 },
            currentMonth:           { type: Number, default: 1 },
            currentOffset:          { type: Number, default: 0 },
            batchSize:              { type: Number, default: 10 },
            pageSize:               { type: Number, default: 25 },
            delayBetweenRequests:   { type: Number, default: 2000 },
            rateLimit:              { type: Number, default: 30 },
            pageTimeout:            { type: Number, default: 60000 },
            maxRetries:             { type: Number, default: 3 },
            downloadPdf:            { type: Boolean, default: false },
        },

        history: { type: [MonthHistorySchema], default: [] },

        availability: {
            pauseOnConsecutiveErrors: { type: Number, default: 5 },
            pauseDurationMinutes:     { type: Number, default: 10 },
            manualPause:              { type: Boolean, default: false },
            manualPauseReason:        { type: String, default: '' },
        },

        pause: {
            isPaused:          { type: Boolean, default: false },
            pausedAt:          { type: Date },
            resumeAt:          { type: Date },
            pauseReason:       { type: String },
            consecutiveErrors: { type: Number, default: 0 },
        },

        notification: {
            startupEmail:    { type: Boolean, default: false },
            errorEmail:      { type: Boolean, default: true },
            dailyReport:     { type: Boolean, default: false },
            recipientEmail:  { type: String, default: '' },
        },

        stats: {
            totalProcessed:    { type: Number, default: 0 },
            totalSuccess:      { type: Number, default: 0 },
            totalErrors:       { type: Number, default: 0 },
            statsStartDate:    { type: Date },
            lastRunAt:         { type: Date },
            lastSuccessAt:     { type: Date },
            lastErrorAt:       { type: Date },
            lastErrorMessage:  { type: String },
        },

        lastUpdate: { type: Date },
    },
    {
        timestamps: true,
        collection: 'configuraciones_scraping_saij',
    }
);

module.exports = mongoose.model('ConfiguracionScrapingSaij', ConfiguracionScrapingSaijSchema);
