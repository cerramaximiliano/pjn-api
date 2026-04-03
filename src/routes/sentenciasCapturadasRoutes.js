const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/sentenciasCaptuadasController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/stats', verifyToken, ctrl.getStats);
router.get('/publication-queue', verifyToken, verifyAdmin, ctrl.getPublicationQueue);
router.get('/', verifyToken, ctrl.findAll);
router.get('/:id', verifyToken, ctrl.findById);
router.post('/:id/retry', verifyToken, verifyAdmin, ctrl.retry);
router.post('/:id/retry-ocr', verifyToken, verifyAdmin, ctrl.retryOcr);
router.post('/:id/retry-embedding', verifyToken, verifyAdmin, ctrl.retryEmbedding);
router.patch('/:id/publication', verifyToken, verifyAdmin, ctrl.updatePublicationStatus);

module.exports = router;
