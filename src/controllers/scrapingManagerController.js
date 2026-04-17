/**
 * Controller para Scraping Manager Config
 * Lee/escribe la configuración del Scraping Worker Manager desde MongoDB
 * (colección scraping-manager-state, _id: "config")
 * y consulta el estado del manager desde MongoDB
 */
const mongoose = require('mongoose');
const { logger } = require('../config/pino');

/**
 * Lee la configuración desde MongoDB
 */
async function readConfig() {
  const db = mongoose.connection.db;
  const doc = await db.collection('scraping-manager-state').findOne({ _id: 'config' });
  if (!doc) throw new Error('Config no encontrada en MongoDB (scraping-manager-state._id="config")');
  const { _id, ...config } = doc;
  return config;
}

/**
 * Escribe la configuración en MongoDB
 */
async function writeConfig(config) {
  config._lastModified = new Date().toISOString();
  const db = mongoose.connection.db;
  await db.collection('scraping-manager-state').updateOne(
    { _id: 'config' },
    { $set: config },
    { upsert: true }
  );
  return config;
}

const scrapingManagerController = {
  /**
   * Obtener configuración completa
   * GET /api/scraping-manager
   */
  async getConfig(req, res) {
    try {
      const config = await readConfig();

      res.json({
        success: true,
        message: 'Configuración del scraping manager obtenida',
        data: config
      });
    } catch (error) {
      logger.error(`Error obteniendo config del scraping manager: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error al leer la configuración',
        error: error.message
      });
    }
  },

  /**
   * Actualizar configuración completa
   * PUT /api/scraping-manager
   */
  async updateConfig(req, res) {
    try {
      const newConfig = req.body;

      if (!newConfig.global || !newConfig.manager || !newConfig.workers) {
        return res.status(400).json({
          success: false,
          message: 'Configuración incompleta: requiere secciones global, manager y workers'
        });
      }

      // Preservar metadatos
      const current = await readConfig();
      newConfig._version = current._version;
      newConfig._createdBy = current._createdBy;

      const saved = await writeConfig(newConfig);

      logger.info(`Scraping manager config actualizada completamente por usuario ${req.userId}`);

      res.json({
        success: true,
        message: 'Configuración actualizada',
        data: saved
      });
    } catch (error) {
      logger.error(`Error actualizando config del scraping manager: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error al actualizar la configuración',
        error: error.message
      });
    }
  },

  /**
   * Actualizar sección global
   * PATCH /api/scraping-manager/global
   */
  async updateGlobal(req, res) {
    try {
      const updates = req.body;
      const config = await readConfig();

      // Merge solo campos válidos de global
      const allowedFields = ['enabled', 'serviceAvailable', 'maintenanceMessage', 'scheduledDowntime'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          config.global[field] = updates[field];
        }
      }

      // Merge campos de manager si vienen
      if (updates.manager) {
        const managerFields = ['pollIntervalMs', 'configWatchEnabled', 'healthCheckIntervalMs'];
        for (const field of managerFields) {
          if (updates.manager[field] !== undefined) {
            config.manager[field] = updates.manager[field];
          }
        }
      }

      const saved = await writeConfig(config);

      logger.info(`Scraping manager global config actualizada por usuario ${req.userId}`);

      res.json({
        success: true,
        message: 'Configuración global actualizada',
        data: saved
      });
    } catch (error) {
      logger.error(`Error actualizando global config: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error al actualizar la configuración global',
        error: error.message
      });
    }
  },

  /**
   * Actualizar configuración de un worker específico
   * PATCH /api/scraping-manager/workers/:workerName
   */
  async updateWorker(req, res) {
    try {
      const { workerName } = req.params;
      const updates = req.body;
      const config = await readConfig();

      if (!config.workers[workerName]) {
        return res.status(404).json({
          success: false,
          message: `Worker '${workerName}' no encontrado en la configuración`
        });
      }

      const worker = config.workers[workerName];

      // Actualizar enabled
      if (updates.enabled !== undefined) {
        worker.enabled = updates.enabled;
      }

      // Actualizar scaling
      if (updates.scaling) {
        worker.scaling = { ...worker.scaling, ...updates.scaling };
      }

      // Actualizar schedule
      if (updates.schedule) {
        worker.schedule = { ...worker.schedule, ...updates.schedule };
      }

      // Actualizar queue
      if (updates.queue) {
        worker.queue = { ...worker.queue, ...updates.queue };
      }

      // Actualizar healthCheck
      if (updates.healthCheck) {
        worker.healthCheck = { ...worker.healthCheck, ...updates.healthCheck };
      }

      const saved = await writeConfig(config);

      logger.info(`Scraping manager worker '${workerName}' actualizado por usuario ${req.userId}`);

      res.json({
        success: true,
        message: `Worker '${workerName}' actualizado`,
        data: saved.workers[workerName]
      });
    } catch (error) {
      logger.error(`Error actualizando worker config: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error al actualizar la configuración del worker',
        error: error.message
      });
    }
  },

  /**
   * Obtener estado actual del manager desde MongoDB
   * GET /api/scraping-manager/state
   */
  async getManagerState(req, res) {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection('scraping-manager-state');

      const [serviceAvailability, managerStatus] = await Promise.all([
        collection.findOne({ _id: 'service-availability' }),
        collection.findOne({ _id: 'manager-status' })
      ]);

      res.json({
        success: true,
        message: 'Estado del manager obtenido',
        data: {
          serviceAvailability: serviceAvailability || null,
          managerStatus: managerStatus || null
        }
      });
    } catch (error) {
      logger.error(`Error obteniendo estado del manager: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error al obtener el estado del manager',
        error: error.message
      });
    }
  },

  /**
   * Distribución de causas válidas, sentencias y escritos embebidos por fuero
   * GET /api/scraping-manager/fuero-stats
   */
  async getFueroStats(_req, res) {
    try {
      const db = mongoose.connection.db;

      const [doc, activasByFuero] = await Promise.all([
        db.collection('scraping-manager-state').findOne({ _id: 'fuero-causa-stats' }),
        db.collection('sentencias-capturadas').aggregate([
          { $match: { processingStatus: 'processed', embeddingStatus: 'completed' } },
          { $group: { _id: '$fuero', count: { $sum: 1 } } },
        ]).toArray(),
      ]);

      if (!doc) {
        return res.status(404).json({
          success: false,
          message: 'Stats de fuero no disponibles aún (se generan cada ~10 min)'
        });
      }

      const { _id, ...data } = doc;

      const byFuero = {};
      let totalActivas = 0;
      for (const row of activasByFuero) {
        if (row._id) {
          byFuero[row._id] = row.count;
          totalActivas += row.count;
        }
      }

      res.json({
        success: true,
        data: {
          ...data,
          sentenciasActivas: { total: totalActivas, byFuero },
        },
      });
    } catch (error) {
      logger.error(`Error obteniendo fuero stats: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error al obtener las estadísticas por fuero',
        error: error.message
      });
    }
  }
};

module.exports = scrapingManagerController;
