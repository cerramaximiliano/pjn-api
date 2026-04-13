const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/sentenciasSearchController');
const { verifyToken } = require('../middleware/auth');

// POST /sentencias/buscar — búsqueda semántica por texto libre
router.post('/buscar', verifyToken, ctrl.buscar);

// POST /sentencias/buscar/similar — sentencias similares a una dada
router.post('/buscar/similar', verifyToken, ctrl.buscarSimilares);

// GET /sentencias/:id/chunks — texto completo de una sentencia (chunks de S3)
router.get('/:id/chunks', verifyToken, ctrl.getChunks);

module.exports = router;
