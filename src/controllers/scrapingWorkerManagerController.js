const { ConfiguracionScraping } = require('pjn-models');
const mongoose = require('mongoose');
const { logger } = require('../config/pino');

const STATE_COLLECTION = 'scraping-manager-state';

/**
 * Read PM2 worker statuses from MongoDB (written by the scraping-manager process)
 */
async function getPM2Statuses() {
  const db = mongoose.connection.db;
  const doc = await db
    .collection(STATE_COLLECTION)
    .findOne({ _id: 'workers-pm2-status' });
  return doc ? doc.workers || {} : {};
}

/**
 * Build worker name from config fields (must match scraping-manager naming)
 */
function buildWorkerName(fuero, workerId) {
  return `scraping-${fuero}-${workerId}`;
}

/**
 * Merge PM2 status into a config document
 */
function mergeStatus(config, pm2Statuses) {
  const name = buildWorkerName(config.fuero, config.worker_id);
  const pm2 = pm2Statuses[name] || null;
  return {
    ...config,
    pm2WorkerName: name,
    pm2Status: pm2
      ? {
          status: pm2.status,
          pid: pm2.pid,
          cpu: pm2.cpu,
          memoryMB: pm2.memoryMB,
          uptime: pm2.uptime,
          restarts: pm2.restarts,
        }
      : null,
  };
}

