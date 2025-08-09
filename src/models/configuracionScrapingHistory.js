const mongoose = require('mongoose');

const configuracionScrapingHistorySchema = new mongoose.Schema({
  configuracionScrapingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ConfiguracionScraping',
    required: true,
    index: true
  },
  fuero: {
    type: String,
    required: true,
    index: true
  },
  year: {
    type: String,
    required: true,
    index: true
  },
  version: {
    type: Number,
    required: true
  },
  range_start: {
    type: Number,
    required: true,
    index: true
  },
  range_end: {
    type: Number,
    required: true,
    index: true
  },
  completedAt: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  lastProcessedNumber: {
    type: Number,
    required: true
  },
  documentsProcessed: {
    type: Number,
    default: 0
  },
  documentsFound: {
    type: Number,
    default: 0
  },
  enabled: {
    type: Boolean,
    default: false
  },
  completionEmailSent: {
    type: Boolean,
    default: false
  },
  captchaStats: {
    totalCaptchas: Number,
    totalCaptchasFailed: Number,
    totalCost: Number,
    provider: String
  },
  requestStats: {
    totalRequests: Number,
    successfulRequests: Number,
    failedRequests: Number
  },
  startedAt: {
    type: Date
  },
  duration: {
    type: String
  },
  errors: [{
    message: String,
    timestamp: Date,
    type: String
  }],
  lastError: {
    message: String,
    timestamp: Date,
    type: String
  },
  retryCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Índice compuesto para evitar rangos duplicados o superpuestos
configuracionScrapingHistorySchema.index({ 
  fuero: 1, 
  year: 1, 
  range_start: 1, 
  range_end: 1 
}, { 
  unique: true,
  name: 'unique_fuero_year_range'
});

// Método para verificar si hay rangos superpuestos
configuracionScrapingHistorySchema.statics.hasOverlappingRange = async function(fuero, year, rangeStart, rangeEnd, excludeId = null) {
  const query = {
    fuero,
    year,
    $or: [
      // El nuevo rango comienza dentro de un rango existente
      { range_start: { $lte: rangeStart }, range_end: { $gte: rangeStart } },
      // El nuevo rango termina dentro de un rango existente
      { range_start: { $lte: rangeEnd }, range_end: { $gte: rangeEnd } },
      // El nuevo rango contiene completamente un rango existente
      { range_start: { $gte: rangeStart }, range_end: { $lte: rangeEnd } }
    ]
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const overlapping = await this.findOne(query);
  return overlapping !== null;
};

// Método para obtener el historial de una configuración
configuracionScrapingHistorySchema.statics.getHistoryByConfiguracion = async function(configuracionScrapingId, options = {}) {
  const { limit = 10, skip = 0, sort = { completedAt: -1 } } = options;
  
  return this.find({ configuracionScrapingId })
    .sort(sort)
    .limit(limit)
    .skip(skip)
    .lean();
};

// Método para obtener estadísticas agregadas
configuracionScrapingHistorySchema.statics.getStatsByFueroAndYear = async function(fuero, year) {
  return this.aggregate([
    { $match: { fuero, year } },
    {
      $group: {
        _id: null,
        totalDocumentsProcessed: { $sum: '$documentsProcessed' },
        totalDocumentsFound: { $sum: '$documentsFound' },
        totalCaptchas: { $sum: '$captchaStats.totalCaptchas' },
        totalCost: { $sum: '$captchaStats.totalCost' },
        totalRanges: { $sum: 1 },
        minRange: { $min: '$range_start' },
        maxRange: { $max: '$range_end' },
        avgDocumentsPerRange: { $avg: '$documentsFound' }
      }
    }
  ]);
};

const ConfiguracionScrapingHistory = mongoose.model('ConfiguracionScrapingHistory', configuracionScrapingHistorySchema);

module.exports = ConfiguracionScrapingHistory;