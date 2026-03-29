const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/sentenciasCaptuadasController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/stats', verifyToken, ctrl.getStats);
router.get('/', verifyToken, ctrl.findAll);
router.get('/:id', verifyToken, ctrl.findById);
router.post('/:id/retry', verifyToken, verifyAdmin, ctrl.retry);
router.post('/:id/retry-ocr', verifyToken, verifyAdmin, ctrl.retryOcr);

module.exports = router;
