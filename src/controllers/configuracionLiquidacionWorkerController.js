/**
 * Controller para LiquidacionWorkerConfig.
 *
 * Endpoints admin para inspeccionar/editar la configuración del sistema
 * pjn-liquidacion-worker (manager + url-extractor + pdf-processor).
 */
const mongoose = require('mongoose');
const { LiquidacionWorkerConfig, CausasSegSoc } = require('pjn-models');
const { logger } = require('../config/pino');
const pm2Control = require('../services/pm2Control');

// Modelo loose para queries genéricas a la colección previsional-liquidacion-urls.
// (No vivimos en pjn-models porque el schema completo está en pjn-liquidacion-worker
// y acá solo necesitamos leer.)
const PrevisionalLiquidacionUrl = mongoose.models.PrevisionalLiquidacionUrl ||
  mongoose.model(
    'PrevisionalLiquidacionUrl',
    new mongoose.Schema({}, { strict: false, collection: 'previsional-liquidacion-urls' })
  );

const DOC_PROJECTION_LIST = {
  causaId: 1,
  causaNumber: 1,
  causaYear: 1,
  fuero: 1,
  caratula: 1,
  juzgado: 1,
  secretaria: 1,
  movFecha: 1,
  tipo: 1,
  detalleNorm: 1,
  url: 1,
  tipoDoc: 1,
  category: 1,
  pdfStatus: 1,
  pdfPages: 1,
  pdfProducer: 1,
  sectionMix: 1,
  hasHaberCaja: 1,
  hasHaberReajustado: 1,
  hasRetroactivo: 1,
  hasRegimenDependencia: 1,
  hasRegimenAutonomo: 1,
  'extracted.persona': 1,
  'extracted.expediente': 1,
  'extracted.regimen': 1,
  'extracted.regimenSource': 1,
  'extracted.regimenConfidence': 1,
  'extracted.retroactivo.capital': 1,
  'extracted.retroactivo.intereses': 1,
  'extracted.retroactivo.total': 1,
  processedAt: 1
};

const ALLOWED_SORT_FIELDS = new Set(['movFecha', 'processedAt', 'pdfPages', 'caratula', 'category', 'sectionMix']);

const ALLOWED_TOP_LEVEL = ['enabled', 'workerNames', 'manager', 'urlExtractor', 'pdfProcessor', 'alerts'];

