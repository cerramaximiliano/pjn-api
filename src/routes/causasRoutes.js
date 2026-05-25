const express = require('express');
const router = express.Router();
const causasController = require('../controllers/causasController');
const { verifyToken, verifyAdmin, verifyApiKey } = require('../middleware/auth');

// Añadir una ruta de prueba para verificar que el router funciona
router.get('/test', (req, res) => {
  res.json({ message: 'Router de causas funcionando' });
});

// Ruta para obtener estadísticas de causas (para dashboard)
router.get('/stats', verifyToken, causasController.getStats);

// Ruta para obtener estadísticas de elegibilidad para actualización
// GET /api/causas/stats/eligibility?fuero=CIV&thresholdHours=2
router.get('/stats/eligibility', verifyToken, causasController.getEligibilityStats);

// Ruta para obtener estadísticas de capacidad de procesamiento
// GET /api/causas/stats/capacity?thresholdHours=2&workersPerFuero=3&workHoursPerDay=14
router.get('/stats/capacity', verifyToken, causasController.getCapacityStats);

// Resumen agregado de causas marcadas privadas (widget admin)
// GET /api/causas/stats/privacy
router.get('/stats/privacy', verifyToken, causasController.getPrivacyStats);

// Ruta para obtener todas las causas verificadas
router.get('/verified', verifyToken, causasController.getAllVerifiedCausas);

// Ruta para obtener todas las causas no verificadas (verified: true, isValid: false)
router.get('/non-verified', verifyToken, causasController.getAllNonVerifiedCausas);

// Causas con protección anti-eliminación activada (count > 0).
// GET /api/causas/admin/zero-movements-protection?fuero=CIV&page=1&limit=50&sortBy=count&sortOrder=desc
router.get('/admin/zero-movements-protection', verifyToken, verifyAdmin, causasController.getCausasWithZeroMovementsProtection);

// Rutas principales - todas protegidas con verifyToken
router.get('/:fuero/buscar/objeto', verifyToken, causasController.findByObjeto);
router.get('/:fuero/objetos', verifyToken, causasController.listObjetos);
router.get('/:fuero/buscar', verifyToken, causasController.searchAdvanced);
router.get('/:fuero/filtros', verifyApiKey, causasController.findByFilters);
router.get('/:fuero/folders', verifyToken, causasController.getCausasWithFolders);
router.get('/:fuero/:id/movimientos', verifyToken, causasController.getMovimientosByDocumentId);
// IMPORTANTE: Rutas específicas deben ir ANTES de rutas genéricas
router.get('/:fuero/:id/notification-users', verifyToken, causasController.getNotificationUsers);
router.get('/:fuero/id/:id', verifyToken, causasController.findById);
router.get('/:fuero/:number/:year', verifyToken, causasController.findByNumberAndYear);

// Ruta para agregar causas - requiere autenticación y rol de administrador
router.post('/:fuero/agregar', verifyToken, verifyAdmin, causasController.addCausa);

// Ruta para eliminar una causa por ID - requiere autenticación y rol de administrador
router.delete('/:fuero/:id', verifyToken, verifyAdmin, causasController.deleteCausaById);

// Ruta para actualizar una causa - requiere autenticación y rol de administrador
router.patch('/:fuero/:id', verifyToken, verifyAdmin, causasController.updateCausa);

// Marca una causa como vinculada/originada por SAIJ (consumida por saij-workers via X-Api-Key)
router.patch('/:fuero/:id/saij', verifyToken, verifyAdmin, causasController.markAsSaij);

// Ruta para eliminar un movimiento específico de una causa - requiere autenticación y rol de administrador
router.delete('/:fuero/:id/movimientos/:movimientoIndex', verifyToken, verifyAdmin, causasController.deleteMovimiento);

// Ruta para agregar un movimiento a una causa - requiere autenticación y rol de administrador
router.post('/:fuero/:id/movimientos', verifyToken, verifyAdmin, causasController.addMovimiento);

// Ruta para enviar notificación de un movimiento específico - requiere autenticación y rol de administrador
router.post('/:fuero/:id/movimientos/:movimientoIndex/notify', verifyToken, verifyAdmin, causasController.sendMovimientoNotification);

// Ruta para limpiar todo el historial de actualizaciones de una causa - requiere autenticación y rol de administrador
router.delete('/:fuero/:id/update-history', verifyToken, verifyAdmin, causasController.clearUpdateHistory);

// Ruta para eliminar una entrada específica del historial de actualizaciones - requiere autenticación y rol de administrador
router.delete('/:fuero/:id/update-history/:entryIndex', verifyToken, verifyAdmin, causasController.deleteUpdateHistoryEntry);

module.exports = router;