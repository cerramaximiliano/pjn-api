const express = require('express');
const router = express.Router();
const configuracionVerificacionController = require('../controllers/configuracionVerificacionController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Ruta para obtener todas las configuraciones
router.get('/', verifyToken, configuracionVerificacionController.findAll);

// Ruta para modificar una configuración por _id - requiere rol de administrador
router.put('/:id', verifyToken, verifyAdmin, configuracionVerificacionController.updateById);

module.exports = router;