/**
 * Rutas para Causas Update Worker Config y Runs
 * Gestión de configuración y historial de ejecuciones del worker de actualización de causas
 */
const express = require('express');
const router = express.Router();
const causasUpdateController = require('../controllers/causasUpdateController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación y rol admin
router.use(verifyToken);
router.use(verifyAdmin);

// ====== CONFIG ======

// Obtener configuración del worker
// GET /api/causas-update/config
router.get('/config', causasUpdateController.getConfig);

// Actualizar configuración (merge parcial)
// PATCH /api/causas-update/config
router.patch('/config', causasUpdateController.updateConfig);

// Resetear configuración a defaults
// POST /api/causas-update/config/reset
router.post('/config/reset', causasUpdateController.resetConfig);

// ====== RUNS ======

// Estadísticas agregadas (debe ir antes de /:id para no conflictar)
// GET /api/causas-update/runs/stats
router.get('/runs/stats', causasUpdateController.getStats);

// Runs incompletos pendientes de resume
// GET /api/causas-update/runs/incomplete
router.get('/runs/incomplete', causasUpdateController.getIncompleteRuns);

// Runs de una credencial específica
// GET /api/causas-update/runs/credential/:credId
router.get('/runs/credential/:credId', causasUpdateController.getCredentialRuns);

// Listar runs con paginación y filtros
// GET /api/causas-update/runs
router.get('/runs', causasUpdateController.getRuns);

// Detalle de un run específico
// GET /api/causas-update/runs/:id
router.get('/runs/:id', causasUpdateController.getRunDetail);

module.exports = router;
