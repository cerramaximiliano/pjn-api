/**
 * plazosRoutes.js — Rutas admin del subsistema de plazos procesales.
 * Montado en /api/admin/plazos (ver routes/index.js).
 *
 * ⚠️ Datos reales solo en la instancia LOCAL de pjn-api (worker_01) — las
 * colecciones viven en su Mongo local. La admin UI consume vía workersAxios.
 */
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/plazosController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Notificaciones (cédulas detectadas + cómputo)
router.get("/notificaciones", verifyToken, verifyAdmin, ctrl.listNotificaciones);
router.get("/notificaciones/stats", verifyToken, verifyAdmin, ctrl.statsNotificaciones);
router.post("/notificaciones/reprocess-parsed", verifyToken, verifyAdmin, ctrl.reprocessParsed);
router.get("/notificaciones/:id", verifyToken, verifyAdmin, ctrl.getNotificacion);
router.post("/notificaciones/:id/reprocess", verifyToken, verifyAdmin, ctrl.reprocessNotificacion);

// Vencimientos próximos (vista operativa)
router.get("/vencimientos", verifyToken, verifyAdmin, ctrl.listVencimientos);

// Normativa (reglas de plazo subsidiario — curación del admin)
router.get("/normativa", verifyToken, verifyAdmin, ctrl.listNormativa);
router.post("/normativa", verifyToken, verifyAdmin, ctrl.createNormativa);
router.patch("/normativa/:id", verifyToken, verifyAdmin, ctrl.updateNormativa);

// Dataset de plazos expresos (minería de reglas empíricas)
router.get("/dataset", verifyToken, verifyAdmin, ctrl.listDataset);
router.get("/dataset/stats", verifyToken, verifyAdmin, ctrl.statsDataset);
router.get("/dataset/candidatos", verifyToken, verifyAdmin, ctrl.candidatosDataset);
router.patch("/dataset/:id/revision", verifyToken, verifyAdmin, ctrl.revisarDatasetEjemplo);
router.get("/dataset-config", verifyToken, verifyAdmin, ctrl.getDatasetConfig);
router.patch("/dataset-config", verifyToken, verifyAdmin, ctrl.updateDatasetConfig);

// Feriados (calendario de días inhábiles)
router.get("/feriados", verifyToken, verifyAdmin, ctrl.listFeriados);
router.post("/feriados", verifyToken, verifyAdmin, ctrl.createFeriados);
router.patch("/feriados/:id", verifyToken, verifyAdmin, ctrl.updateFeriado);

module.exports = router;
