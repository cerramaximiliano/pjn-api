/**
 * Modelo de configuración para el worker de limpieza de logs
 *
 * Este modelo almacena la configuración del cron job que limpia
 * los detailedLogs expirados de WorkerLog.
 *
 * Solo debe existir UN documento en esta colección (singleton pattern).
 */

const mongoose = require("mongoose");
const { Schema } = mongoose;

const CleanupConfigSchema = new Schema(
  {
    // Identificador único para el singleton
    configId: {
      type: String,
      default: "cleanup_logs_config",
      unique: true,
      immutable: true
    },

    // Estado del worker
    enabled: {
      type: Boolean,
      default: true,
      description: "Si el worker está habilitado para ejecutarse"
    },

    // Configuración de retención
    retention: {
      // Días que se mantienen los detailedLogs antes de limpiarlos
      detailedLogsDays: {
        type: Number,
        default: 7,
        min: 1,
        max: 90,
        description: "Días de retención para detailedLogs"
      },
      // Días después de los cuales se eliminan los WorkerLog completos
      // (esto es adicional al TTL index de MongoDB de 30 días)
      workerLogsDays: {
        type: Number,
        default: 30,
        min: 7,
        max: 365,
        description: "Días de retención para documentos WorkerLog completos"
      }
    },

    // Configuración del schedule (cron)
    schedule: {
      // Expresión cron (formato: minuto hora día mes díaSemana)
      cronExpression: {
        type: String,
        default: "0 3 * * *",
        description: "Expresión cron para el schedule (default: 3:00 AM diario)"
      },
      // Timezone para el cron
      timezone: {
        type: String,
        default: "America/Argentina/Buenos_Aires",
        description: "Timezone para la ejecución del cron"
      },
      // Descripción legible del schedule
      description: {
        type: String,
        default: "Todos los días a las 3:00 AM"
      }
    },

    // Configuración de notificaciones
    notifications: {
      // Enviar notificación por email al completar
      emailOnComplete: {
        type: Boolean,
        default: false
      },
      // Enviar notificación solo si hay errores
      emailOnError: {
        type: Boolean,
        default: true
      },
      // Emails destinatarios
      recipientEmails: [{
        type: String,
        trim: true,
        lowercase: true
      }]
    },

    // Límites y umbrales
    limits: {
      // Máximo de documentos a procesar por ejecución
      maxDocsPerRun: {
        type: Number,
        default: 10000,
        min: 100,
        max: 100000,
        description: "Máximo de documentos a limpiar por ejecución"
      },
      // Timeout en segundos para la ejecución
      timeoutSeconds: {
        type: Number,
        default: 300,
        min: 60,
        max: 3600,
        description: "Timeout máximo en segundos"
      },
      // Umbral de warning para logs pendientes
      warningThreshold: {
        type: Number,
        default: 1000,
        description: "Cantidad de logs pendientes que dispara un warning"
      }
    },

    // Estadísticas de la última ejecución
    lastExecution: {
      timestamp: {
        type: Date,
        description: "Fecha/hora de la última ejecución"
      },
      status: {
        type: String,
        enum: ["success", "partial", "failed", "running", "skipped"],
        description: "Estado de la última ejecución"
      },
      duration: {
        type: Number,
        description: "Duración en milisegundos"
      },
      stats: {
        // Documentos antes de la limpieza
        documentsWithLogsBefore: Number,
        totalLogEntriesBefore: Number,
        pendingCleanup: Number,
        // Documentos limpiados
        expiredLogsCleared: Number,
        oldLogsCleared: Number,
        totalCleared: Number,
        // Documentos después de la limpieza
        documentsWithLogsAfter: Number,
        totalLogEntriesAfter: Number
      },
      error: {
        message: String,
        stack: String
      }
    },

    // Historial de ejecuciones (últimas N ejecuciones)
    executionHistory: [{
      _id: false,
      timestamp: Date,
      status: {
        type: String,
        enum: ["success", "partial", "failed", "skipped"]
      },
      duration: Number,
      totalCleared: Number,
      error: String
    }],

    // Configuración de mantenimiento
    maintenance: {
      // Pausar ejecuciones durante mantenimiento
      isPaused: {
        type: Boolean,
        default: false
      },
      pausedAt: Date,
      pausedBy: String,
      pauseReason: String,
      // Fecha programada para reanudar automáticamente
      resumeAt: Date
    },

    // Metadata
    metadata: {
      createdBy: String,
      lastModifiedBy: String,
      version: {
        type: Number,
        default: 1
      },
      notes: String
    }
  },
  {
    timestamps: true,
    collection: "cleanup_config"
  }
);

