const express = require('express');
const router = express.Router();
const causasRoutes = require('./causasRoutes');
const causasServiceRoutes = require('./causasServiceRoutes');
const configuracionVerificacionRoutes = require('./configuracionVerificacionRoutes');
const configuracionScrapingRoutes = require('./configuracionScrapingRoutes');
const configuracionScrapingHistoryRoutes = require('./configuracionScrapingHistoryRoutes');
const configuracionAppUpdateRoutes = require('./configuracionAppUpdateRoutes');

// Ruta para verificar el estado de la aplicación
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'API funcionando correctamente' });
});


// Montar las rutas de causas
router.use('/causas', causasRoutes);

// Montar las rutas de servicios de causas
router.use('/causas-service', causasServiceRoutes);

// Montar las rutas de configuración de verificación
router.use('/configuracion-verificacion', configuracionVerificacionRoutes);

// Montar las rutas de configuración de scraping
router.use('/configuracion-scraping', configuracionScrapingRoutes);

// Montar las rutas del historial de configuración de scraping
router.use('/configuracion-scraping-history', configuracionScrapingHistoryRoutes);

// Montar las rutas de configuración de actualización de app
router.use('/configuracion-app-update', configuracionAppUpdateRoutes);

module.exports = router;