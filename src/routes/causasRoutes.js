const express = require('express');
const router = express.Router();
const causasController = require('../controllers/causasController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Añadir una ruta de prueba para verificar que el router funciona
router.get('/test', (req, res) => {
  res.json({ message: 'Router de causas funcionando' });
});

// Ruta para obtener todas las causas verificadas
router.get('/verified', verifyToken, causasController.getAllVerifiedCausas);

// Rutas principales - todas protegidas con verifyToken
router.get('/:fuero/buscar/objeto', verifyToken, causasController.findByObjeto);
router.get('/:fuero/objetos', verifyToken, causasController.listObjetos);
router.get('/:fuero/buscar', verifyToken, causasController.searchAdvanced);
router.get('/:fuero/:id/movimientos', verifyToken, causasController.getMovimientosByDocumentId);
router.get('/:fuero/:number/:year', verifyToken, causasController.findByNumberAndYear);

// Ruta para agregar causas - requiere autenticación y rol de administrador
router.post('/:fuero/agregar', verifyToken, verifyAdmin, causasController.addCausa);

// Ruta para eliminar una causa por ID - requiere autenticación y rol de administrador
router.delete('/:fuero/:id', verifyToken, verifyAdmin, causasController.deleteCausaById);

module.exports = router;