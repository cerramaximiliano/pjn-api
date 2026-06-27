/**
 * Rutas para NotifWorkerConfig — admin del sistema pjn-notificaciones-laborales-worker.
 *
 * Mount path: /api/notif-worker-config (registrado en routes/index.js).
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/configuracionNotifWorkerController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.use(verifyToken);
router.use(verifyAdmin);

// Config core
router.get('/', controller.getFull);
router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);
router.get('/status', controller.getStatus);
router.get('/alerts', controller.getAlerts);
router.post('/alerts/:index/acknowledge', controller.acknowledgeAlert);
router.post('/reset', controller.resetToDefaults);

// PM2 control
router.get('/pm2-status', controller.pm2Status);
router.post('/pm2/:action', controller.pm2Action);

// Documents exploration
router.get('/documents', controller.listDocuments);
router.get('/documents/:id', controller.getDocument);
router.get('/documents/:id/causa', controller.getDocumentCausa);

module.exports = router;
