const mongoose = require("mongoose");
const { Schema } = mongoose;

const WorkerLogSchema = new Schema(
  {
    // Tipo de worker que generó el log
    workerType: {
      type: String,
      enum: ["verify", "update", "scraping", "recovery", "stuck_documents"],
      required: true,
      index: true
    },

    // ID del worker específico
    workerId: {
      type: String,
      required: true,
      index: true
    },

    // Timestamp del inicio de la operación
    startTime: {
      type: Date,
      required: true,
      default: Date.now,
      index: true
    },

    // Timestamp del fin de la operación
    endTime: {
      type: Date
    },

    // Duración en milisegundos
    duration: {
      type: Number
    },

    // Estado de la operación
    status: {
      type: String,
      enum: ["success", "partial", "failed", "in_progress", "skipped", "error"],
      default: "in_progress",
      index: true
    },

    // Información del documento procesado
    document: {
      documentId: {
        type: Schema.Types.ObjectId,
        index: true
      },
      model: {
        type: String,
        enum: ["Causas", "CausasCivil", "CausasSegSoc", "CausasSegSocial", "CausasTrabajo", "CausasComercial"]
      },
      number: Number,
      year: Number,
      fuero: String,

      stateBefore: {
        verified: Boolean,
        isValid: Boolean,
        movimientosCount: Number,
        lastUpdate: Date,
        caratula: String,
        fechaUltimoMovimiento: Date
      },

      stateAfter: {
        verified: Boolean,
        isValid: Boolean,
        movimientosCount: Number,
        lastUpdate: Date,
        caratula: String
      }
    },

    // Cambios realizados
    changes: {
      movimientosAdded: {
        type: Number,
        default: 0
      },
      caratulaUpdated: {
        type: Boolean,
        default: false
      },
      objetoUpdated: {
        type: Boolean,
        default: false
      },
      fieldsUpdated: [String]
    },

    // Información del resultado
    result: {
      verificationResult: {
        documentFound: Boolean,
        dataRetrieved: Boolean,
        validationPassed: Boolean
      },

      updateResult: {
        newMovimentsFound: Boolean,
        changesDetected: Boolean
      },

      message: String,
      skipReason: String,
      skipped: Boolean,

      error: {
        message: String,
        stack: String,
        code: String
      }
    },

    // Recursos utilizados
    resources: {
      captchaUsed: {
        type: Boolean,
        default: false
      },
      captchaBalance: Number,
      browserTime: Number,
      memoryUsed: Number
    },

    // Folders actualizados
    foldersUpdated: [{
      folderId: Schema.Types.ObjectId,
      folderName: String,
      updateStatus: String
    }],

    // Metadatos adicionales
    metadata: {
      cpuLoad: Number,
      batchPosition: Number,
      batchSize: Number,
      retryCount: {
        type: Number,
        default: 0
      },
      cycleTime: Date,
      threshold_hours: Number
    },

    // Notificaciones enviadas
    notificationsSent: {
      type: Number,
      default: 0
    },

    // Logs detallados para debugging
    detailedLogs: [{
      _id: false,
      timestamp: {
        type: Date,
        default: Date.now
      },
      level: {
        type: String,
        enum: ['debug', 'info', 'warn', 'error'],
        default: 'info'
      },
      message: String,
      data: Schema.Types.Mixed // Datos adicionales opcionales
    }],

    // Configuración de retención de logs detallados
    logsRetention: {
      keepDetailedLogs: {
        type: Boolean,
        default: true
      },
      detailedLogsExpireAt: Date // Fecha de expiración de logs detallados
    }
  },
  {
    timestamps: true,
    collection: 'workerlogs'
  }
);

// Índices para optimizar consultas
WorkerLogSchema.index({ workerType: 1, startTime: -1 });
WorkerLogSchema.index({ "document.documentId": 1 });
WorkerLogSchema.index({ status: 1, startTime: -1 });
WorkerLogSchema.index({ duration: -1 });
WorkerLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 }); // TTL 30 días

module.exports = mongoose.model("WorkerLog", WorkerLogSchema);
