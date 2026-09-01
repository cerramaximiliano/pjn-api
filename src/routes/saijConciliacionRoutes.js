'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/saijConciliacionController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Lectura — requiere token
router.get('/',              verifyToken, ctrl.list);
router.get('/resumen',       verifyToken, ctrl.resumen);
router.get('/buscar-causa',  verifyToken, ctrl.buscarCausa);
// Contexto SAIJ de una causa puntual (para la vista Causas en Update).
// Registrada ANTES de '/:id' para que el path no caiga en ese matcher.
router.get('/causa/:fuero/:causaId', verifyToken, ctrl.causaSaij);
router.get('/:id',           verifyToken, ctrl.detalle);

// Escritura — requiere admin. Todas dejan rastro en el updateHistory de la
// causa con el email de quien las ejecutó.
router.post('/escanear',            verifyToken, verifyAdmin, ctrl.escanear);
router.post('/desvincular-lote',    verifyToken, verifyAdmin, ctrl.desvincularLote);
router.post('/desvincular-directo', verifyToken, verifyAdmin, ctrl.desvincularDirecto);
router.post('/:id/confirmar',       verifyToken, verifyAdmin, ctrl.confirmar);
router.post('/:id/desvincular',     verifyToken, verifyAdmin, ctrl.desvincular);
router.post('/:id/reaparear',       verifyToken, verifyAdmin, ctrl.reaparear);
router.post('/:id/ignorar',         verifyToken, verifyAdmin, ctrl.ignorar);

module.exports = router;
