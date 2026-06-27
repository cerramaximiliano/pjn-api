const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/trayectoriasController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Resumen por fuero.
router.get("/stats", verifyToken, verifyAdmin, ctrl.trayectoriaStats);
// Lista causas con trayectoria (paginada, filtrable por fuero).
router.get("/", verifyToken, verifyAdmin, ctrl.listCausasWithTrayectoria);

module.exports = router;
