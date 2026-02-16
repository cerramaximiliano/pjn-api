/**
 * Controller para Causas Update Worker Config y Runs
 * Lee/escribe configuración del worker desde MongoDB (colección causas-update-config)
 * y consulta/gestiona runs de actualización desde la colección causas-update-runs
 */
const mongoose = require("mongoose");
const { logger } = require("../config/pino");

// Defaults para reset
const DEFAULT_CONFIG = {
  worker: {
    enabled: true,
    maxCredentialsPerRun: 10,
    maxCausasPerCredential: 0,
    delayBetweenCausas: 2000,
    delayBetweenCredentials: 5000,
  },
  thresholds: {
    updateThresholdHours: 3,
    minTimeBetweenRunsMinutes: 120,
    maxRunsPerDay: 8,
  },
  concurrency: {
    waitForCausaCreation: true,
    checkIntervalMs: 30000,
    maxWaitMinutes: 60,
  },
  resume: {
    enabled: true,
    maxResumeAttempts: 3,
    resumeDelayMinutes: 5,
  },
};

/**
 * Lee la configuración desde MongoDB
 */
async function readConfig() {
  const db = mongoose.connection.db;
  const doc = await db
    .collection("causas-update-config")
    .findOne({ _id: "config" });
  if (!doc) return null;
  const { _id, ...config } = doc;
  return config;
}

/**
 * Escribe la configuración en MongoDB
 */
async function writeConfig(config) {
  config.updatedAt = new Date();
  const db = mongoose.connection.db;
  await db.collection("causas-update-config").updateOne(
    { _id: "config" },
    { $set: config },
    { upsert: true }
  );
  return config;
}

