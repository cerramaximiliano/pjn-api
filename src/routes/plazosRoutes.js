/**
 * plazosRoutes.js — Rutas admin del subsistema de plazos procesales.
 * Montado en /api/admin/plazos (ver routes/index.js).
 *
 * Dos bases (10/10/2026): la instancia de caché (pjn/cache-api, MONGO_TARGET=rs0) sirve el laboratorio de
 * desarrollo; la instancia de Atlas (pjn/api) sirve las cédulas de usuarios. La admin elige con su selector
 * (workersAxios = caché, pjnAxios = Atlas). Reglas y feriados: copia maestra en Atlas.
 */
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/plazosController");
const rev = require("../controllers/plazosRevisionLegalController");
const pend = require("../controllers/plazosPendientesController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Notificaciones (cédulas detectadas + cómputo)
router.get("/notificaciones", verifyToken, verifyAdmin, ctrl.listNotificaciones);
router.get("/notificaciones/stats", verifyToken, verifyAdmin, ctrl.statsNotificaciones);
router.post("/notificaciones/reprocess-parsed", verifyToken, verifyAdmin, ctrl.reprocessParsed);
router.get("/notificaciones/:id", verifyToken, verifyAdmin, ctrl.getNotificacion);
router.post("/notificaciones/:id/reprocess", verifyToken, verifyAdmin, ctrl.reprocessNotificacion);

// Vencimientos próximos (vista operativa)
router.get("/vencimientos", verifyToken, verifyAdmin, ctrl.listVencimientos);

// Monitoreo consolidado del subsistema (workers + colas + alertas)
router.get("/monitor", verifyToken, verifyAdmin, ctrl.monitor);
// Contadores por etapa del flujo de plazos automáticos (solo base de usuarios).
router.get("/flujo", verifyToken, verifyAdmin, ctrl.flujo);
// Detalle unificado de una cédula de usuario (?movementId= | ?plazoId=).
router.get("/cedula", verifyToken, verifyAdmin, ctrl.cedula);

// Pendientes del usuario (decisiones, reglas que retienen, carpetas sin parte, entregas sin feedback, bandeja)
router.get("/pendientes", verifyToken, verifyAdmin, pend.pendientes);

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
// Revisión legal de plazos calculados (fase F0) — colección plazos-revision-legal
router.get("/revision-legal/muestras", verifyToken, verifyAdmin, rev.listarMuestras);
router.post("/revision-legal/muestras", verifyToken, verifyAdmin, rev.crearMuestra);
router.get("/revision-legal/stats", verifyToken, verifyAdmin, rev.stats);
router.get("/revision-legal/item/:id", verifyToken, verifyAdmin, rev.obtener);
router.patch("/revision-legal/item/:id", verifyToken, verifyAdmin, rev.guardarVeredicto);
router.get("/revision-legal", verifyToken, verifyAdmin, rev.listar);
router.get("/beta", verifyToken, verifyAdmin, rev.beta);

router.get("/feriados", verifyToken, verifyAdmin, ctrl.listFeriados);
router.post("/feriados", verifyToken, verifyAdmin, ctrl.createFeriados);
router.patch("/feriados/:id", verifyToken, verifyAdmin, ctrl.updateFeriado);

module.exports = router;
