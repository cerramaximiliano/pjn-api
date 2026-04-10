/**
 * scrapingStatsController.js
 * Endpoints para consultar métricas de scraping almacenadas en scraping-hourly-stats.
 * Soporta granularidad: hora, día y mes.
 */

const mongoose = require('mongoose');
const { logger } = require('../config/pino');

// Timezone Argentina UTC-3
function getArgentinaDate() {
  const now = new Date();
  const argOffset = -3 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const argMinutes = utcMinutes + argOffset;
  let argHour = Math.floor(argMinutes / 60);
  let dayOffset = 0;
  if (argHour < 0)        { argHour += 24; dayOffset = -1; }
  else if (argHour >= 24) { argHour -= 24; dayOffset =  1; }
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  return { date, hour: argHour };
}

function collection() {
  return mongoose.connection.db.collection('scraping-hourly-stats');
}

function aggregateRows(rows) {
  const totals = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };
  for (const r of rows) {
    totals.captcha.resolved += r.captcha?.resolved || 0;
    totals.captcha.failed   += r.captcha?.failed   || 0;
    totals.docs.valid       += r.docs?.valid        || 0;
    totals.docs.invalid     += r.docs?.invalid      || 0;
    totals.docs.error       += r.docs?.error        || 0;
    totals.docs.total       += r.docs?.total        || 0;
  }
  return totals;
}

