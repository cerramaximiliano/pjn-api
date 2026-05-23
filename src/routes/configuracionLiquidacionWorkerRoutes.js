/**
 * Rutas para LiquidacionWorkerConfig — admin del sistema pjn-liquidacion-worker.
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/configuracionLiquidacionWorkerController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.use(verifyToken);
router.use(verifyAdmin);

router.get('/', controller.getFull);
router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);
router.get('/status', controller.getStatus);
router.get('/alerts', controller.getAlerts);
router.post('/alerts/:index/acknowledge', controller.acknowledgeAlert);
router.post('/reset', controller.resetToDefaults);

module.exports = router;
