const express = require('express');
const router = express.Router();
const configuracionScrapingHistoryController = require('../controllers/configuracionScrapingHistoryController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Obtener todo el historial (con filtros opcionales)
router.get('/', verifyToken, configuracionScrapingHistoryController.findAll);

// Obtener historial por configuración
router.get('/configuracion/:configuracionId', verifyToken, configuracionScrapingHistoryController.findByConfiguracion);

// Obtener historial por fuero y año
router.get('/fuero/:fuero/year/:year', verifyToken, configuracionScrapingHistoryController.findByFueroAndYear);

// Obtener estadísticas agregadas por fuero y año
router.get('/stats/fuero/:fuero/year/:year', verifyToken, configuracionScrapingHistoryController.getStatsByFueroAndYear);

// Verificar rangos superpuestos
router.get('/check-overlapping', verifyToken, configuracionScrapingHistoryController.checkOverlappingRanges);

// Eliminar un registro del historial (solo admin)
router.delete('/:id', verifyToken, verifyAdmin, configuracionScrapingHistoryController.deleteById);

module.exports = router;