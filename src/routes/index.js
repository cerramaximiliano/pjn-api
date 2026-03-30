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
const workerStatsRoutes = require('./workerStatsRoutes');
const managerConfigRoutes = require('./managerConfigRoutes');
const extraInfoConfigRoutes = require('./extraInfoConfigRoutes');
const scrapingManagerRoutes = require('./scrapingManagerRoutes');
const scrapingWorkerManagerRoutes = require('./scrapingWorkerManagerRoutes');
const causasUpdateRoutes = require('./causasUpdateRoutes');
const syncResetRoutes = require('./syncResetRoutes');
const failoverRoutes = require('./failoverRoutes');
const configuracionUpdateMovimientosRoutes = require('./configuracionUpdateMovimientosRoutes');
const sentenciasCapturadasRoutes = require('./sentenciasCapturadasRoutes');
const configuracionSentenciasCollectorRoutes = require('./configuracionSentenciasCollectorRoutes');
const configuracionSemanticWorkerRoutes = require('./configuracionSemanticWorkerRoutes');

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

// Montar las rutas de estadísticas de workers
router.use('/workers', workerStatsRoutes);

// Montar las rutas de configuración del manager
router.use('/manager-config', managerConfigRoutes);

// Montar las rutas de configuración del extra-info worker
router.use('/extra-info-config', extraInfoConfigRoutes);

// Montar las rutas del scraping manager (pjn-mis-causas)
router.use('/scraping-manager', scrapingManagerRoutes);

// Montar las rutas del scraping worker manager (gestión dinámica de workers)
router.use('/scraping-worker-manager', scrapingWorkerManagerRoutes);

// Montar las rutas del causas-update worker (pjn-mis-causas)
router.use('/causas-update', causasUpdateRoutes);

// Montar las rutas de reset de sincronización PJN
router.use('/sync-reset', syncResetRoutes);

// Montar las rutas de failover cloud
router.use('/failover', failoverRoutes);

// Montar las rutas de configuración del worker update-movimientos
router.use('/configuracion-update-movimientos', configuracionUpdateMovimientosRoutes);

// Sentencias capturadas por update-movimientos-worker
router.use('/sentencias-capturadas', sentenciasCapturadasRoutes);

// Configuración del sentencias-collector-worker
router.use('/configuracion-sentencias-collector', configuracionSentenciasCollectorRoutes);
// Configuración del sentencias-semantic-worker (layer 2)
router.use('/configuracion-semantic-worker', configuracionSemanticWorkerRoutes);

module.exports = router;
