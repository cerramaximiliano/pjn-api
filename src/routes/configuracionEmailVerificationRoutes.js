const express = require('express');
const router = express.Router();
const configuracionEmailVerificationController = require('../controllers/configuracionEmailVerificationController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Obtener configuración de verificación de email
router.get('/', verifyToken, configuracionEmailVerificationController.findAll);

// Modificar configuración - requiere rol de administrador
router.put('/:id', verifyToken, verifyAdmin, configuracionEmailVerificationController.updateById);

// Resetear contadores diarios - requiere rol de administrador
router.post('/:id/reset-daily', verifyToken, verifyAdmin, configuracionEmailVerificationController.resetDailyCounters);

// Limpiar estado de procesamiento - requiere rol de administrador
router.post('/:id/clear-processing', verifyToken, verifyAdmin, configuracionEmailVerificationController.clearProcessingState);

module.exports = router;
