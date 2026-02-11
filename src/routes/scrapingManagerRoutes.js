/**
 * Rutas para Scraping Manager Config
 * Gestión del archivo de configuración del Scraping Worker Manager (pjn-mis-causas)
 */
const express = require('express');
const router = express.Router();
const scrapingManagerController = require('../controllers/scrapingManagerController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación y rol admin
router.use(verifyToken);
router.use(verifyAdmin);

// Obtener configuración completa
// GET /api/scraping-manager
router.get('/', scrapingManagerController.getConfig);

// Actualizar configuración completa
// PUT /api/scraping-manager
router.put('/', scrapingManagerController.updateConfig);

// Actualizar sección global + manager
// PATCH /api/scraping-manager/global
router.patch('/global', scrapingManagerController.updateGlobal);

// Actualizar configuración de un worker específico
// PATCH /api/scraping-manager/workers/:workerName
router.patch('/workers/:workerName', scrapingManagerController.updateWorker);

// Obtener estado actual del manager desde MongoDB
// GET /api/scraping-manager/state
router.get('/state', scrapingManagerController.getManagerState);

module.exports = router;