const causasUpdateController = {
  // ====== CONFIG ======

  /**
   * Obtener configuración del worker
   * GET /api/causas-update/config
   */
  async getConfig(req, res) {
    try {
      const config = await readConfig();

      res.json({
        success: true,
        message: "Configuración del causas-update worker obtenida",
        data: config || DEFAULT_CONFIG,
      });
    } catch (error) {
      logger.error(
        `Error obteniendo causas-update config: ${error.message}`
      );
      res.status(500).json({
        success: false,
        message: "Error al leer la configuración",
        error: error.message,
      });
    }
  },

  /**
   * Actualizar configuración (merge parcial)
   * PATCH /api/causas-update/config
   */
  async updateConfig(req, res) {
    try {
      const updates = req.body;
      const current = (await readConfig()) || { ...DEFAULT_CONFIG };

      // Merge por secciones
      if (updates.worker) {
        current.worker = { ...current.worker, ...updates.worker };
      }
      if (updates.thresholds) {
        current.thresholds = { ...current.thresholds, ...updates.thresholds };
      }
      if (updates.concurrency) {
        current.concurrency = {
          ...current.concurrency,
          ...updates.concurrency,
        };
      }
      if (updates.resume) {
        current.resume = { ...current.resume, ...updates.resume };
      }

      current.updatedBy = `admin:${req.userId}`;
      const saved = await writeConfig(current);

      logger.info(
        `Causas-update config actualizada por usuario ${req.userId}`
      );

      res.json({
        success: true,
        message: "Configuración actualizada",
        data: saved,
      });
    } catch (error) {
      logger.error(
        `Error actualizando causas-update config: ${error.message}`
      );
      res.status(500).json({
        success: false,
        message: "Error al actualizar la configuración",
        error: error.message,
      });
    }
  },

  /**
   * Resetear configuración a defaults
   * POST /api/causas-update/config/reset
   */
  async resetConfig(req, res) {
    try {
      const config = {
        ...DEFAULT_CONFIG,
        updatedBy: `admin:${req.userId}`,
      };
      const saved = await writeConfig(config);

      logger.info(
        `Causas-update config reseteada por usuario ${req.userId}`
      );

      res.json({
        success: true,
        message: "Configuración reseteada a defaults",
        data: saved,
      });
    } catch (error) {
      logger.error(
        `Error reseteando causas-update config: ${error.message}`
      );
      res.status(500).json({
        success: false,
        message: "Error al resetear la configuración",
        error: error.message,
      });
    }
  },

  // ====== RUNS ======

  /**
   * Listar runs con paginación y filtros
   * GET /api/causas-update/runs
   * Query params: page, limit, status, credentialsId, startDate, endDate
   */
  async getRuns(req, res) {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection("causas-update-runs");

      const page = parseInt(req.query.page) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 25, 100);
      const skip = page * limit;

      // Build filter
      const filter = {};
      if (req.query.status) {
        filter.status = req.query.status;
      }
      if (req.query.credentialsId) {
        filter.credentialsId = new mongoose.Types.ObjectId(
          req.query.credentialsId
        );
      }
      if (req.query.startDate || req.query.endDate) {
        filter.startedAt = {};
        if (req.query.startDate) {
          filter.startedAt.$gte = new Date(req.query.startDate);
        }
        if (req.query.endDate) {
          filter.startedAt.$lte = new Date(req.query.endDate);
        }
      }

      const [runs, total] = await Promise.all([
        collection
          .find(filter, {
            projection: {
              causasDetail: 0, // Excluir detalle para listados
            },
          })
          .sort({ startedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        collection.countDocuments(filter),
      ]);

      res.json({
        success: true,
        message: "Runs obtenidos",
        data: runs,
        count: total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      logger.error(`Error obteniendo runs: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener los runs",
        error: error.message,
      });
    }
  },

  /**
   * Detalle de un run específico (incluye causasDetail)
   * GET /api/causas-update/runs/:id
   */
  async getRunDetail(req, res) {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection("causas-update-runs");

      let runId;
      try {
        runId = new mongoose.Types.ObjectId(req.params.id);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: "ID de run inválido",
        });
      }

      const run = await collection.findOne({ _id: runId });

      if (!run) {
        return res.status(404).json({
          success: false,
          message: "Run no encontrado",
        });
      }

      res.json({
        success: true,
        message: "Detalle del run obtenido",
        data: run,
      });
    } catch (error) {
      logger.error(`Error obteniendo detalle de run: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener el detalle del run",
        error: error.message,
      });
    }
  },

  /**
   * Estadísticas agregadas de runs
   * GET /api/causas-update/runs/stats
   */
  async getStats(req, res) {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection("causas-update-runs");

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);
      weekStart.setHours(0, 0, 0, 0);

      const [todayStats, weekStats, incompleteCount, recentRuns] =
        await Promise.all([
          // Stats del día
          collection
            .aggregate([
              { $match: { startedAt: { $gte: todayStart } } },
              {
                $group: {
                  _id: null,
                  totalRuns: { $sum: 1 },
                  causasProcessed: {
                    $sum: "$results.causasProcessed",
                  },
                  causasUpdated: { $sum: "$results.causasUpdated" },
                  newMovimientos: {
                    $sum: "$results.newMovimientos",
                  },
                  totalErrors: { $sum: "$results.causasError" },
                  avgDuration: { $avg: "$durationSeconds" },
                  completed: {
                    $sum: {
                      $cond: [
                        { $eq: ["$status", "completed"] },
                        1,
                        0,
                      ],
                    },
                  },
                  partial: {
                    $sum: {
                      $cond: [
                        { $eq: ["$status", "partial"] },
                        1,
                        0,
                      ],
                    },
                  },
                  errors: {
                    $sum: {
                      $cond: [
                        { $eq: ["$status", "error"] },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ])
            .toArray(),

          // Stats de la semana
          collection
            .aggregate([
              { $match: { startedAt: { $gte: weekStart } } },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$startedAt",
                    },
                  },
                  runs: { $sum: 1 },
                  causasUpdated: { $sum: "$results.causasUpdated" },
                  newMovimientos: {
                    $sum: "$results.newMovimientos",
                  },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray(),

          // Incompletos
          collection.countDocuments({
            status: { $in: ["in_progress", "error", "interrupted"] },
          }),

          // Últimos 10 runs (para tabla rápida)
          collection
            .find(
              {},
              { projection: { causasDetail: 0 } }
            )
            .sort({ startedAt: -1 })
            .limit(10)
            .toArray(),
        ]);

      // Stats por credencial (última semana)
      const credentialStats = await collection
        .aggregate([
          { $match: { startedAt: { $gte: weekStart } } },
          {
            $group: {
              _id: "$credentialsId",
              userId: { $first: "$userId" },
              totalRuns: { $sum: 1 },
              causasUpdated: { $sum: "$results.causasUpdated" },
              newMovimientos: { $sum: "$results.newMovimientos" },
              errors: {
                $sum: {
                  $cond: [{ $eq: ["$status", "error"] }, 1, 0],
                },
              },
              lastRun: { $max: "$startedAt" },
            },
          },
          { $sort: { lastRun: -1 } },
        ])
        .toArray();

      res.json({
        success: true,
        message: "Estadísticas obtenidas",
        data: {
          today: todayStats[0] || {
            totalRuns: 0,
            causasProcessed: 0,
            causasUpdated: 0,
            newMovimientos: 0,
            totalErrors: 0,
          },
          weekByDay: weekStats,
          incompleteRuns: incompleteCount,
          byCredential: credentialStats,
          recentRuns,
        },
      });
    } catch (error) {
      logger.error(`Error obteniendo estadísticas: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener estadísticas",
        error: error.message,
      });
    }
  },

  /**
   * Runs incompletos pendientes de resume
   * GET /api/causas-update/runs/incomplete
   */
  async getIncompleteRuns(req, res) {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection("causas-update-runs");

      const runs = await collection
        .find(
          {
            status: { $in: ["in_progress", "error", "interrupted"] },
          },
          { projection: { causasDetail: 0 } }
        )
        .sort({ startedAt: -1 })
        .toArray();

      res.json({
        success: true,
        message: "Runs incompletos obtenidos",
        data: runs,
        count: runs.length,
      });
    } catch (error) {
      logger.error(
        `Error obteniendo runs incompletos: ${error.message}`
      );
      res.status(500).json({
        success: false,
        message: "Error al obtener runs incompletos",
        error: error.message,
      });
    }
  },

  /**
   * Runs de una credencial específica
   * GET /api/causas-update/runs/credential/:credId
   */
  async getCredentialRuns(req, res) {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection("causas-update-runs");

      let credId;
      try {
        credId = new mongoose.Types.ObjectId(req.params.credId);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: "ID de credencial inválido",
        });
      }

      const page = parseInt(req.query.page) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 25, 100);
      const skip = page * limit;

      const [runs, total] = await Promise.all([
        collection
          .find(
            { credentialsId: credId },
            { projection: { causasDetail: 0 } }
          )
          .sort({ startedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        collection.countDocuments({ credentialsId: credId }),
      ]);

      res.json({
        success: true,
        message: "Runs de credencial obtenidos",
        data: runs,
        count: total,
        page,
        limit,
      });
    } catch (error) {
      logger.error(
        `Error obteniendo runs de credencial: ${error.message}`
      );
      res.status(500).json({
        success: false,
        message: "Error al obtener runs de credencial",
        error: error.message,
      });
    }
  },
};

module.exports = causasUpdateController;
