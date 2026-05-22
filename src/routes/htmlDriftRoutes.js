/**
 * Rutas para HTML Drift del portal PJN.
 * Endpoints para visualizar drifts estructurales y fingerprints.
 */
const express = require('express');
const router = express.Router();
const htmlDriftController = require('../controllers/htmlDriftController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren auth + rol admin (igual que managerConfigRoutes).
router.use(verifyToken);
router.use(verifyAdmin);

// Listar drifts con filtros + summary
// GET /api/html-drift/incidents?limit=50&skip=0&resolved=true&sinceDays=7&type=...
router.get('/incidents', htmlDriftController.getIncidents);

// Estadísticas de fingerprints HTML (avg spans, selectores, serie temporal)
// GET /api/html-drift/fingerprints/stats?days=7
router.get('/fingerprints/stats', htmlDriftController.getFingerprintStats);

// Cerrar manualmente un drift (acknowledge)
// POST /api/html-drift/incidents/:id/close
router.post('/incidents/:id/close', htmlDriftController.closeIncident);

// Disparar análisis on-demand (placeholder, no implementado)
// POST /api/html-drift/analyzer/run
router.post('/analyzer/run', htmlDriftController.runAnalyzer);

module.exports = router;
