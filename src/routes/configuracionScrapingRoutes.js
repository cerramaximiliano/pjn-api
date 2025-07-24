const express = require('express');
const router = express.Router();
const configuracionScrapingController = require('../controllers/configuracionScrapingController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/', verifyToken, configuracionScrapingController.findAll);

router.put('/:id', verifyToken, verifyAdmin, configuracionScrapingController.updateById);

module.exports = router;