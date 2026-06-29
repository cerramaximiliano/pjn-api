const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/monitoringController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// GET  /api/monitoring/overview — último snapshot integral (Qdrant + Mongo local + Atlas + host)
router.get('/overview', verifyToken, verifyAdmin, ctrl.overview);

// GET  /api/monitoring/history?hours=168 — histórico para tendencia/proyección
router.get('/history', verifyToken, verifyAdmin, ctrl.history);

// POST /api/monitoring/refresh — fuerza snapshot (solo instancia local worker_01)
router.post('/refresh', verifyToken, verifyAdmin, ctrl.refresh);

module.exports = router;
