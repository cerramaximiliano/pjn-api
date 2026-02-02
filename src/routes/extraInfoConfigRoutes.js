/**
 * Rutas para Extra-Info Config
 * Gestión de configuración del Extra-Info Worker
 */
const express = require('express');
const router = express.Router();
const extraInfoConfigController = require('../controllers/extraInfoConfigController');

// GET /api/extra-info-config - Obtener configuración completa
router.get('/', extraInfoConfigController.getConfig);

// GET /api/extra-info-config/stats - Obtener resumen de estadísticas
router.get('/stats', extraInfoConfigController.getStats);

// GET /api/extra-info-config/status - Obtener estado actual del worker
router.get('/status', extraInfoConfigController.getStatus);

// PATCH /api/extra-info-config - Actualizar configuración
router.patch('/', extraInfoConfigController.updateConfig);

// POST /api/extra-info-config/toggle - Habilitar/deshabilitar worker
router.post('/toggle', extraInfoConfigController.toggleEnabled);

// POST /api/extra-info-config/reset-stats - Resetear estadísticas
router.post('/reset-stats', extraInfoConfigController.resetStats);

// GET /api/extra-info-config/users-with-sync - Usuarios con sincronización habilitada (solo habilitados)
router.get('/users-with-sync', extraInfoConfigController.getUsersWithSyncEnabled);

// GET /api/extra-info-config/users - Todos los usuarios con paginación y filtros
router.get('/users', extraInfoConfigController.getAllUsers);

// PATCH /api/extra-info-config/users/bulk-sync - Actualización masiva de preferencias
router.patch('/users/bulk-sync', extraInfoConfigController.bulkUpdateUserSyncPreference);

// PATCH /api/extra-info-config/users/:userId/sync - Actualizar preferencia de un usuario
router.patch('/users/:userId/sync', extraInfoConfigController.updateUserSyncPreference);

// GET /api/extra-info-config/eligible-count - Documentos elegibles
router.get('/eligible-count', extraInfoConfigController.getEligibleCount);

// GET /api/extra-info-config/intervinientes-stats - Estadísticas de intervinientes
router.get('/intervinientes-stats', extraInfoConfigController.getIntervinientesStats);

// ===== ESTADÍSTICAS DIARIAS (HISTORIAL) =====

// GET /api/extra-info-config/daily-stats - Historial de estadísticas diarias
router.get('/daily-stats', extraInfoConfigController.getDailyStats);

// GET /api/extra-info-config/daily-stats/summary - Resumen por período
router.get('/daily-stats/summary', extraInfoConfigController.getDailyStatsSummary);

// GET /api/extra-info-config/daily-stats/today - Estadísticas del día actual
router.get('/daily-stats/today', extraInfoConfigController.getTodayStats);

// POST /api/extra-info-config/daily-stats/cleanup - Limpiar estadísticas antiguas
router.post('/daily-stats/cleanup', extraInfoConfigController.cleanupDailyStats);

module.exports = router;