const scrapingStatsController = {

  /**
   * GET /api/scraping-stats/today
   * Totales del día actual + desglose por fuero y por hora.
   * Query: ?fuero=CIV  (opcional)
   */
  async getToday(req, res) {
    try {
      const { date } = getArgentinaDate();
      const { fuero } = req.query;
      const match = { date };
      if (fuero) match.fuero = fuero.toUpperCase();

      const rows = await collection().find(match).sort({ fuero: 1, hour: 1 }).toArray();

      // Totales globales
      const totals = aggregateRows(rows);

      // Por fuero
      const byFuero = {};
      for (const r of rows) {
        if (!byFuero[r.fuero]) byFuero[r.fuero] = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };
        byFuero[r.fuero].captcha.resolved += r.captcha?.resolved || 0;
        byFuero[r.fuero].captcha.failed   += r.captcha?.failed   || 0;
        byFuero[r.fuero].docs.valid       += r.docs?.valid       || 0;
        byFuero[r.fuero].docs.invalid     += r.docs?.invalid     || 0;
        byFuero[r.fuero].docs.error       += r.docs?.error       || 0;
        byFuero[r.fuero].docs.total       += r.docs?.total       || 0;
      }

      // Por hora (global)
      const byHour = {};
      for (let h = 0; h < 24; h++) byHour[h] = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };
      for (const r of rows) {
        byHour[r.hour].captcha.resolved += r.captcha?.resolved || 0;
        byHour[r.hour].captcha.failed   += r.captcha?.failed   || 0;
        byHour[r.hour].docs.valid       += r.docs?.valid       || 0;
        byHour[r.hour].docs.invalid     += r.docs?.invalid     || 0;
        byHour[r.hour].docs.error       += r.docs?.error       || 0;
        byHour[r.hour].docs.total       += r.docs?.total       || 0;
      }

      res.json({ success: true, data: { date, totals, byFuero, byHour } });
    } catch (error) {
      logger.error(`[scrapingStats] getToday error: ${error.message}`);
      res.status(500).json({ success: false, message: 'Error al obtener estadísticas del día' });
    }
  },

  /**
   * GET /api/scraping-stats/day/:date
   * Totales de un día específico + desglose por fuero y por hora.
   * Params: date = YYYY-MM-DD
   * Query:  ?fuero=CIV  (opcional)
   */
  async getDay(req, res) {
    try {
      const { date } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });
      }
      const { fuero } = req.query;
      const match = { date };
      if (fuero) match.fuero = fuero.toUpperCase();

      const rows = await collection().find(match).sort({ fuero: 1, hour: 1 }).toArray();
      const totals = aggregateRows(rows);

      const byFuero = {};
      const byHour = {};
      for (let h = 0; h < 24; h++) byHour[h] = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };

      for (const r of rows) {
        if (!byFuero[r.fuero]) byFuero[r.fuero] = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };
        byFuero[r.fuero].captcha.resolved += r.captcha?.resolved || 0;
        byFuero[r.fuero].captcha.failed   += r.captcha?.failed   || 0;
        byFuero[r.fuero].docs.valid       += r.docs?.valid       || 0;
        byFuero[r.fuero].docs.invalid     += r.docs?.invalid     || 0;
        byFuero[r.fuero].docs.error       += r.docs?.error       || 0;
        byFuero[r.fuero].docs.total       += r.docs?.total       || 0;

        byHour[r.hour].captcha.resolved += r.captcha?.resolved || 0;
        byHour[r.hour].captcha.failed   += r.captcha?.failed   || 0;
        byHour[r.hour].docs.valid       += r.docs?.valid       || 0;
        byHour[r.hour].docs.invalid     += r.docs?.invalid     || 0;
        byHour[r.hour].docs.error       += r.docs?.error       || 0;
        byHour[r.hour].docs.total       += r.docs?.total       || 0;
      }

      res.json({ success: true, data: { date, totals, byFuero, byHour } });
    } catch (error) {
      logger.error(`[scrapingStats] getDay error: ${error.message}`);
      res.status(500).json({ success: false, message: 'Error al obtener estadísticas del día' });
    }
  },

  /**
   * GET /api/scraping-stats/month/:yearMonth
   * Totales del mes + desglose por día.
   * Params: yearMonth = YYYY-MM
   * Query:  ?fuero=CIV  (opcional)
   */
  async getMonth(req, res) {
    try {
      const { yearMonth } = req.params;
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ success: false, message: 'Formato inválido (YYYY-MM)' });
      }
      const { fuero } = req.query;
      const match = { date: { $regex: `^${yearMonth}` } };
      if (fuero) match.fuero = fuero.toUpperCase();

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: { date: '$date', fuero: '$fuero' },
            captchaResolved: { $sum: '$captcha.resolved' },
            captchaFailed:   { $sum: '$captcha.failed' },
            docsValid:       { $sum: '$docs.valid' },
            docsInvalid:     { $sum: '$docs.invalid' },
            docsError:       { $sum: '$docs.error' },
            docsTotal:       { $sum: '$docs.total' }
          }
        },
        { $sort: { '_id.date': 1, '_id.fuero': 1 } }
      ];

      const rows = await collection().aggregate(pipeline).toArray();

      const totals = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };
      const byDay  = {};

      for (const r of rows) {
        const d = r._id.date;
        if (!byDay[d]) byDay[d] = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 }, byFuero: {} };

        byDay[d].captcha.resolved += r.captchaResolved;
        byDay[d].captcha.failed   += r.captchaFailed;
        byDay[d].docs.valid       += r.docsValid;
        byDay[d].docs.invalid     += r.docsInvalid;
        byDay[d].docs.error       += r.docsError;
        byDay[d].docs.total       += r.docsTotal;
        byDay[d].byFuero[r._id.fuero] = {
          captcha: { resolved: r.captchaResolved, failed: r.captchaFailed },
          docs:    { valid: r.docsValid, invalid: r.docsInvalid, error: r.docsError, total: r.docsTotal }
        };

        totals.captcha.resolved += r.captchaResolved;
        totals.captcha.failed   += r.captchaFailed;
        totals.docs.valid       += r.docsValid;
        totals.docs.invalid     += r.docsInvalid;
        totals.docs.error       += r.docsError;
        totals.docs.total       += r.docsTotal;
      }

      res.json({ success: true, data: { month: yearMonth, totals, byDay } });
    } catch (error) {
      logger.error(`[scrapingStats] getMonth error: ${error.message}`);
      res.status(500).json({ success: false, message: 'Error al obtener estadísticas del mes' });
    }
  },

  /**
   * GET /api/scraping-stats/range
   * Totales para un rango de fechas + desglose por día.
   * Query: from=YYYY-MM-DD, to=YYYY-MM-DD, fuero=CIV (opcional)
   */
  async getRange(req, res) {
    try {
      const { from, to, fuero } = req.query;
      if (!from || !to) {
        return res.status(400).json({ success: false, message: 'Parámetros requeridos: from, to (YYYY-MM-DD)' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ success: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });
      }

      const match = { date: { $gte: from, $lte: to } };
      if (fuero) match.fuero = fuero.toUpperCase();

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: { date: '$date', fuero: '$fuero' },
            captchaResolved: { $sum: '$captcha.resolved' },
            captchaFailed:   { $sum: '$captcha.failed' },
            docsValid:       { $sum: '$docs.valid' },
            docsInvalid:     { $sum: '$docs.invalid' },
            docsError:       { $sum: '$docs.error' },
            docsTotal:       { $sum: '$docs.total' }
          }
        },
        { $sort: { '_id.date': 1, '_id.fuero': 1 } }
      ];

      const rows = await collection().aggregate(pipeline).toArray();

      const totals = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 } };
      const byDay  = {};

      for (const r of rows) {
        const d = r._id.date;
        if (!byDay[d]) byDay[d] = { captcha: { resolved: 0, failed: 0 }, docs: { valid: 0, invalid: 0, error: 0, total: 0 }, byFuero: {} };
        byDay[d].captcha.resolved += r.captchaResolved;
        byDay[d].captcha.failed   += r.captchaFailed;
        byDay[d].docs.valid       += r.docsValid;
        byDay[d].docs.invalid     += r.docsInvalid;
        byDay[d].docs.error       += r.docsError;
        byDay[d].docs.total       += r.docsTotal;
        byDay[d].byFuero[r._id.fuero] = {
          captcha: { resolved: r.captchaResolved, failed: r.captchaFailed },
          docs:    { valid: r.docsValid, invalid: r.docsInvalid, error: r.docsError, total: r.docsTotal }
        };

        totals.captcha.resolved += r.captchaResolved;
        totals.captcha.failed   += r.captchaFailed;
        totals.docs.valid       += r.docsValid;
        totals.docs.invalid     += r.docsInvalid;
        totals.docs.error       += r.docsError;
        totals.docs.total       += r.docsTotal;
      }

      res.json({ success: true, data: { from, to, totals, byDay } });
    } catch (error) {
      logger.error(`[scrapingStats] getRange error: ${error.message}`);
      res.status(500).json({ success: false, message: 'Error al obtener estadísticas del rango' });
    }
  }
};

module.exports = scrapingStatsController;
