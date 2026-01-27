/**
 * Rutas para Manager Config
 * Endpoints para gestionar la configuración del App Update Manager
 */
const express = require('express');
const router = express.Router();
const managerConfigController = require('../controllers/managerConfigController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación y rol admin
router.use(verifyToken);
router.use(verifyAdmin);

// Obtener configuración completa del manager
// GET /api/manager-config
router.get('/', managerConfigController.getConfig);

// Obtener solo los valores de configuración
// GET /api/manager-config/settings
router.get('/settings', managerConfigController.getSettings);

// Actualizar valores de configuración
// PATCH /api/manager-config/settings
router.patch('/settings', managerConfigController.updateSettings);

// Obtener estado actual del manager
// GET /api/manager-config/status
router.get('/status', managerConfigController.getCurrentStatus);

// Obtener historial de snapshots
// GET /api/manager-config/history?hours=24
router.get('/history', managerConfigController.getHistory);

// Obtener alertas activas
// GET /api/manager-config/alerts
router.get('/alerts', managerConfigController.getAlerts);

// Reconocer una alerta
// POST /api/manager-config/alerts/:index/acknowledge
router.post('/alerts/:index/acknowledge', managerConfigController.acknowledgeAlert);

// Resetear configuración a valores por defecto
// POST /api/manager-config/reset
router.post('/reset', managerConfigController.resetToDefaults);

module.exports = router;
