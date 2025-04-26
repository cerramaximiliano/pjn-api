const express = require('express');
const router = express.Router();
const causasRoutes = require('./causasRoutes');
const causasServiceRoutes = require('./causasServiceRoutes');

// Ruta para verificar el estado de la aplicación
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'API funcionando correctamente' });
});

// Ruta para capturar 404
router.use((req, res, next) => {
  if (!req.route) {
    return res.status(404).json({ 
      status: 'error', 
      message: 'Ruta no encontrada',
      path: req.originalUrl
    });
  }
  next();
});

// Montar las rutas de causas
router.use('/causas', causasRoutes);

// Montar las rutas de servicios de causas
router.use('/causas-service', causasServiceRoutes);

module.exports = router;