/**
 * Controlador para la configuración del worker de limpieza de logs
 */

const CleanupConfig = require("../models/cleanupConfig");
const { logger } = require("../config/pino");

const cleanupConfigController = {
  /**
   * Obtener la configuración actual
   * GET /api/cleanup-config
   */
  async getConfig(req, res) {
    try {
      const config = await CleanupConfig.getConfig();

      res.json({
        success: true,
        message: "Configuración obtenida",
        data: config
      });
    } catch (error) {
      logger.error(`Error obteniendo configuración de cleanup: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error obteniendo configuración",
        error: error.message
      });
    }
  },

  /**
   * Actualizar la configuración
   * PUT /api/cleanup-config
   */
  async updateConfig(req, res) {
    try {
      const updates = req.body;
      const modifiedBy = req.userId || "api";

      // Validar campos permitidos
      const allowedFields = [
        "enabled",
        "retention",
        "schedule",
        "notifications",
        "limits",
        "metadata"
      ];

      const filteredUpdates = {};
      for (const key of allowedFields) {
        if (updates[key] !== undefined) {
          filteredUpdates[key] = updates[key];
        }
      }

      if (Object.keys(filteredUpdates).length === 0) {
        return res.status(400).json({
          success: false,
          message: "No se proporcionaron campos válidos para actualizar",
          allowedFields
        });
      }

      const config = await CleanupConfig.updateConfig(filteredUpdates, modifiedBy);

      logger.info(`Configuración de cleanup actualizada por ${modifiedBy}`);

      res.json({
        success: true,
        message: "Configuración actualizada",
        data: config
      });
    } catch (error) {
      logger.error(`Error actualizando configuración de cleanup: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error actualizando configuración",
        error: error.message
      });
    }
  },

  /**
   * Actualizar solo la retención
   * PATCH /api/cleanup-config/retention
   */
  async updateRetention(req, res) {
    try {
      const { detailedLogsDays, workerLogsDays } = req.body;
      const modifiedBy = req.userId || "api";

      const retention = {};
      if (detailedLogsDays !== undefined) {
        if (detailedLogsDays < 1 || detailedLogsDays > 90) {
          return res.status(400).json({
            success: false,
            message: "detailedLogsDays debe estar entre 1 y 90"
          });
        }
        retention.detailedLogsDays = detailedLogsDays;
      }
      if (workerLogsDays !== undefined) {
        if (workerLogsDays < 7 || workerLogsDays > 365) {
          return res.status(400).json({
            success: false,
            message: "workerLogsDays debe estar entre 7 y 365"
          });
        }
        retention.workerLogsDays = workerLogsDays;
      }

      if (Object.keys(retention).length === 0) {
        return res.status(400).json({
          success: false,
          message: "Debe proporcionar al menos un campo de retención"
        });
      }

      const config = await CleanupConfig.updateConfig({ retention }, modifiedBy);

      logger.info(`Retención de cleanup actualizada: ${JSON.stringify(retention)}`);

      res.json({
        success: true,
        message: "Retención actualizada",
        data: {
          retention: config.retention
        }
      });
    } catch (error) {
      logger.error(`Error actualizando retención: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error actualizando retención",
        error: error.message
      });
    }
  },

  /**
   * Actualizar el schedule
   * PATCH /api/cleanup-config/schedule
   */
  async updateSchedule(req, res) {
    try {
      const { cronExpression, timezone, description } = req.body;
      const modifiedBy = req.userId || "api";

      const schedule = {};

      if (cronExpression !== undefined) {
        // Validar expresión cron básica (5 campos)
        const cronParts = cronExpression.trim().split(/\s+/);
        if (cronParts.length !== 5) {
          return res.status(400).json({
            success: false,
            message: "Expresión cron inválida. Formato: minuto hora día mes díaSemana"
          });
        }
        schedule.cronExpression = cronExpression;
      }

      if (timezone !== undefined) {
        schedule.timezone = timezone;
      }

      if (description !== undefined) {
        schedule.description = description;
      }

      if (Object.keys(schedule).length === 0) {
        return res.status(400).json({
          success: false,
          message: "Debe proporcionar al menos un campo de schedule"
        });
      }

      const config = await CleanupConfig.updateConfig({ schedule }, modifiedBy);

      logger.info(`Schedule de cleanup actualizado: ${JSON.stringify(schedule)}`);

      res.json({
        success: true,
        message: "Schedule actualizado",
        data: {
          schedule: config.schedule
        }
      });
    } catch (error) {
      logger.error(`Error actualizando schedule: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error actualizando schedule",
        error: error.message
      });
    }
  },

  /**
   * Habilitar el worker
   * POST /api/cleanup-config/enable
   */
  async enable(req, res) {
    try {
      const modifiedBy = req.userId || "api";
      const config = await CleanupConfig.updateConfig({ enabled: true }, modifiedBy);

      logger.info(`Worker de cleanup habilitado por ${modifiedBy}`);

      res.json({
        success: true,
        message: "Worker habilitado",
        data: {
          enabled: config.enabled
        }
      });
    } catch (error) {
      logger.error(`Error habilitando worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error habilitando worker",
        error: error.message
      });
    }
  },

  /**
   * Deshabilitar el worker
   * POST /api/cleanup-config/disable
   */
  async disable(req, res) {
    try {
      const modifiedBy = req.userId || "api";
      const config = await CleanupConfig.updateConfig({ enabled: false }, modifiedBy);

      logger.info(`Worker de cleanup deshabilitado por ${modifiedBy}`);

      res.json({
        success: true,
        message: "Worker deshabilitado",
        data: {
          enabled: config.enabled
        }
      });
    } catch (error) {
      logger.error(`Error deshabilitando worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error deshabilitando worker",
        error: error.message
      });
    }
  },

  /**
   * Pausar el worker (modo mantenimiento)
   * POST /api/cleanup-config/pause
   */
  async pause(req, res) {
    try {
      const { reason, resumeAt } = req.body;
      const pausedBy = req.userId || "api";

      if (!reason) {
        return res.status(400).json({
          success: false,
          message: "Debe proporcionar una razón para pausar"
        });
      }

      let resumeDate = null;
      if (resumeAt) {
        resumeDate = new Date(resumeAt);
        if (isNaN(resumeDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Fecha de reanudación inválida"
          });
        }
      }

      const config = await CleanupConfig.pause(reason, pausedBy, resumeDate);

      logger.info(`Worker de cleanup pausado por ${pausedBy}: ${reason}`);

      res.json({
        success: true,
        message: "Worker pausado",
        data: {
          maintenance: config.maintenance
        }
      });
    } catch (error) {
      logger.error(`Error pausando worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error pausando worker",
        error: error.message
      });
    }
  },

  /**
   * Reanudar el worker
   * POST /api/cleanup-config/resume
   */
  async resume(req, res) {
    try {
      const resumedBy = req.userId || "api";
      const config = await CleanupConfig.resume(resumedBy);

      logger.info(`Worker de cleanup reanudado por ${resumedBy}`);

      res.json({
        success: true,
        message: "Worker reanudado",
        data: {
          maintenance: config.maintenance,
          enabled: config.enabled
        }
      });
    } catch (error) {
      logger.error(`Error reanudando worker: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error reanudando worker",
        error: error.message
      });
    }
  },

  /**
   * Obtener estado actual del worker
   * GET /api/cleanup-config/status
   */
  async getStatus(req, res) {
    try {
      const config = await CleanupConfig.getConfig();
      const canExecute = config.canExecute();

      res.json({
        success: true,
        message: "Estado obtenido",
        data: {
          enabled: config.enabled,
          isPaused: config.maintenance.isPaused,
          canExecute: canExecute.canRun,
          reason: canExecute.reason,
          lastExecution: config.lastExecution,
          schedule: config.schedule,
          retention: config.retention
        }
      });
    } catch (error) {
      logger.error(`Error obteniendo estado: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error obteniendo estado",
        error: error.message
      });
    }
  },

  /**
   * Obtener historial de ejecuciones
   * GET /api/cleanup-config/history
   */
  async getHistory(req, res) {
    try {
      const { limit = 30 } = req.query;
      const config = await CleanupConfig.getConfig();

      const history = config.executionHistory.slice(0, parseInt(limit));

      res.json({
        success: true,
        message: "Historial obtenido",
        count: history.length,
        data: history
      });
    } catch (error) {
      logger.error(`Error obteniendo historial: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error obteniendo historial",
        error: error.message
      });
    }
  },

  /**
   * Registrar una ejecución (usado internamente por el worker)
   * POST /api/cleanup-config/record-execution
   * Protegido por API Key
   */
  async recordExecution(req, res) {
    try {
      const executionData = req.body;

      // Validar campos requeridos
      if (!executionData.status) {
        return res.status(400).json({
          success: false,
          message: "El campo 'status' es requerido"
        });
      }

      const config = await CleanupConfig.recordExecution(executionData);

      logger.info(`Ejecución de cleanup registrada: ${executionData.status}`);

      res.json({
        success: true,
        message: "Ejecución registrada",
        data: {
          lastExecution: config.lastExecution
        }
      });
    } catch (error) {
      logger.error(`Error registrando ejecución: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error registrando ejecución",
        error: error.message
      });
    }
  },

  /**
   * Resetear configuración a valores por defecto
   * POST /api/cleanup-config/reset
   */
  async resetToDefaults(req, res) {
    try {
      const modifiedBy = req.userId || "api";

      // Eliminar configuración actual
      await CleanupConfig.deleteOne({ configId: "cleanup_logs_config" });

      // Crear nueva con valores por defecto
      const config = await CleanupConfig.getConfig();
      config.metadata.lastModifiedBy = modifiedBy;
      config.metadata.notes = "Configuración reseteada a valores por defecto";
      await config.save();

      logger.info(`Configuración de cleanup reseteada por ${modifiedBy}`);

      res.json({
        success: true,
        message: "Configuración reseteada a valores por defecto",
        data: config
      });
    } catch (error) {
      logger.error(`Error reseteando configuración: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error reseteando configuración",
        error: error.message
      });
    }
  }
};

module.exports = cleanupConfigController;
