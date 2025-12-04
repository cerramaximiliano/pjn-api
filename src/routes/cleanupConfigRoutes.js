/**
 * Rutas para la configuración del worker de limpieza de logs
 *
 * Base path: /api/cleanup-config
 */

const express = require("express");
const router = express.Router();
const cleanupConfigController = require("../controllers/cleanupConfigController");
const { verifyToken, verifyAdmin, verifyApiKey } = require("../middleware/auth");

// ============================================================
// RUTAS PÚBLICAS (solo lectura de estado)
// ============================================================

// GET /api/cleanup-config/status - Estado actual del worker
router.get("/status", verifyToken, cleanupConfigController.getStatus);

// GET /api/cleanup-config/history - Historial de ejecuciones
router.get("/history", verifyToken, cleanupConfigController.getHistory);

// ============================================================
// RUTAS PROTEGIDAS (requieren autenticación)
// ============================================================

// GET /api/cleanup-config - Obtener configuración completa
router.get("/", verifyToken, cleanupConfigController.getConfig);

// ============================================================
// RUTAS DE ADMINISTRACIÓN (requieren rol admin)
// ============================================================

// PUT /api/cleanup-config - Actualizar configuración completa
router.put("/", verifyToken, verifyAdmin, cleanupConfigController.updateConfig);

// PATCH /api/cleanup-config/retention - Actualizar retención
router.patch("/retention", verifyToken, verifyAdmin, cleanupConfigController.updateRetention);

// PATCH /api/cleanup-config/schedule - Actualizar schedule
router.patch("/schedule", verifyToken, verifyAdmin, cleanupConfigController.updateSchedule);

// POST /api/cleanup-config/enable - Habilitar worker
router.post("/enable", verifyToken, verifyAdmin, cleanupConfigController.enable);

// POST /api/cleanup-config/disable - Deshabilitar worker
router.post("/disable", verifyToken, verifyAdmin, cleanupConfigController.disable);

// POST /api/cleanup-config/pause - Pausar worker (mantenimiento)
router.post("/pause", verifyToken, verifyAdmin, cleanupConfigController.pause);

// POST /api/cleanup-config/resume - Reanudar worker
router.post("/resume", verifyToken, verifyAdmin, cleanupConfigController.resume);

// POST /api/cleanup-config/reset - Resetear a valores por defecto
router.post("/reset", verifyToken, verifyAdmin, cleanupConfigController.resetToDefaults);

// ============================================================
// RUTAS INTERNAS (para el worker, protegidas por API Key)
// ============================================================

// POST /api/cleanup-config/record-execution - Registrar ejecución
// Usado internamente por el script de limpieza
router.post("/record-execution", verifyApiKey, cleanupConfigController.recordExecution);

module.exports = router;
