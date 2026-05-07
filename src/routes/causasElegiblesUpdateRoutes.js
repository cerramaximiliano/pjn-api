const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/causasElegiblesUpdateController');
const { verifyToken } = require('../middleware/auth');

// Stats por fuero (counts de elegibles, en proceso, en cooldown)
router.get('/stats', verifyToken, ctrl.getStats);

// Listado paginado por fuero
router.get('/', verifyToken, ctrl.getList);

module.exports = router;
