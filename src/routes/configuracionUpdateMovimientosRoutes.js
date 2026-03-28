const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configuracionUpdateMovimientosController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Manager config
router.get('/manager', verifyToken, ctrl.getManagerConfig);
router.put('/manager', verifyToken, verifyAdmin, ctrl.updateManagerConfig);

// Worker configs (uno por fuero)
router.get('/', verifyToken, ctrl.findAll);
router.put('/:id', verifyToken, verifyAdmin, ctrl.updateById);

module.exports = router;
