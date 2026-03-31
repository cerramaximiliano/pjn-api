'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/saijConfigController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas de config son admin
router.use(verifyToken, verifyAdmin);

router.get('/',                           ctrl.list);
router.get('/:workerId',                  ctrl.getOne);
router.get('/:workerId/history',          ctrl.getHistory);
router.get('/:workerId/stats',            ctrl.getStats);
router.post('/:workerId/enable',          ctrl.enable);
router.post('/:workerId/disable',         ctrl.disable);
router.post('/:workerId/pause',           ctrl.pause);
router.post('/:workerId/resume',          ctrl.resume);
router.patch('/:workerId/cursor',         ctrl.resetCursor);
router.patch('/:workerId/scraping',       ctrl.updateScraping);
router.patch('/:workerId/notification',   ctrl.updateNotification);

module.exports = router;
