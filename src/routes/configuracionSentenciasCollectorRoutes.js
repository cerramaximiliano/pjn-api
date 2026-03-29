'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configuracionSentenciasCollectorController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/', verifyToken, ctrl.getConfig);
router.put('/', verifyToken, verifyAdmin, ctrl.updateConfig);
router.post('/reset-all-cursors', verifyToken, verifyAdmin, ctrl.resetAllCursors);
router.post('/:fuero/reset-cursor', verifyToken, verifyAdmin, ctrl.resetFueroCursor);

module.exports = router;
