const express = require("express");
const router = express.Router();
const workerLogController = require("../controllers/workerLogController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

/**
 * Worker Logs API Routes
 *
 * Todas las rutas requieren autenticación (verifyToken) y rol de administrador (verifyAdmin).
 * Rutas específicas deben ir ANTES de /:id para evitar conflictos.
 */

// GET /worker-logs/test - Health check de la ruta (público)
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Worker logs routes working" });
});

// GET /worker-logs/stats - Estadísticas generales
router.get("/stats", verifyToken, verifyAdmin, workerLogController.getStats);

// GET /worker-logs/failed - Logs fallidos con análisis de errores
router.get("/failed", verifyToken, verifyAdmin, workerLogController.getFailed);

// GET /worker-logs/activity - Actividad en tiempo real
router.get("/activity", verifyToken, verifyAdmin, workerLogController.getActivity);

// GET /worker-logs/workers - Lista de workers con su actividad
router.get("/workers", verifyToken, verifyAdmin, workerLogController.getWorkers);

// GET /worker-logs/count - Conteo por tipo
router.get("/count", verifyToken, verifyAdmin, workerLogController.getCount);

// GET /worker-logs/search-logs - Buscar en logs detallados
router.get("/search-logs", verifyToken, verifyAdmin, workerLogController.searchDetailedLogs);

// GET /worker-logs/logs-stats - Estadísticas de logs detallados
router.get("/logs-stats", verifyToken, verifyAdmin, workerLogController.getDetailedLogsStats);

// POST /worker-logs/cleanup - Limpieza de logs expirados
router.post("/cleanup", verifyToken, verifyAdmin, workerLogController.cleanupExpiredLogs);

// GET /worker-logs/document/:documentId - Logs de un documento específico
router.get("/document/:documentId", verifyToken, verifyAdmin, workerLogController.getByDocument);

// GET /worker-logs - Listar todos con filtros y paginación
router.get("/", verifyToken, verifyAdmin, workerLogController.findAll);

// GET /worker-logs/:id - Obtener log específico por ID
router.get("/:id", verifyToken, verifyAdmin, workerLogController.findById);

module.exports = router;
