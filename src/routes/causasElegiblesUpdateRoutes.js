const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/causasElegiblesUpdateController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Stats por fuero (counts de elegibles, en proceso, en cooldown)
router.get('/stats', verifyToken, ctrl.getStats);

// Listado paginado por fuero
router.get('/', verifyToken, ctrl.getList);

// Encender/apagar el seguimiento de una causa, con motivo firmado en el historial
router.patch('/:fuero/:id/update-flag', verifyToken, verifyAdmin, ctrl.setUpdateFlag);

module.exports = router;
