const express = require("express");
const router = express.Router();
const serverController = require("../controllers/serverController");
const { verifyToken, verifyAdmin, verifyApiKey } = require("../middleware/auth");

/**
 * Rutas públicas (sin autenticación requerida)
 */
// GET /servers/test - Health check de la ruta
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Server routes working" });
});

/**
 * Rutas que requieren autenticación (Token o API Key)
 */
// GET /servers/stats - Obtener estadísticas (debe ir antes de /:id)
router.get("/stats", verifyToken, serverController.getStats);

// GET /servers/type/:type - Obtener servidores por tipo
router.get("/type/:type", verifyToken, serverController.findByType);

// GET /servers/tags/:tags - Obtener servidores por tags
router.get("/tags/:tags", verifyToken, serverController.findByTags);

// GET /servers/slug/:slug - Obtener servidor por slug
router.get("/slug/:slug", verifyToken, serverController.findBySlug);

// GET /servers - Listar todos los servidores con paginación y filtros
router.get("/", verifyToken, serverController.findAll);

// GET /servers/:id - Obtener servidor por ID
router.get("/:id", verifyToken, serverController.findById);

/**
 * Rutas que requieren autenticación + rol Admin
 */
// POST /servers - Crear nuevo servidor
router.post("/", verifyToken, verifyAdmin, serverController.create);

// PUT /servers/:id - Actualizar servidor completo
router.put("/:id", verifyToken, verifyAdmin, serverController.updateById);

// PATCH /servers/:id - Actualización parcial de servidor
router.patch("/:id", verifyToken, verifyAdmin, serverController.patchById);

// DELETE /servers/:id - Eliminar servidor
router.delete("/:id", verifyToken, verifyAdmin, serverController.deleteById);

// PATCH /servers/:id/status - Actualizar estado del servidor
router.patch("/:id/status", verifyToken, verifyAdmin, serverController.updateStatus);

// PATCH /servers/:id/health - Actualizar health check
router.patch("/:id/health", verifyToken, verifyAdmin, serverController.updateHealthCheck);

/**
 * Rutas para gestión de credenciales (requieren Admin)
 */
// POST /servers/:id/credentials - Agregar credencial
router.post("/:id/credentials", verifyToken, verifyAdmin, serverController.addCredential);

// DELETE /servers/:id/credentials/:credentialId - Eliminar credencial
router.delete(
  "/:id/credentials/:credentialId",
  verifyToken,
  verifyAdmin,
  serverController.removeCredential
);

/**
 * Rutas para gestión de aplicaciones (requieren Admin para modificar)
 */
// GET /servers/:id/applications - Obtener aplicaciones del servidor
router.get("/:id/applications", verifyToken, serverController.getApplications);

// POST /servers/:id/applications - Agregar aplicación
router.post("/:id/applications", verifyToken, verifyAdmin, serverController.addApplication);

// PUT /servers/:id/applications/:appId - Actualizar aplicación
router.put(
  "/:id/applications/:appId",
  verifyToken,
  verifyAdmin,
  serverController.updateApplication
);

// DELETE /servers/:id/applications/:appId - Eliminar aplicación
router.delete(
  "/:id/applications/:appId",
  verifyToken,
  verifyAdmin,
  serverController.removeApplication
);

/**
 * Rutas para gestión de red (requieren Admin)
 */
// PATCH /servers/:id/network - Actualizar información de red
router.patch("/:id/network", verifyToken, verifyAdmin, serverController.updateNetwork);

/**
 * Rutas alternativas con API Key (para acceso programático)
 */
// GET /servers/api/list - Listar servidores con API Key
router.get("/api/list", verifyApiKey, serverController.findAll);

// GET /servers/api/:id - Obtener servidor por ID con API Key
router.get("/api/:id", verifyApiKey, serverController.findById);

// GET /servers/api/type/:type - Obtener servidores por tipo con API Key
router.get("/api/type/:type", verifyApiKey, serverController.findByType);

module.exports = router;
