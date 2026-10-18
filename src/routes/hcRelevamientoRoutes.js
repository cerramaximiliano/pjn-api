/**
 * Rutas del relevamiento del haber de caja (admin): resumen de pasadas, casos, revisión manual de constancias leídas
 * por OCR, carga del PRPA original y desvíos de ANSES frente a la norma. Datos en el rs0 (colecciones previsional-hc-*
 * y previsional-prpa-cargas); los originales, en un bucket S3 privado.
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

// Evaluador BlueCorp (anexos del haber de caja de las liquidaciones de programa)
router.get('/programa/resumen', controller.getProgramaResumen);
router.get('/programa/anexos', controller.listProgramaAnexos);
router.get('/programa/anexos/:id', controller.getProgramaAnexo);

// PRPA original: el cuerpo es el archivo crudo (PDF/JPG/PNG, hasta 30 MB; nginx tiene su propio límite para esta ruta)
router.post('/cargas', express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '30mb' }), controller.crearCarga);
router.get('/cargas', controller.listCargas);
router.get('/cargas/:id', controller.getCarga);

module.exports = router;
