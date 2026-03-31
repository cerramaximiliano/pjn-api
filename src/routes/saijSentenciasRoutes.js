'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/saijSentenciasController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Lectura — requiere token
router.get('/',              verifyToken,             ctrl.list);
router.get('/stats',         verifyToken,             ctrl.stats);
router.get('/saij/:saijId',  verifyToken,             ctrl.getBySaijId);
router.get('/:id',           verifyToken,             ctrl.getById);

// Escritura — requiere admin
router.patch('/:id',         verifyToken, verifyAdmin, ctrl.update);
router.delete('/:id',        verifyToken, verifyAdmin, ctrl.remove);

module.exports = router;
