/**
 * plazosWorkerConfigRoutes.js — Config + estado del plazos-worker.
 * Montado en /api/plazos-worker-config (ver routes/index.js).
 * Vista admin: Workers PJN → Plazos (vía workersAxios, instancia Local).
 */
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/plazosWorkerConfigController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

router.get("/", verifyToken, verifyAdmin, ctrl.getFull);
router.get("/status", verifyToken, verifyAdmin, ctrl.getStatus);
router.patch("/settings", verifyToken, verifyAdmin, ctrl.updateSettings);
router.post("/reset-stats", verifyToken, verifyAdmin, ctrl.resetStats);

module.exports = router;
