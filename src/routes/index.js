const express = require('express');
const router = express.Router();
const causasRoutes = require('./causasRoutes');
const causasServiceRoutes = require('./causasServiceRoutes');
const configuracionVerificacionRoutes = require('./configuracionVerificacionRoutes');
const configuracionScrapingRoutes = require('./configuracionScrapingRoutes');
const configuracionScrapingHistoryRoutes = require('./configuracionScrapingHistoryRoutes');
const configuracionAppUpdateRoutes = require('./configuracionAppUpdateRoutes');
const configuracionEmailVerificationRoutes = require('./configuracionEmailVerificationRoutes');
const judicialMovementsRoutes = require('./judicialMovementsRoutes');
const serverRoutes = require('./serverRoutes');
const workerLogRoutes = require('./workerLogRoutes');
const cleanupConfigRoutes = require('./cleanupConfigRoutes');
const intervinientesRoutes = require('./intervinientesRoutes');

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

// Montar las rutas de configuración de verificación de email (NeverBounce)
router.use('/configuracion-email-verification', configuracionEmailVerificationRoutes);

// Montar las rutas de movimientos judiciales
router.use('/judicial-movements', judicialMovementsRoutes);

// Montar las rutas de servidores/workers
router.use('/servers', serverRoutes);

// Montar las rutas de logs de workers
router.use('/worker-logs', workerLogRoutes);

// Montar las rutas de configuración de limpieza de logs
router.use('/cleanup-config', cleanupConfigRoutes);

// Montar las rutas de intervinientes
router.use('/intervinientes', intervinientesRoutes);

module.exports = router;
