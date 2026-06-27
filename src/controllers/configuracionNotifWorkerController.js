/**
 * Controller para NotifWorkerConfig.
 *
 * Endpoints admin para inspeccionar/editar la configuración del sistema
 * pjn-notificaciones-laborales-worker (manager + url-extractor + pdf-processor).
 *
 * Espejo del controller de liquidacion. Diferencias clave:
 *   - colección destino: notificaciones-laborales-urls
 *   - causa origen: causas-trabajo (CausasTrabajo, no CausasSegSoc)
 *   - 2 patrones de detalle (A + B) en lugar de uno + processBucketB toggle
 *   - validaciones de OCR settings (ocrPageLimit, ocrPageLimitBucketB, etc)
 *   - pm2Control específico de los procesos pjn-notif-*
 */
const mongoose = require('mongoose');
const { NotifWorkerConfig, CausasTrabajo } = require('pjn-models');
const { logger } = require('../config/pino');
const pm2Control = require('../services/pm2ControlNotif');

// Modelo loose para queries genéricas a la colección destino.
const NotificacionLaboralUrl = mongoose.models.NotificacionLaboralUrl ||
  mongoose.model(
    'NotificacionLaboralUrl',
    new mongoose.Schema({}, { strict: false, collection: 'notificaciones-laborales-urls' })
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
  bucket: 1,
  pdfStatus: 1,
  pdfPages: 1,
  pdfProducer: 1,
  hasCorreoArgentino: 1,
  hasTelegramaLey23789: 1,
  hasCartaDocumento: 1,
  detectedPieces: 1,
  'pieces.type': 1,
  'pieces.subType': 1,
  'pieces.sender': 1,
  'pieces.piezaPostalNumero': 1,
  'pieces.fechaImposicion': 1,
  processedAt: 1
};

