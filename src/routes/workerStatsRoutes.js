/**
 * Rutas para Worker Daily Stats, Hourly Stats y Daily Summary
 * Endpoints para consultar estadísticas de los workers
 */
const express = require('express');
const router = express.Router();
const workerStatsController = require('../controllers/workerStatsController');
const workerStatsExtendedController = require('../controllers/workerStatsExtendedController');
const stuckDocumentsController = require('../controllers/stuckDocumentsController');
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

// ==================== HOURLY STATS ====================

// Estadísticas de las últimas N horas
// GET /api/workers/hourly/last/:hours?fuero=CIV&workerType=app-update
router.get('/hourly/last/:hours', workerStatsExtendedController.getLastNHours);

// Resumen del día agrupado por hora
// GET /api/workers/hourly/day/:date?fuero=CIV&workerType=app-update
router.get('/hourly/day/:date', workerStatsExtendedController.getDaySummaryByHour);

// Estadísticas de la hora actual
// GET /api/workers/hourly/current?workerType=app-update
router.get('/hourly/current', workerStatsExtendedController.getCurrentHourStats);

// Eventos de escalado recientes
// GET /api/workers/hourly/scaling-events?hours=24&fuero=CIV&workerType=app-update
router.get('/hourly/scaling-events', workerStatsExtendedController.getScalingEvents);

// ==================== DAILY SUMMARY ====================

// Resumen del día actual
// GET /api/workers/summary/today?workerType=app-update
router.get('/summary/today', workerStatsExtendedController.getTodaySummary);

// Resumen de un día específico
// GET /api/workers/summary/date/:date?workerType=app-update
router.get('/summary/date/:date', workerStatsExtendedController.getSummaryByDate);

// Resúmenes de los últimos N días
// GET /api/workers/summary/last/:days?workerType=app-update
router.get('/summary/last/:days', workerStatsExtendedController.getLastNDays);

// Datos para gráficos
// GET /api/workers/summary/chart?days=30&workerType=app-update
router.get('/summary/chart', workerStatsExtendedController.getChartData);

// Comparar dos días
// GET /api/workers/summary/compare?date1=2026-01-01&date2=2026-01-02&workerType=app-update
router.get('/summary/compare', workerStatsExtendedController.compareDays);

// Regenerar resumen de un día (útil para correcciones)
// POST /api/workers/summary/regenerate/:date?workerType=app-update
router.post('/summary/regenerate/:date', workerStatsExtendedController.regenerateSummary);

// ==================== STUCK DOCUMENTS WORKER ====================

// Estadísticas completas del stuck documents worker
// GET /api/workers/stuck-documents/stats?hours=24
router.get('/stuck-documents/stats', stuckDocumentsController.getStats);

// Lista de documentos stuck pendientes
// GET /api/workers/stuck-documents/pending?fuero=CIV&source=app&page=1&limit=20
router.get('/stuck-documents/pending', stuckDocumentsController.getPendingDocuments);

// Logs recientes del worker
// GET /api/workers/stuck-documents/logs?hours=24&status=failed&limit=50
router.get('/stuck-documents/logs', stuckDocumentsController.getRecentLogs);

// Marcar documento como archivado (excluir del procesamiento)
// POST /api/workers/stuck-documents/archive/:fuero/:id
router.post('/stuck-documents/archive/:fuero/:id', stuckDocumentsController.archiveDocument);

// Desarchivar documento (volver a incluir en procesamiento)
// POST /api/workers/stuck-documents/unarchive/:fuero/:id
router.post('/stuck-documents/unarchive/:fuero/:id', stuckDocumentsController.unarchiveDocument);

// Habilitar/deshabilitar worker
// POST /api/workers/stuck-documents/toggle
router.post('/stuck-documents/toggle', stuckDocumentsController.toggleWorker);

module.exports = router;
