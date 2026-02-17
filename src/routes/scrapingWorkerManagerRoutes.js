const express = require('express');
const router = express.Router();
const controller = require('../controllers/scrapingWorkerManagerController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// All routes require authentication and admin role
router.use(verifyToken);
router.use(verifyAdmin);

// Manager status
router.get('/status', controller.getManagerStatus);
router.get('/summary', controller.getSummary);

// Worker listing (static paths first)
router.get('/workers', controller.listWorkers);

// Batch operations (MUST come before /:id routes to avoid matching "batch" as an id)
router.post('/workers/batch', controller.batchCreateWorkers);
router.put('/workers/batch/start', controller.batchStartWorkers);
router.put('/workers/batch/stop', controller.batchStopWorkers);

// Fuero-level operations (MUST come before /:id routes)
router.put('/workers/fuero/:fuero/start-all', controller.startAllByFuero);
router.put('/workers/fuero/:fuero/stop-all', controller.stopAllByFuero);

// From-existing (MUST come before /:id routes)
router.post('/workers/from-existing/:id', controller.startFromExisting);

// Worker creation
router.post('/workers', controller.createWorker);

// Single worker operations (parameterized routes last)
router.get('/workers/:id', controller.getWorker);
router.put('/workers/:id/start', controller.startWorker);
router.put('/workers/:id/stop', controller.stopWorker);
router.put('/workers/:id/restart', controller.restartWorker);
router.delete('/workers/:id', controller.deleteWorker);

module.exports = router;
