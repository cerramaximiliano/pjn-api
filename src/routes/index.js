const express = require('express');
const router = express.Router();
const causasRoutes = require('./causasRoutes');
const causasServiceRoutes = require('./causasServiceRoutes');
const configuracionVerificacionRoutes = require('./configuracionVerificacionRoutes');

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

module.exports = router;