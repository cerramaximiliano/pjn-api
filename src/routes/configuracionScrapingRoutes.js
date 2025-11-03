const express = require('express');
const router = express.Router();
const configuracionScrapingController = require('../controllers/configuracionScrapingController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/', verifyToken, configuracionScrapingController.findAll);

router.post('/', verifyToken, verifyAdmin, configuracionScrapingController.create);

router.put('/:id', verifyToken, verifyAdmin, configuracionScrapingController.updateById);

router.put('/:id/range', verifyToken, verifyAdmin, configuracionScrapingController.updateRange);

router.delete('/:id', verifyToken, verifyAdmin, configuracionScrapingController.deleteById);

module.exports = router;