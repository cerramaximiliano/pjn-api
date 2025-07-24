const express = require('express');
const router = express.Router();
const configuracionAppUpdateController = require('../controllers/configuracionAppUpdateController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

router.get('/', verifyToken, configuracionAppUpdateController.findAll);

router.put('/:id', verifyToken, verifyAdmin, configuracionAppUpdateController.updateById);

module.exports = router;