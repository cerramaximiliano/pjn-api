'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cijurController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todo el subsistema CIJur es de uso admin
router.use(verifyToken, verifyAdmin);

// ── Config del worker ──────────────────────────────────────────────────────
router.get('/config', ctrl.listConfigs);
router.get('/progress', ctrl.progress);
router.post('/config/:workerId/enable', ctrl.setEnabled);
router.post('/config/:workerId/disable', ctrl.setEnabled);
router.patch('/config/:workerId/scraping', ctrl.updateScraping);
router.patch('/config/:workerId/notification', ctrl.updateNotification);

// ── Fallos ─────────────────────────────────────────────────────────────────
// '/fallos/stats' va antes que '/fallos/:id' o 'stats' se toma como un id.
router.get('/fallos', ctrl.listFallos);
router.get('/fallos/stats', ctrl.statsFallos);
router.get('/fallos/:id', ctrl.getFallo);

module.exports = router;
