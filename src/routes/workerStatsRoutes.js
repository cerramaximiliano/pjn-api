/**
 * Rutas para Worker Daily Stats
 * Endpoints para consultar estadísticas de los workers
 */
const express = require('express');
const router = express.Router();
const workerStatsController = require('../controllers/workerStatsController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación y rol admin
router.use(verifyToken);
router.use(verifyAdmin);

// Resumen del día actual
// GET /api/workers/stats/today?workerType=app-update
router.get('/stats/today', workerStatsController.getTodaySummary);

// Fechas disponibles con datos
// GET /api/workers/stats/available-dates?workerType=app-update
router.get('/stats/available-dates', workerStatsController.getAvailableDates);

// Estadísticas por rango de fechas
// GET /api/workers/stats/range?from=2024-01-01&to=2024-01-31&workerType=app-update&fuero=CIV
router.get('/stats/range', workerStatsController.getByDateRange);

// Estadísticas de un día específico
// GET /api/workers/stats/:date?workerType=app-update&fuero=CIV
router.get('/stats/:date', workerStatsController.getByDate);

// Estado actual de un fuero
// GET /api/workers/fuero/:fuero/status?workerType=app-update
router.get('/fuero/:fuero/status', workerStatsController.getFueroStatus);

// Errores recientes de un fuero
// GET /api/workers/fuero/:fuero/errors?workerType=app-update&limit=50
router.get('/fuero/:fuero/errors', workerStatsController.getFueroErrors);

// Alertas activas
// GET /api/workers/alerts
router.get('/alerts', workerStatsController.getActiveAlerts);

// Reconocer alerta
// POST /api/workers/alerts/:fuero/:alertType/acknowledge?workerType=app-update
router.post('/alerts/:fuero/:alertType/acknowledge', workerStatsController.acknowledgeAlert);

module.exports = router;
