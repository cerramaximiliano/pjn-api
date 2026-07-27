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

// PATCH /api/captcha-dataset/label/:subdir/:filename -> etiquetado manual de
// los captchas que ni el modelo ni el proveedor pudieron resolver.
router.patch('/label/:subdir/:filename', verifyToken, verifyAdmin, captchaDatasetController.label);

// PATCH /api/captcha-dataset/discard/:subdir/:filename -> saca del dataset las
// imágenes que no son captchas (desafío expirado, render roto).
router.patch('/discard/:subdir/:filename', verifyToken, verifyAdmin, captchaDatasetController.discard);

// PATCH /api/captcha-dataset/illegible/:subdir/:filename -> aparta los captchas
// que son válidos pero no hay forma humana de leerlos.
router.patch('/illegible/:subdir/:filename', verifyToken, verifyAdmin, captchaDatasetController.illegible);

module.exports = router;
