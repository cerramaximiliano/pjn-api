const express = require('express');
const router = express.Router();
const captchaDatasetController = require('../controllers/captchaDatasetController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Listado paginado con filtros
router.get('/', verifyToken, verifyAdmin, captchaDatasetController.list);

// Estadísticas globales (totales por verified/worker/fuero + uso de disco)
router.get('/stats', verifyToken, verifyAdmin, captchaDatasetController.stats);

// Servir PNG individual
router.get('/image/:subdir/:filename', verifyToken, verifyAdmin, captchaDatasetController.image);

module.exports = router;
