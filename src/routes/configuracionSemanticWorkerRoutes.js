'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configuracionSemanticWorkerController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/', verifyToken, ctrl.getConfig);
router.put('/', verifyToken, verifyAdmin, ctrl.updateConfig);

module.exports = router;
