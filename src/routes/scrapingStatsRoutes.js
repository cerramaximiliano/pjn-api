/**
 * Rutas para métricas de scraping (captchas y documentos)
 * Colección: scraping-hourly-stats (generada por pjn-workers-scraping)
 *
 * GET /api/scraping-stats/today               → día actual (con desglose por hora y fuero)
 * GET /api/scraping-stats/day/:date            → día específico YYYY-MM-DD
 * GET /api/scraping-stats/month/:yearMonth     → mes YYYY-MM (con desglose por día)
 * GET /api/scraping-stats/range?from=&to=      → rango de fechas
 *
 * Todos los endpoints aceptan ?fuero=CIV para filtrar por fuero.
 * Requieren autenticación + rol admin.
 */

const express = require('express');
const router = express.Router();
const scrapingStatsController = require('../controllers/scrapingStatsController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.use(verifyToken);
router.use(verifyAdmin);

router.get('/today',              scrapingStatsController.getToday);
router.get('/range',              scrapingStatsController.getRange);
router.get('/day/:date',          scrapingStatsController.getDay);
router.get('/month/:yearMonth',   scrapingStatsController.getMonth);

module.exports = router;
