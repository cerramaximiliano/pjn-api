/**
 * Rutas para Intervinientes
 * Maneja las operaciones para consultar intervinientes de causas judiciales
 */
const express = require('express');
const router = express.Router();
const intervinientesController = require('../controllers/intervinientesController');
const { verifyToken, verifyApiKey } = require('../middleware/auth');

// Ruta de prueba
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Intervinientes routes working',
        timestamp: new Date().toISOString()
    });
});

// Estadísticas (antes de rutas con parámetros)
router.get('/stats', verifyToken, intervinientesController.getStats);

// Búsqueda por nombre
router.get('/buscar/nombre', verifyToken, intervinientesController.findByNombre);

// Búsqueda por expediente (fuero/número/año)
router.get('/expediente/:fuero/:number/:year', verifyToken, intervinientesController.findByExpediente);

// Búsqueda por causaId (ruta principal solicitada)
router.get('/causa/:causaId', verifyToken, intervinientesController.findByCausaId);

// Obtener todos con paginación y filtros
router.get('/', verifyToken, intervinientesController.findAll);

// Obtener por ID de interviniente
router.get('/:id', verifyToken, intervinientesController.findById);

module.exports = router;
