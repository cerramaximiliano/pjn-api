const express = require('express');
const router = express.Router();
const causasRoutes = require('./causasRoutes');

// Ruta para verificar el estado de la aplicación
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'API funcionando correctamente' });
});

// Montar las rutas de causas
router.use('/causas', causasRoutes);

module.exports = router;