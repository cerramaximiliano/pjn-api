/**
 * Rutas del relevamiento del haber de caja (admin): resumen de pasadas, casos, revisión manual de constancias leídas
 * por OCR y desvíos de ANSES frente a la norma. Datos en el rs0 (colecciones previsional-hc-*).
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/hcRelevamientoController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.use(verifyToken);
router.use(verifyAdmin);

router.get('/resumen', controller.getResumen);
router.get('/casos', controller.listCasos);
router.get('/casos/:id', controller.getCaso);
router.put('/casos/:id/revision', controller.putRevision);
router.get('/desvios', controller.getDesvios);

module.exports = router;
