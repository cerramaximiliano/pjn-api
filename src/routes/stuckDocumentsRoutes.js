/**
 * Rutas para Stuck Documents Worker
 * Endpoints para consultar estadísticas y gestionar documentos atorados
 */
const express = require('express');
const router = express.Router();
const stuckDocumentsController = require('../controllers/stuckDocumentsController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación y rol admin
router.use(verifyToken);
router.use(verifyAdmin);

// Estadísticas completas del worker
// GET /api/workers/stuck-documents/stats?hours=24
router.get('/stats', stuckDocumentsController.getStats);

// Lista de documentos stuck pendientes
// GET /api/workers/stuck-documents/pending?fuero=CIV&source=app&page=1&limit=20
router.get('/pending', stuckDocumentsController.getPendingDocuments);

// Logs recientes del worker
// GET /api/workers/stuck-documents/logs?hours=24&status=failed&limit=50
router.get('/logs', stuckDocumentsController.getRecentLogs);

// Marcar documento como archivado (excluir del procesamiento)
// POST /api/workers/stuck-documents/archive/:fuero/:id
router.post('/archive/:fuero/:id', stuckDocumentsController.archiveDocument);

// Desarchivar documento (volver a incluir en procesamiento)
// POST /api/workers/stuck-documents/unarchive/:fuero/:id
router.post('/unarchive/:fuero/:id', stuckDocumentsController.unarchiveDocument);

// Habilitar/deshabilitar worker
// POST /api/workers/stuck-documents/toggle
router.post('/toggle', stuckDocumentsController.toggleWorker);

// Obtener configuración completa del worker
// GET /api/workers/stuck-documents/config
router.get('/config', stuckDocumentsController.getConfig);

// Actualizar configuración del worker
// PATCH /api/workers/stuck-documents/config
router.patch('/config', stuckDocumentsController.updateConfig);

// Resetear estadísticas del worker
// POST /api/workers/stuck-documents/reset-stats
router.post('/reset-stats', stuckDocumentsController.resetStats);

module.exports = router;
