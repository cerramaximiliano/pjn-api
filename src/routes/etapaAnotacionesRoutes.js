const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/etapaAnotacionesController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Herramienta de etiquetado experto del dataset de etapas (vista admin
// /admin/causas/etiquetado + botón en /admin/causas/verified). Solo admin.
router.get("/", verifyToken, verifyAdmin, ctrl.getCola);
router.get("/membership", verifyToken, verifyAdmin, ctrl.getMembership);
router.get("/cobertura", verifyToken, verifyAdmin, ctrl.getCobertura);
router.get("/causa/:fuero/:id", verifyToken, verifyAdmin, ctrl.getCausaParaAnotar);
router.get("/cuerpo/:fuero/:id/:idx", verifyToken, verifyAdmin, ctrl.getCuerpoOnDemand);
router.post("/causa/:fuero/:id", verifyToken, verifyAdmin, ctrl.agregarACola);
router.put("/causa/:fuero/:id", verifyToken, verifyAdmin, ctrl.guardarAnotaciones);
router.delete("/causa/:fuero/:id", verifyToken, verifyAdmin, ctrl.quitarDeCola);

module.exports = router;
