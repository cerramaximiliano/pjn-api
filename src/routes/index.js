const express = require('express');
const router = express.Router();
const causasRoutes = require('./causasRoutes');

// Montar las rutas de causas
router.use('/causas', causasRoutes);

module.exports = router;