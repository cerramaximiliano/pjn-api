/**
 * Rutas para Reset de Sincronizacion PJN
 * Permite resetear datos de sync de un usuario desde la UI de admin
 */
const express = require('express');
const router = express.Router();
const syncResetController = require('../controllers/syncResetController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticacion y rol admin
router.use(verifyToken);
router.use(verifyAdmin);

// Reset de sincronizacion de un usuario
// POST /api/sync-reset/:userId
// Body: { dryRun: true|false } (default: true = preview)
router.post('/:userId', syncResetController.resetUserSync);

module.exports = router;