function pickAllowed(body) {
  const out = {};
  for (const k of ALLOWED_TOP_LEVEL) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

function validateConfigPayload(payload) {
  const errors = [];

  if (payload.pdfProcessor) {
    const { concurrency, downloadTimeoutMs, maxBytes, ocrCharsPerPageThreshold, retryAttempts, requestDelayMs, dailyLimit } = payload.pdfProcessor;
    if (concurrency !== undefined && (concurrency < 1 || concurrency > 20)) errors.push('pdfProcessor.concurrency debe estar entre 1 y 20');
    if (downloadTimeoutMs !== undefined && downloadTimeoutMs < 5_000) errors.push('pdfProcessor.downloadTimeoutMs >= 5000');
    if (maxBytes !== undefined && (maxBytes < 1024 || maxBytes > 100 * 1024 * 1024)) errors.push('pdfProcessor.maxBytes entre 1KB y 100MB');
    if (ocrCharsPerPageThreshold !== undefined && ocrCharsPerPageThreshold < 0) errors.push('pdfProcessor.ocrCharsPerPageThreshold >= 0');
    if (retryAttempts !== undefined && (retryAttempts < 1 || retryAttempts > 10)) errors.push('pdfProcessor.retryAttempts entre 1 y 10');
    if (requestDelayMs !== undefined && (requestDelayMs < 0 || requestDelayMs > 60_000)) errors.push('pdfProcessor.requestDelayMs entre 0 y 60000');
    if (dailyLimit !== undefined && (dailyLimit < 0 || dailyLimit > 10_000_000)) errors.push('pdfProcessor.dailyLimit entre 0 y 10000000 (0 = sin límite)');
  }
  if (payload.urlExtractor) {
    const { cronExpression, caratulaPattern, movDetallePattern, enqueueBatchSize, enqueueBatchDelayMs } = payload.urlExtractor;
    if (cronExpression !== undefined && typeof cronExpression !== 'string') errors.push('urlExtractor.cronExpression debe ser string');
    if (caratulaPattern !== undefined) { try { new RegExp(caratulaPattern, 'i'); } catch (e) { errors.push(`urlExtractor.caratulaPattern regex inválida: ${e.message}`); } }
    if (movDetallePattern !== undefined) { try { new RegExp(movDetallePattern, 'i'); } catch (e) { errors.push(`urlExtractor.movDetallePattern regex inválida: ${e.message}`); } }
    if (enqueueBatchSize !== undefined && (enqueueBatchSize < 1 || enqueueBatchSize > 100_000)) errors.push('urlExtractor.enqueueBatchSize entre 1 y 100000');
    if (enqueueBatchDelayMs !== undefined && (enqueueBatchDelayMs < 0 || enqueueBatchDelayMs > 300_000)) errors.push('urlExtractor.enqueueBatchDelayMs entre 0 y 300000');
  }
  if (payload.manager) {
    const { configPollIntervalMs, heartbeatIntervalMs, workStartHour, workEndHour, workDays } = payload.manager;
    if (configPollIntervalMs !== undefined && configPollIntervalMs < 1000) errors.push('manager.configPollIntervalMs >= 1000');
    if (heartbeatIntervalMs !== undefined && heartbeatIntervalMs < 1000) errors.push('manager.heartbeatIntervalMs >= 1000');
    if (workStartHour !== undefined && workStartHour !== null && (workStartHour < 0 || workStartHour > 23)) errors.push('manager.workStartHour entre 0 y 23 o null');
    if (workEndHour !== undefined && workEndHour !== null && (workEndHour < 0 || workEndHour > 23)) errors.push('manager.workEndHour entre 0 y 23 o null');
    if (workDays !== undefined) {
      if (!Array.isArray(workDays)) errors.push('manager.workDays debe ser array');
      else if (workDays.some((d) => typeof d !== 'number' || d < 0 || d > 6)) errors.push('manager.workDays: cada día entre 0 (Dom) y 6 (Sáb)');
    }
  }

  return errors;
}

const controller = {
  /**
   * GET /api/liquidacion-worker-config
   * Devuelve el documento completo (config + currentState + alerts).
   */
  async getFull(req, res) {
    try {
      const doc = await LiquidacionWorkerConfig.getOrCreate();
      res.json({ success: true, data: doc });
    } catch (err) {
      logger.error(`liq-config getFull: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/settings
   * Solo los valores de configuración (config). Si no existe, lo crea con defaults.
   */
  async getSettings(req, res) {
    try {
      const doc = await LiquidacionWorkerConfig.getOrCreate();
      res.json({ success: true, data: doc.config });
    } catch (err) {
      logger.error(`liq-config getSettings: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * PATCH /api/liquidacion-worker-config/settings
   * Actualiza valores de configuración. Solo acepta los keys de ALLOWED_TOP_LEVEL.
   */
  async updateSettings(req, res) {
    try {
      const payload = pickAllowed(req.body || {});
      if (Object.keys(payload).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No se proporcionaron campos válidos para actualizar',
          allowedFields: ALLOWED_TOP_LEVEL
        });
      }
      const errors = validateConfigPayload(payload);
      if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validación falló', errors });
      }
      const doc = await LiquidacionWorkerConfig.updateConfig(payload);
      res.json({ success: true, message: 'Configuración actualizada', data: doc.config });
    } catch (err) {
      logger.error(`liq-config updateSettings: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/status
   * Devuelve currentState + heartbeats — vista operacional para el admin UI.
   */
  async getStatus(req, res) {
    try {
      const doc = await LiquidacionWorkerConfig.getOrCreate();
      const workers = doc.currentState?.workers || new Map();
      // Convertir Map → object plano para JSON
      const workersObj = workers instanceof Map ? Object.fromEntries(workers) : workers;

      res.json({
        success: true,
        data: {
          enabled: doc.config?.enabled,
          workers: workersObj,
          collectionStats: doc.currentState?.collectionStats || {},
          queueStats: doc.currentState?.queueStats || {},
          lastUrlExtractRun: doc.currentState?.lastUrlExtractRun || {},
          lastUpdate: doc.lastUpdate
        }
      });
    } catch (err) {
      logger.error(`liq-config getStatus: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/alerts
   * Alertas no reconocidas.
   */
  async getAlerts(req, res) {
    try {
      const doc = await LiquidacionWorkerConfig.findOne({ name: 'liquidacion-worker' }).lean();
      const alerts = (doc?.alerts || []).filter((a) => !a.acknowledged);
      res.json({ success: true, data: alerts });
    } catch (err) {
      logger.error(`liq-config getAlerts: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * POST /api/liquidacion-worker-config/alerts/:index/acknowledge
   */
  async acknowledgeAlert(req, res) {
    try {
      const idx = parseInt(req.params.index, 10);
      if (Number.isNaN(idx) || idx < 0) {
        return res.status(400).json({ success: false, message: 'index inválido' });
      }
      const doc = await LiquidacionWorkerConfig.findOne({ name: 'liquidacion-worker' });
      if (!doc || !doc.alerts || !doc.alerts[idx]) {
        return res.status(404).json({ success: false, message: 'alerta no encontrada' });
      }
      doc.alerts[idx].acknowledged = true;
      doc.lastUpdate = new Date();
      await doc.save();
      res.json({ success: true, message: 'alerta acknowledged' });
    } catch (err) {
      logger.error(`liq-config acknowledgeAlert: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/documents
   *
   * Lista paginada de docs de previsional-liquidacion-urls con filtros.
   * Query params:
   *   page (default 1), limit (default 50, max 200)
   *   pdfStatus, sectionMix, category, fuero (exact match)
   *   caratula (regex case-insensitive)
   *   fechaFrom, fechaTo (ISO date string, contra movFecha)
   *   causaId (ObjectId)
   *   hasData=true  →  excluye sectionMix in [COVER, NONE, null]
   *   sortBy (default movFecha), sortOrder (asc|desc, default desc)
   */
  async listDocuments(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const skip = (page - 1) * limit;

      const filter = {};
      if (req.query.pdfStatus) filter.pdfStatus = req.query.pdfStatus;
      if (req.query.sectionMix) filter.sectionMix = req.query.sectionMix;
      if (req.query.category) filter.category = req.query.category;
      if (req.query.fuero) filter.fuero = req.query.fuero;
      if (req.query.caratula) {
        const esc = String(req.query.caratula).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.caratula = { $regex: esc, $options: 'i' };
      }
      if (req.query.causaId && mongoose.isValidObjectId(req.query.causaId)) {
        filter.causaId = new mongoose.Types.ObjectId(req.query.causaId);
      }
      if (req.query.fechaFrom || req.query.fechaTo) {
        filter.movFecha = {};
        if (req.query.fechaFrom) filter.movFecha.$gte = new Date(req.query.fechaFrom);
        if (req.query.fechaTo) filter.movFecha.$lte = new Date(req.query.fechaTo);
      }
      if (req.query.hasData === 'true') {
        filter.pdfStatus = filter.pdfStatus || 'extracted';
        filter.sectionMix = { $nin: ['COVER', 'NONE', null] };
      }
      // Filtro de régimen: 'dependencia' | 'autonomo' | 'mixto' | 'unknown'
      // Acepta tanto matching exacto contra extracted.regimen como por los flags top-level.
      if (req.query.regimen) {
        const r = String(req.query.regimen);
        if (['dependencia', 'autonomo', 'mixto', 'unknown'].includes(r)) {
          filter['extracted.regimen'] = r;
        }
      }
      // Atajos por flags (compatibles con uno o varios valores: hasRegimen=dependencia,autonomo)
      if (req.query.hasRegimen) {
        const flags = String(req.query.hasRegimen).split(',').map((s) => s.trim());
        if (flags.includes('dependencia')) filter.hasRegimenDependencia = true;
        if (flags.includes('autonomo')) filter.hasRegimenAutonomo = true;
      }

      const sortBy = ALLOWED_SORT_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'movFecha';
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

      const [docs, total] = await Promise.all([
        PrevisionalLiquidacionUrl.find(filter, DOC_PROJECTION_LIST)
          .sort({ [sortBy]: sortOrder, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        PrevisionalLiquidacionUrl.countDocuments(filter)
      ]);

      res.json({ success: true, data: { docs, total, page, limit, pages: Math.ceil(total / limit) } });
    } catch (err) {
      logger.error(`liq-config listDocuments: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error listando documentos', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/documents/:id
   * Detalle completo del doc (incluye sections + extracted).
   */
  async getDocument(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: 'id inválido' });
      }
      const doc = await PrevisionalLiquidacionUrl.findById(id).lean();
      if (!doc) return res.status(404).json({ success: false, message: 'documento no encontrado' });
      res.json({ success: true, data: doc });
    } catch (err) {
      logger.error(`liq-config getDocument: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo documento', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/documents/:id/causa
   * Devuelve subset de la causa origen (causas-segsocial) para trazabilidad.
   */
  async getDocumentCausa(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: 'id inválido' });
      }
      const doc = await PrevisionalLiquidacionUrl.findById(id).select('causaId').lean();
      if (!doc) return res.status(404).json({ success: false, message: 'documento no encontrado' });

      const causa = await CausasSegSoc.findById(doc.causaId, {
        number: 1, year: 1, incidente: 1, caratula: 1, objeto: 1, fuero: 1,
        juzgado: 1, secretaria: 1, situacion: 1, partes: 1, intervinientes: 1,
        movimientosCount: 1, fechaUltimoMovimiento: 1, lastUpdate: 1,
        instanciaOrigen: 1, instanciaRevisora: 1, instanciaExtraordinaria: 1,
        isPrivate: 1, isArchived: 1, verified: 1, isValid: 1
      }).lean();

      if (!causa) return res.status(404).json({ success: false, message: 'causa origen no encontrada' });
      res.json({ success: true, data: causa });
    } catch (err) {
      logger.error(`liq-config getDocumentCausa: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo causa', error: err.message });
    }
  },

  /**
   * GET /api/liquidacion-worker-config/pm2-status
   * Estado en vivo de los 3 procesos PM2 vía `pm2 jlist`.
   */
  async pm2Status(req, res) {
    try {
      const data = await pm2Control.listFiltered();
      res.json({ success: true, data });
    } catch (err) {
      logger.error(`liq-config pm2Status: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error ejecutando pm2 jlist', error: err.message });
    }
  },

  /**
   * POST /api/liquidacion-worker-config/pm2/:action
   * action ∈ { start | stop | restart }.
   * Body opcional: { workers: ['manager','url-extractor','pdf-processor'] }
   * Sin body = aplica a todos.
   */
  async pm2Action(req, res) {
    try {
      const { action } = req.params;
      const { workers } = req.body || {};
      const results = await pm2Control.executeAction(action, workers);
      const allOk = results.every((r) => r.ok);
      logger.info(`liq-config pm2 ${action} → ${JSON.stringify(results)}`);
      res.status(allOk ? 200 : 207).json({ success: allOk, message: `pm2 ${action} ejecutado`, data: results });
    } catch (err) {
      logger.error(`liq-config pm2Action: ${err.message}`);
      res.status(400).json({ success: false, message: 'Error ejecutando acción PM2', error: err.message });
    }
  },

  /**
   * POST /api/liquidacion-worker-config/reset
   * Borra el doc y lo recrea con defaults.
   */
  async resetToDefaults(req, res) {
    try {
      await LiquidacionWorkerConfig.deleteOne({ name: 'liquidacion-worker' });
      const doc = await LiquidacionWorkerConfig.getOrCreate();
      res.json({ success: true, message: 'Reset a defaults', data: doc });
    } catch (err) {
      logger.error(`liq-config reset: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  }
};

module.exports = controller;
