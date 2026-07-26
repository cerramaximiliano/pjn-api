const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/etapaStatsController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Estadísticas de etapas procesales (vistas admin /admin/causas/etapa-stats y
// /admin/causas/etapas). Solo admin.
router.get("/resumen", verifyToken, verifyAdmin, ctrl.getResumen);
router.get("/filtros", verifyToken, verifyAdmin, ctrl.getFiltros);
router.get("/causas", verifyToken, verifyAdmin, ctrl.getCausas);
router.get("/causa/:causaType/:id", verifyToken, verifyAdmin, ctrl.getCausaContext);

module.exports = router;
