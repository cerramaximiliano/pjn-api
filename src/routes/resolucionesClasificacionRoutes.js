const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/resolucionesClasificacionController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
// Cola de clasificación ligera de resoluciones (vista admin
// /admin/causas/clasificacion-resoluciones). Solo admin.
router.get("/", verifyToken, verifyAdmin, ctrl.getCola);
router.get("/siguiente", verifyToken, verifyAdmin, ctrl.getSiguiente);
router.get("/stats", verifyToken, verifyAdmin, ctrl.getStats);
router.get("/export", verifyToken, verifyAdmin, ctrl.exportar);
router.get("/movimientos/:fuero/:causaId", verifyToken, verifyAdmin, ctrl.getMovimientos);
router.get("/:id", verifyToken, verifyAdmin, ctrl.getUno);
router.put("/:id", verifyToken, verifyAdmin, ctrl.anotar);
router.post("/", verifyToken, verifyAdmin, ctrl.agregar);
router.delete("/:id", verifyToken, verifyAdmin, ctrl.quitar);
module.exports = router;