const ALLOWED_SORT_FIELDS = new Set(['movFecha', 'processedAt', 'pdfPages', 'caratula', 'category', 'bucket', 'detectedPieces']);
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
    const {
      concurrency, downloadTimeoutMs, maxBytes, ocrCharsPerPageThreshold,
      retryAttempts, requestDelayMs, dailyLimit,
      ocrPageLimit, ocrPageLimitBucketB, ocrAbortIfNoMarkersPages, ocrDpi, ocrLang
    } = payload.pdfProcessor;
    if (concurrency !== undefined && (concurrency < 1 || concurrency > 10)) errors.push('pdfProcessor.concurrency entre 1 y 10 (OCR es CPU-bound)');
    if (downloadTimeoutMs !== undefined && downloadTimeoutMs < 5_000) errors.push('pdfProcessor.downloadTimeoutMs >= 5000');
    if (maxBytes !== undefined && (maxBytes < 1024 || maxBytes > 100 * 1024 * 1024)) errors.push('pdfProcessor.maxBytes entre 1KB y 100MB');
    if (ocrCharsPerPageThreshold !== undefined && ocrCharsPerPageThreshold < 0) errors.push('pdfProcessor.ocrCharsPerPageThreshold >= 0');
    if (retryAttempts !== undefined && (retryAttempts < 1 || retryAttempts > 10)) errors.push('pdfProcessor.retryAttempts entre 1 y 10');
    if (requestDelayMs !== undefined && (requestDelayMs < 0 || requestDelayMs > 60_000)) errors.push('pdfProcessor.requestDelayMs entre 0 y 60000');
    if (dailyLimit !== undefined && (dailyLimit < 0 || dailyLimit > 10_000_000)) errors.push('pdfProcessor.dailyLimit entre 0 y 10000000 (0 = sin límite)');
    if (ocrPageLimit !== undefined && (ocrPageLimit < 1 || ocrPageLimit > 200)) errors.push('pdfProcessor.ocrPageLimit entre 1 y 200');
    if (ocrPageLimitBucketB !== undefined && (ocrPageLimitBucketB < 1 || ocrPageLimitBucketB > 50)) errors.push('pdfProcessor.ocrPageLimitBucketB entre 1 y 50');
    if (ocrAbortIfNoMarkersPages !== undefined && (ocrAbortIfNoMarkersPages < 0 || ocrAbortIfNoMarkersPages > 20)) errors.push('pdfProcessor.ocrAbortIfNoMarkersPages entre 0 y 20');
    if (ocrDpi !== undefined && (ocrDpi < 100 || ocrDpi > 400)) errors.push('pdfProcessor.ocrDpi entre 100 y 400');
    if (ocrLang !== undefined && !/^[a-z]{3}(\+[a-z]{3})?$/.test(ocrLang)) errors.push('pdfProcessor.ocrLang formato tesseract (ej: spa, eng, spa+eng)');
  }

  if (payload.urlExtractor) {
    const { cronExpression, movDetallePatternA, movDetallePatternB, fueroAllowed, enqueueBatchSize, enqueueBatchDelayMs } = payload.urlExtractor;
    if (cronExpression !== undefined && typeof cronExpression !== 'string') errors.push('urlExtractor.cronExpression debe ser string');
    if (movDetallePatternA !== undefined) { try { new RegExp(movDetallePatternA, 'i'); } catch (e) { errors.push(`urlExtractor.movDetallePatternA regex inválida: ${e.message}`); } }
    if (movDetallePatternB !== undefined) { try { new RegExp(movDetallePatternB, 'i'); } catch (e) { errors.push(`urlExtractor.movDetallePatternB regex inválida: ${e.message}`); } }
    if (fueroAllowed !== undefined) {
      if (!Array.isArray(fueroAllowed)) errors.push('urlExtractor.fueroAllowed debe ser array');
      else if (fueroAllowed.some((f) => typeof f !== 'string' || !/^[A-Z]{2,5}$/.test(f))) errors.push('urlExtractor.fueroAllowed: cada fuero debe ser código en mayúsculas (ej CNT, CSS)');
    }
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
  async getFull(req, res) {
    try {
      const doc = await NotifWorkerConfig.getOrCreate();
      res.json({ success: true, data: doc });
    } catch (err) {
      logger.error(`notif-config getFull: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  async getSettings(req, res) {
    try {
      const doc = await NotifWorkerConfig.getOrCreate();
      res.json({ success: true, data: doc.config });
    } catch (err) {
      logger.error(`notif-config getSettings: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

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
      const doc = await NotifWorkerConfig.updateConfig(payload);
      res.json({ success: true, message: 'Configuración actualizada', data: doc.config });
    } catch (err) {
      logger.error(`notif-config updateSettings: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  async getStatus(req, res) {
    try {
      const doc = await NotifWorkerConfig.getOrCreate();
      const workers = doc.currentState?.workers || new Map();
      const workersObj = workers instanceof Map ? Object.fromEntries(workers) : workers;
      res.json({
        success: true,
        data: {
          enabled: doc.config?.enabled,
          workers: workersObj,
          collectionStats: doc.currentState?.collectionStats || {},
          queueStats: doc.currentState?.queueStats || {},
          lastUrlExtractRun: doc.currentState?.lastUrlExtractRun || {},
          dailyProcessed: doc.currentState?.dailyProcessed || {},
          lastUpdate: doc.lastUpdate
        }
      });
    } catch (err) {
      logger.error(`notif-config getStatus: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  async getAlerts(req, res) {
    try {
      const doc = await NotifWorkerConfig.findOne({ name: 'notif-worker' }).lean();
      const alerts = (doc?.alerts || []).filter((a) => !a.acknowledged);
      res.json({ success: true, data: alerts });
    } catch (err) {
      logger.error(`notif-config getAlerts: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  async acknowledgeAlert(req, res) {
    try {
      const idx = parseInt(req.params.index, 10);
      if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ success: false, message: 'index inválido' });
      const doc = await NotifWorkerConfig.findOne({ name: 'notif-worker' });
      if (!doc || !doc.alerts || !doc.alerts[idx]) {
        return res.status(404).json({ success: false, message: 'alerta no encontrada' });
      }
      doc.alerts[idx].acknowledged = true;
      doc.lastUpdate = new Date();
      await doc.save();
      res.json({ success: true, message: 'alerta acknowledged' });
    } catch (err) {
      logger.error(`notif-config acknowledgeAlert: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  },

  /**
   * GET /api/notif-worker-config/documents
   *
   * Lista paginada con filtros específicos de notificaciones laborales.
   * Query params:
   *   page, limit
   *   pdfStatus, category, bucket, fuero (exact)
   *   sender (trabajador|empleador|unknown) — filtra pieces.sender
   *   subType — filtra pieces.subType
   *   piezaPostalNumero — match exacto contra pieces.piezaPostalNumero
   *   caratula (regex case-insensitive)
   *   fechaFrom, fechaTo (contra movFecha)
   *   causaId (ObjectId)
   *   hasMarkers=true → al menos un marker positivo
   *   hasPieces=true → detectedPieces > 0
   *   sortBy, sortOrder
   */
  async listDocuments(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const skip = (page - 1) * limit;

      const filter = {};
      if (req.query.pdfStatus) filter.pdfStatus = req.query.pdfStatus;
      if (req.query.category) filter.category = req.query.category;
      if (req.query.bucket) filter.bucket = req.query.bucket;
      if (req.query.fuero) filter.fuero = req.query.fuero;
      if (req.query.sender) filter['pieces.sender'] = req.query.sender;
      if (req.query.subType) filter['pieces.subType'] = req.query.subType;
      if (req.query.piezaPostalNumero) filter['pieces.piezaPostalNumero'] = req.query.piezaPostalNumero;
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
      if (req.query.hasMarkers === 'true') {
        filter.$or = [
          { hasCorreoArgentino: true },
          { hasTelegramaLey23789: true },
          { hasCartaDocumento: true }
        ];
      }
      if (req.query.hasPieces === 'true') {
        filter.detectedPieces = { $gt: 0 };
      }

      const sortBy = ALLOWED_SORT_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'movFecha';
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

      const [docs, total] = await Promise.all([
        NotificacionLaboralUrl.find(filter, DOC_PROJECTION_LIST)
          .sort({ [sortBy]: sortOrder, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        NotificacionLaboralUrl.countDocuments(filter)
      ]);

      res.json({ success: true, data: { docs, total, page, limit, pages: Math.ceil(total / limit) } });
    } catch (err) {
      logger.error(`notif-config listDocuments: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error listando documentos', error: err.message });
    }
  },

  async getDocument(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'id inválido' });
      const doc = await NotificacionLaboralUrl.findById(id).lean();
      if (!doc) return res.status(404).json({ success: false, message: 'documento no encontrado' });
      res.json({ success: true, data: doc });
    } catch (err) {
      logger.error(`notif-config getDocument: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo documento', error: err.message });
    }
  },

  /**
   * GET /api/notif-worker-config/documents/:id/causa
   * Devuelve subset de la causa origen (causas-trabajo) para trazabilidad.
   */
  async getDocumentCausa(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'id inválido' });
      const doc = await NotificacionLaboralUrl.findById(id).select('causaId').lean();
      if (!doc) return res.status(404).json({ success: false, message: 'documento no encontrado' });

      const causa = await CausasTrabajo.findById(doc.causaId, {
        number: 1, year: 1, incidente: 1, caratula: 1, objeto: 1, fuero: 1,
        juzgado: 1, secretaria: 1, sala: 1, vocalia: 1,
        partes: 1, intervinientes: 1,
        movimientosCount: 1, lastUpdate: 1,
        verified: 1, isValid: 1
      }).lean();

      if (!causa) return res.status(404).json({ success: false, message: 'causa origen no encontrada' });
      res.json({ success: true, data: causa });
    } catch (err) {
      logger.error(`notif-config getDocumentCausa: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo causa', error: err.message });
    }
  },

  async pm2Status(req, res) {
    try {
      const data = await pm2Control.listFiltered();
      res.json({ success: true, data });
    } catch (err) {
      logger.error(`notif-config pm2Status: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error ejecutando pm2 jlist', error: err.message });
    }
  },

  async pm2Action(req, res) {
    try {
      const { action } = req.params;
      const { workers } = req.body || {};
      const results = await pm2Control.executeAction(action, workers);
      const allOk = results.every((r) => r.ok);
      logger.info(`notif-config pm2 ${action} → ${JSON.stringify(results)}`);
      res.status(allOk ? 200 : 207).json({ success: allOk, message: `pm2 ${action} ejecutado`, data: results });
    } catch (err) {
      logger.error(`notif-config pm2Action: ${err.message}`);
      res.status(400).json({ success: false, message: 'Error ejecutando acción PM2', error: err.message });
    }
  },

  async resetToDefaults(req, res) {
    try {
      await NotifWorkerConfig.deleteOne({ name: 'notif-worker' });
      const doc = await NotifWorkerConfig.getOrCreate();
      res.json({ success: true, message: 'Reset a defaults', data: doc });
    } catch (err) {
      logger.error(`notif-config reset: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error interno', error: err.message });
    }
  }
};

module.exports = controller;
