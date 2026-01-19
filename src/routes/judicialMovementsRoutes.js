const express = require('express');
const router = express.Router();
const judicialMovementsController = require('../controllers/judicialMovementsController');

/**
 * Ruta para obtener movimientos judiciales por expediente.id
 * GET /api/judicial-movements/by-expediente/:expedienteId
 */
router.get('/by-expediente/:expedienteId', judicialMovementsController.getMovementsByExpedienteId);

/**
 * Ruta para eliminar un movimiento judicial por ID
 * DELETE /api/judicial-movements/:id
 */
router.delete('/:id', judicialMovementsController.deleteMovement);

module.exports = router;
