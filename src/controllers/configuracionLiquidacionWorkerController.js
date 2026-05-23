/**
 * Controller para LiquidacionWorkerConfig.
 *
 * Endpoints admin para inspeccionar/editar la configuración del sistema
 * pjn-liquidacion-worker (manager + url-extractor + pdf-processor).
 */
const { LiquidacionWorkerConfig } = require('pjn-models');
const { logger } = require('../config/pino');

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
    const { concurrency, downloadTimeoutMs, maxBytes, ocrCharsPerPageThreshold, retryAttempts } = payload.pdfProcessor;
    if (concurrency !== undefined && (concurrency < 1 || concurrency > 20)) errors.push('pdfProcessor.concurrency debe estar entre 1 y 20');
    if (downloadTimeoutMs !== undefined && downloadTimeoutMs < 5_000) errors.push('pdfProcessor.downloadTimeoutMs >= 5000');
    if (maxBytes !== undefined && (maxBytes < 1024 || maxBytes > 100 * 1024 * 1024)) errors.push('pdfProcessor.maxBytes entre 1KB y 100MB');
    if (ocrCharsPerPageThreshold !== undefined && ocrCharsPerPageThreshold < 0) errors.push('pdfProcessor.ocrCharsPerPageThreshold >= 0');
    if (retryAttempts !== undefined && (retryAttempts < 1 || retryAttempts > 10)) errors.push('pdfProcessor.retryAttempts entre 1 y 10');
  }
  if (payload.urlExtractor) {
    const { cronExpression, caratulaPattern, movDetallePattern } = payload.urlExtractor;
    if (cronExpression !== undefined && typeof cronExpression !== 'string') errors.push('urlExtractor.cronExpression debe ser string');
    if (caratulaPattern !== undefined) { try { new RegExp(caratulaPattern, 'i'); } catch (e) { errors.push(`urlExtractor.caratulaPattern regex inválida: ${e.message}`); } }
    if (movDetallePattern !== undefined) { try { new RegExp(movDetallePattern, 'i'); } catch (e) { errors.push(`urlExtractor.movDetallePattern regex inválida: ${e.message}`); } }
  }
  if (payload.manager) {
    const { configPollIntervalMs, heartbeatIntervalMs, workStartHour, workEndHour } = payload.manager;
    if (configPollIntervalMs !== undefined && configPollIntervalMs < 1000) errors.push('manager.configPollIntervalMs >= 1000');
    if (heartbeatIntervalMs !== undefined && heartbeatIntervalMs < 1000) errors.push('manager.heartbeatIntervalMs >= 1000');
    if (workStartHour !== undefined && workStartHour !== null && (workStartHour < 0 || workStartHour > 23)) errors.push('manager.workStartHour entre 0 y 23 o null');
    if (workEndHour !== undefined && workEndHour !== null && (workEndHour < 0 || workEndHour > 23)) errors.push('manager.workEndHour entre 0 y 23 o null');
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
