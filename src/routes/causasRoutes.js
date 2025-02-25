const express = require('express');
const router = express.Router();
const causasController = require('../controllers/causasController');

// Añadir una ruta de prueba para verificar que el router funciona
router.get('/test', (req, res) => {
  res.json({ message: 'Router de causas funcionando' });
});

// Rutas principales
router.get('/:fuero/:number/:year', causasController.findByNumberAndYear);
router.get('/:fuero/objetos', causasController.listObjetos);
router.get('/:fuero/buscar/objeto', causasController.findByObjeto);
router.get('/:fuero/buscar', causasController.searchAdvanced);
router.post('/:fuero/agregar', causasController.addCausa);

module.exports = router;