const scrapingWorkerManagerController = {
  /**
   * GET /workers
   * List all worker configs with PM2 status merged
   */
  async listWorkers(req, res) {
    try {
      const {
        fuero,
        enabled,
        page = 1,
        limit = 50,
      } = req.query;

      const filter = {
        isRetryWorker: { $ne: true },
        isTemporary: { $ne: true },
      };

      if (fuero) filter.fuero = fuero;
      if (enabled !== undefined) filter.enabled = enabled === 'true';

      const skip = (page - 1) * limit;

      const [configs, total, pm2Statuses] = await Promise.all([
        ConfiguracionScraping.find(filter)
          .select('-__v')
          .sort({ fuero: 1, worker_id: 1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        ConfiguracionScraping.countDocuments(filter),
        getPM2Statuses(),
      ]);

      const workers = configs.map((c) => mergeStatus(c, pm2Statuses));

      res.json({
        success: true,
        message: 'Workers listados correctamente',
        count: workers.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: workers,
      });
    } catch (error) {
      logger.error(`Error listing workers: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * GET /workers/:id
   * Get single worker detail with PM2 status
   */
  async getWorker(req, res) {
    try {
      const { id } = req.params;

      const [config, pm2Statuses] = await Promise.all([
        ConfiguracionScraping.findById(id).select('-__v').lean(),
        getPM2Statuses(),
      ]);

      if (!config) {
        return res.status(404).json({
          success: false,
          message: 'Worker no encontrado',
        });
      }

      const worker = mergeStatus(config, pm2Statuses);

      res.json({
        success: true,
        message: 'Worker encontrado',
        data: worker,
      });
    } catch (error) {
      logger.error(`Error getting worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * POST /workers
   * Create a NEW ConfiguracionScraping doc (manager will auto-start it)
   */
  async createWorker(req, res) {
    try {
      const {
        fuero,
        worker_id,
        year,
        max_number,
        range_start,
        range_end,
        enabled = true,
        captcha,
        proxy,
        delay_seconds,
      } = req.body;

      if (!fuero || !year || !range_start || !range_end || !max_number) {
        return res.status(400).json({
          success: false,
          message: 'Campos requeridos: fuero, year, range_start, range_end, max_number',
        });
      }

      if (range_start >= range_end) {
        return res.status(400).json({
          success: false,
          message: 'range_start debe ser menor que range_end',
        });
      }

      // Auto-generate worker_id if not provided
      const workerId = worker_id || await generateWorkerId(fuero);
      const nombre = `${fuero} ${year} (${range_start}-${range_end})`;

      const configData = {
        fuero,
        worker_id: workerId,
        year,
        max_number,
        range_start,
        range_end,
        number: range_start,
        nombre,
        enabled,
        consecutive_not_found: 0,
        completionEmailSent: false,
      };

      if (delay_seconds !== undefined) {
        configData.delay_seconds = delay_seconds;
      }

      if (captcha) {
        configData.captcha = captcha;
      }

      if (proxy) {
        configData.proxy = proxy;
      }

      const newConfig = new ConfiguracionScraping(configData);
      const saved = await newConfig.save();

      logger.info(`Worker created: ${workerId} (fuero: ${fuero}, range: ${range_start}-${range_end})`);

      res.status(201).json({
        success: true,
        message: `Worker ${workerId} creado. El manager lo iniciará en el próximo ciclo de reconciliación.`,
        data: saved,
      });
    } catch (error) {
      logger.error(`Error creating worker: ${error.message}`);

      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe un worker con ese worker_id',
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * POST /workers/from-existing/:id
   * Adopt an existing ConfiguracionScraping doc as a managed worker
   */
  async startFromExisting(req, res) {
    try {
      const { id } = req.params;

      const config = await ConfiguracionScraping.findById(id);
      if (!config) {
        return res.status(404).json({
          success: false,
          message: 'ConfiguracionScraping no encontrada',
        });
      }

      if (config.enabled) {
        return res.status(400).json({
          success: false,
          message: 'El worker ya está habilitado',
        });
      }

      config.enabled = true;
      await config.save();

      const workerName = buildWorkerName(config.fuero, config.worker_id);
      logger.info(`Worker ${workerName} enabled from existing config`);

      res.json({
        success: true,
        message: `Worker ${workerName} habilitado. El manager lo iniciará en el próximo ciclo.`,
        data: config,
      });
    } catch (error) {
      logger.error(`Error enabling existing worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/:id/start
   * Enable a worker (manager will start PM2 process)
   */
  async startWorker(req, res) {
    try {
      const { id } = req.params;

      const config = await ConfiguracionScraping.findByIdAndUpdate(
        id,
        { enabled: true },
        { new: true }
      );

      if (!config) {
        return res.status(404).json({
          success: false,
          message: 'Worker no encontrado',
        });
      }

      const workerName = buildWorkerName(config.fuero, config.worker_id);
      logger.info(`Worker ${workerName} start requested`);

      res.json({
        success: true,
        message: `Worker ${workerName} habilitado. Se iniciará en el próximo ciclo.`,
        data: config,
      });
    } catch (error) {
      logger.error(`Error starting worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/:id/stop
   * Disable a worker (manager will stop PM2 process)
   */
  async stopWorker(req, res) {
    try {
      const { id } = req.params;

      const config = await ConfiguracionScraping.findByIdAndUpdate(
        id,
        { enabled: false },
        { new: true }
      );

      if (!config) {
        return res.status(404).json({
          success: false,
          message: 'Worker no encontrado',
        });
      }

      const workerName = buildWorkerName(config.fuero, config.worker_id);
      logger.info(`Worker ${workerName} stop requested`);

      res.json({
        success: true,
        message: `Worker ${workerName} deshabilitado. Se detendrá en el próximo ciclo.`,
        data: config,
      });
    } catch (error) {
      logger.error(`Error stopping worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/:id/restart
   * Request a restart (sets pendingRestart flag, manager handles it)
   */
  async restartWorker(req, res) {
    try {
      const { id } = req.params;

      const config = await ConfiguracionScraping.findByIdAndUpdate(
        id,
        { pendingRestart: true },
        { new: true }
      );

      if (!config) {
        return res.status(404).json({
          success: false,
          message: 'Worker no encontrado',
        });
      }

      const workerName = buildWorkerName(config.fuero, config.worker_id);
      logger.info(`Worker ${workerName} restart requested`);

      res.json({
        success: true,
        message: `Restart solicitado para ${workerName}. Se ejecutará en el próximo ciclo.`,
        data: config,
      });
    } catch (error) {
      logger.error(`Error restarting worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * DELETE /workers/:id
   * Disable and optionally delete a worker
   */
  async deleteWorker(req, res) {
    try {
      const { id } = req.params;
      const { deleteDoc } = req.query;

      const config = await ConfiguracionScraping.findById(id);
      if (!config) {
        return res.status(404).json({
          success: false,
          message: 'Worker no encontrado',
        });
      }

      const workerName = buildWorkerName(config.fuero, config.worker_id);

      if (deleteDoc === 'true') {
        // Disable first so manager stops the PM2 process, then delete doc
        config.enabled = false;
        await config.save();
        await ConfiguracionScraping.findByIdAndDelete(id);
        logger.info(`Worker ${workerName} disabled and document deleted`);

        res.json({
          success: true,
          message: `Worker ${workerName} eliminado. El proceso PM2 se detendrá en el próximo ciclo.`,
        });
      } else {
        // Just disable, keep the doc
        config.enabled = false;
        await config.save();
        logger.info(`Worker ${workerName} disabled (document preserved)`);

        res.json({
          success: true,
          message: `Worker ${workerName} deshabilitado. El proceso PM2 se detendrá en el próximo ciclo. El documento se conserva.`,
          data: config,
        });
      }
    } catch (error) {
      logger.error(`Error deleting worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * POST /workers/batch
   * Create multiple workers with range distribution
   */
  async batchCreateWorkers(req, res) {
    try {
      const {
        fuero,
        workers: workerCount,
        year,
        max_number,
        ranges,
        enabled = true,
        delay_increment = 0,
      } = req.body;

      if (!fuero || !workerCount || !year || !max_number || !ranges || !ranges.length) {
        return res.status(400).json({
          success: false,
          message: 'Campos requeridos: fuero, workers, year, max_number, ranges (array)',
        });
      }

      if (ranges.length < workerCount) {
        return res.status(400).json({
          success: false,
          message: `Se necesitan al menos ${workerCount} rangos, se recibieron ${ranges.length}`,
        });
      }

      const created = [];
      const errors = [];

      for (let i = 0; i < workerCount; i++) {
        const range = ranges[i % ranges.length];
        const workerId = await generateWorkerId(fuero);
        const nombre = `${fuero} ${year} (${range.start}-${range.end})`;

        try {
          const configData = {
            fuero,
            worker_id: workerId,
            year,
            max_number,
            range_start: range.start,
            range_end: range.end,
            number: range.start,
            nombre,
            enabled,
            consecutive_not_found: 0,
            completionEmailSent: false,
          };

          if (delay_increment) {
            configData.delay_seconds = i * delay_increment;
          }

          const newConfig = new ConfiguracionScraping(configData);
          const saved = await newConfig.save();
          created.push(saved);
        } catch (err) {
          errors.push({ workerId, error: err.message });
        }
      }

      logger.info(`Batch create: ${created.length} workers created, ${errors.length} errors`);

      res.status(201).json({
        success: true,
        message: `${created.length} workers creados. El manager los iniciará en el próximo ciclo.`,
        data: {
          created: created.length,
          errors: errors.length,
          workers: created,
          errorDetails: errors.length > 0 ? errors : undefined,
        },
      });
    } catch (error) {
      logger.error(`Error batch creating workers: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/batch/start
   * Enable multiple workers by IDs
   */
  async batchStartWorkers(req, res) {
    try {
      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere un array de IDs',
        });
      }

      const result = await ConfiguracionScraping.updateMany(
        { _id: { $in: ids } },
        { enabled: true }
      );

      logger.info(`Batch start: ${result.modifiedCount} workers enabled`);

      res.json({
        success: true,
        message: `${result.modifiedCount} workers habilitados`,
        data: { modifiedCount: result.modifiedCount },
      });
    } catch (error) {
      logger.error(`Error batch starting workers: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/batch/stop
   * Disable multiple workers by IDs
   */
  async batchStopWorkers(req, res) {
    try {
      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere un array de IDs',
        });
      }

      const result = await ConfiguracionScraping.updateMany(
        { _id: { $in: ids } },
        { enabled: false }
      );

      logger.info(`Batch stop: ${result.modifiedCount} workers disabled`);

      res.json({
        success: true,
        message: `${result.modifiedCount} workers deshabilitados`,
        data: { modifiedCount: result.modifiedCount },
      });
    } catch (error) {
      logger.error(`Error batch stopping workers: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/fuero/:fuero/start-all
   * Enable all workers for a fuero
   */
  async startAllByFuero(req, res) {
    try {
      const { fuero } = req.params;

      const result = await ConfiguracionScraping.updateMany(
        {
          fuero,
          isRetryWorker: { $ne: true },
          isTemporary: { $ne: true },
        },
        { enabled: true }
      );

      logger.info(`Start all ${fuero}: ${result.modifiedCount} workers enabled`);

      res.json({
        success: true,
        message: `${result.modifiedCount} workers de ${fuero} habilitados`,
        data: { modifiedCount: result.modifiedCount },
      });
    } catch (error) {
      logger.error(`Error starting all workers for ${req.params.fuero}: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * PUT /workers/fuero/:fuero/stop-all
   * Disable all workers for a fuero
   */
  async stopAllByFuero(req, res) {
    try {
      const { fuero } = req.params;

      const result = await ConfiguracionScraping.updateMany(
        {
          fuero,
          isRetryWorker: { $ne: true },
          isTemporary: { $ne: true },
        },
        { enabled: false }
      );

      logger.info(`Stop all ${fuero}: ${result.modifiedCount} workers disabled`);

      res.json({
        success: true,
        message: `${result.modifiedCount} workers de ${fuero} deshabilitados`,
        data: { modifiedCount: result.modifiedCount },
      });
    } catch (error) {
      logger.error(`Error stopping all workers for ${req.params.fuero}: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * GET /status
   * Manager health and summary
   */
  async getManagerStatus(req, res) {
    try {
      const db = mongoose.connection.db;

      const [healthDoc, pm2StatusDoc] = await Promise.all([
        db.collection(STATE_COLLECTION).findOne({ _id: 'scraping-manager-health' }),
        db.collection(STATE_COLLECTION).findOne({ _id: 'workers-pm2-status' }),
      ]);

      // Compute summary by fuero
      const configs = await ConfiguracionScraping.find({
        isRetryWorker: { $ne: true },
        isTemporary: { $ne: true },
      })
        .select('fuero enabled worker_id')
        .lean();

      const summary = {};
      for (const config of configs) {
        if (!summary[config.fuero]) {
          summary[config.fuero] = { total: 0, enabled: 0, disabled: 0 };
        }
        summary[config.fuero].total++;
        if (config.enabled) {
          summary[config.fuero].enabled++;
        } else {
          summary[config.fuero].disabled++;
        }
      }

      const pm2Workers = pm2StatusDoc ? pm2StatusDoc.workers || {} : {};
      const pm2Online = Object.values(pm2Workers).filter(
        (w) => w.status === 'online'
      ).length;

      res.json({
        success: true,
        message: 'Estado del manager obtenido',
        data: {
          manager: healthDoc
            ? {
                lastReconcile: healthDoc.lastReconcile,
                cycleCount: healthDoc.cycleCount,
                reconcileDurationMs: healthDoc.reconcileDurationMs,
                lastActions: healthDoc.actions,
                pid: healthDoc.pid,
                uptime: healthDoc.uptime,
                updatedAt: healthDoc.updatedAt,
              }
            : null,
          pm2: {
            totalProcesses: Object.keys(pm2Workers).length,
            online: pm2Online,
            stopped: Object.keys(pm2Workers).length - pm2Online,
            lastUpdate: pm2StatusDoc ? pm2StatusDoc.updatedAt : null,
          },
          configSummary: summary,
          totalConfigs: configs.length,
          totalEnabled: configs.filter((c) => c.enabled).length,
        },
      });
    } catch (error) {
      logger.error(`Error getting manager status: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },

  /**
   * GET /summary
   * Aggregated stats across all workers
   */
  async getSummary(req, res) {
    try {
      const configs = await ConfiguracionScraping.find({
        isRetryWorker: { $ne: true },
        isTemporary: { $ne: true },
      })
        .select('fuero enabled worker_id year range_start range_end number total_found total_not_found total_errors balance captcha')
        .lean();

      const pm2Statuses = await getPM2Statuses();

      const byFuero = {};
      for (const config of configs) {
        if (!byFuero[config.fuero]) {
          byFuero[config.fuero] = {
            workers: 0,
            enabled: 0,
            disabled: 0,
            totalFound: 0,
            totalNotFound: 0,
            totalErrors: 0,
            pm2Online: 0,
          };
        }

        const f = byFuero[config.fuero];
        f.workers++;
        if (config.enabled) f.enabled++;
        else f.disabled++;

        f.totalFound += config.total_found || 0;
        f.totalNotFound += config.total_not_found || 0;
        f.totalErrors += config.total_errors || 0;

        const workerName = buildWorkerName(config.fuero, config.worker_id);
        if (pm2Statuses[workerName] && pm2Statuses[workerName].status === 'online') {
          f.pm2Online++;
        }
      }

      res.json({
        success: true,
        message: 'Resumen obtenido',
        data: {
          total: configs.length,
          byFuero,
        },
      });
    } catch (error) {
      logger.error(`Error getting summary: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
      });
    }
  },
};

/**
 * Auto-generate a worker_id for a fuero based on existing count
 */
async function generateWorkerId(fuero) {
  const existing = await ConfiguracionScraping.find({ fuero })
    .select('worker_id')
    .lean();

  // Find the highest number in worker_id pattern: worker_{FUERO}_{N}
  let maxNum = 0;
  for (const config of existing) {
    const match = config.worker_id.match(/worker_\w+_(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      if (num > maxNum) maxNum = num;
    }
  }

  return `worker_${fuero}_${maxNum + 1}`;
}

module.exports = scrapingWorkerManagerController;
