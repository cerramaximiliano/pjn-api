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

// Obtener análisis de cobertura por fuero y año
router.get('/coverage/fuero/:fuero/year/:year', verifyToken, configuracionScrapingHistoryController.getCoverageByFueroAndYear);

// Cobertura medida sobre las causas y no sobre el historial de rangos. Escanea
// el índice {number, year, incidente, fuero} del fuero pedido, así que es más
// cara que la anterior (~1-2 s por fuero/año) pero dice lo que realmente se barrió.
router.get('/coverage-real/fuero/:fuero/year/:year', verifyToken, configuracionScrapingHistoryController.getRealCoverageByFueroAndYear);

// Todos los años de un fuero en una sola pasada, para el panorama de la vista
// de cobertura. Una llamada por fuero en vez de una por fuero/año.
router.get('/coverage-matrix/fuero/:fuero', verifyToken, configuracionScrapingHistoryController.getCoverageMatrix);

// Eliminar un registro del historial (solo admin)
router.delete('/:id', verifyToken, verifyAdmin, configuracionScrapingHistoryController.deleteById);

module.exports = router;