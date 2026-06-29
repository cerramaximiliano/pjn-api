/**
 * monitoringController — expone métricas de infraestructura a la UI ADMIN.
 * Lee snapshots desde Atlas (escritos por la instancia local cada N min).
 */
const svc = require('../services/monitoringService');
const { logger } = require('../config/pino');

const STALE_MS = parseInt(process.env.MONITORING_STALE_MS || '1800000', 10); // 30 min

module.exports = {
  // Vista integral: último snapshot (Qdrant + Mongo local + Atlas + host) con frescura.
  async overview(req, res) {
    try {
      const snap = await svc.getLatestSnapshot();
      if (!snap) {
        return res.json({ success: true, data: null, message: 'Sin snapshots todavía (el collector corre en la instancia local cada ~10 min).' });
      }
      const ageMs = Date.now() - new Date(snap.createdAt).getTime();
      res.json({ success: true, data: { ...snap, ageSeconds: Math.round(ageMs / 1000), stale: ageMs > STALE_MS } });
    } catch (e) {
      logger.error(`[monitoring] overview: ${e.message}`);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Tendencia/histórico para gráficos (vectores, disco, tamaño de DBs en el tiempo).
  async history(req, res) {
    try {
      const hours = Math.min(parseInt(req.query.hours || '168', 10), 24 * 90);
      const data = await svc.getHistory({ hours });
      res.json({ success: true, count: data.length, hours, data });
    } catch (e) {
      logger.error(`[monitoring] history: ${e.message}`);
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // Fuerza un snapshot ya (solo efectivo en la instancia local que ve Qdrant/Mongo-local).
  async refresh(req, res) {
    try {
      if (!svc.isLocalInstance()) {
        return res.status(409).json({ success: false, message: 'refresh solo disponible en la instancia local (worker_01); la cloud sólo sirve snapshots.' });
      }
      const snap = await svc.collectSnapshot();
      await svc.writeSnapshot(snap);
      res.json({ success: true, data: snap });
    } catch (e) {
      logger.error(`[monitoring] refresh: ${e.message}`);
      res.status(500).json({ success: false, message: e.message });
    }
  },
};
