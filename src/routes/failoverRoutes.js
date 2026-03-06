/**
 * Rutas para el estado del failover cloud (pjn-mis-causas)
 */
const express = require("express");
const router = express.Router();
const failoverController = require("../controllers/failoverController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

router.use(verifyToken);
router.use(verifyAdmin);

// GET /api/failover/status
router.get("/status", failoverController.getStatus);

// GET /api/failover/history
router.get("/history", failoverController.getHistory);

module.exports = router;
