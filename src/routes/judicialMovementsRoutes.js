const express = require('express');
const router = express.Router();
const judicialMovementsController = require('../controllers/judicialMovementsController');

/**
 * Ruta para obtener movimientos judiciales por expediente.id
 * GET /api/judicial-movements/by-expediente/:expedienteId
 */
router.get('/by-expediente/:expedienteId', judicialMovementsController.getMovementsByExpedienteId);

module.exports = router;