// Índice único para asegurar singleton
CleanupConfigSchema.index({ configId: 1 }, { unique: true });

// Método estático para obtener o crear la configuración
CleanupConfigSchema.statics.getConfig = async function() {
  let config = await this.findOne({ configId: "cleanup_logs_config" });

  if (!config) {
    config = await this.create({
      configId: "cleanup_logs_config",
      metadata: {
        createdBy: "system",
        notes: "Configuración inicial creada automáticamente"
      }
    });
  }

  return config;
};

// Método estático para actualizar la configuración
CleanupConfigSchema.statics.updateConfig = async function(updates, modifiedBy = "system") {
  const config = await this.getConfig();

  // Actualizar campos
  Object.keys(updates).forEach(key => {
    if (key !== 'configId' && key !== '_id') {
      config.set(key, updates[key]);
    }
  });

  // Actualizar metadata
  config.metadata.lastModifiedBy = modifiedBy;
  config.metadata.version = (config.metadata.version || 0) + 1;

  return config.save();
};

// Método para registrar una ejecución
CleanupConfigSchema.statics.recordExecution = async function(executionData) {
  const config = await this.getConfig();

  // Actualizar lastExecution
  config.lastExecution = {
    timestamp: new Date(),
    status: executionData.status,
    duration: executionData.duration,
    stats: executionData.stats,
    error: executionData.error
  };

  // Agregar al historial (mantener últimas 30 ejecuciones)
  config.executionHistory.unshift({
    timestamp: new Date(),
    status: executionData.status,
    duration: executionData.duration,
    totalCleared: executionData.stats?.totalCleared || 0,
    error: executionData.error?.message
  });

  // Limitar historial a 30 entradas
  if (config.executionHistory.length > 30) {
    config.executionHistory = config.executionHistory.slice(0, 30);
  }

  return config.save();
};

// Método para verificar si el worker puede ejecutarse
CleanupConfigSchema.methods.canExecute = function() {
  // Verificar si está habilitado
  if (!this.enabled) {
    return { canRun: false, reason: "Worker deshabilitado" };
  }

  // Verificar si está en mantenimiento
  if (this.maintenance.isPaused) {
    // Verificar si debe reanudarse automáticamente
    if (this.maintenance.resumeAt && new Date() >= this.maintenance.resumeAt) {
      return { canRun: true, reason: "Reanudación automática" };
    }
    return { canRun: false, reason: `Pausado: ${this.maintenance.pauseReason || 'Sin razón especificada'}` };
  }

  return { canRun: true, reason: "OK" };
};

// Método para pausar el worker
CleanupConfigSchema.statics.pause = async function(reason, pausedBy, resumeAt = null) {
  const config = await this.getConfig();

  config.maintenance.isPaused = true;
  config.maintenance.pausedAt = new Date();
  config.maintenance.pausedBy = pausedBy;
  config.maintenance.pauseReason = reason;
  config.maintenance.resumeAt = resumeAt;

  return config.save();
};

// Método para reanudar el worker
CleanupConfigSchema.statics.resume = async function(resumedBy) {
  const config = await this.getConfig();

  config.maintenance.isPaused = false;
  config.maintenance.pausedAt = null;
  config.maintenance.pausedBy = null;
  config.maintenance.pauseReason = null;
  config.maintenance.resumeAt = null;
  config.metadata.lastModifiedBy = resumedBy;

  return config.save();
};

module.exports = mongoose.model("CleanupConfig", CleanupConfigSchema);
