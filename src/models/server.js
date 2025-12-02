const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * Schema para credenciales de acceso
 * Permite almacenar múltiples sets de credenciales por servidor
 */
const CredentialSchema = new Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      description: "Etiqueta descriptiva (ej: 'Admin', 'API', 'Database')",
    },
    username: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
    },
    apiKey: {
      type: String,
    },
    token: {
      type: String,
    },
    additionalFields: {
      type: Map,
      of: String,
      default: {},
      description: "Campos adicionales de credenciales (ej: secret, certificate)",
    },
  },
  { _id: true }
);

/**
 * Schema para documentación y recursos
 */
const DocumentationSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["api", "user-guide", "admin", "setup", "troubleshooting", "other"],
      default: "other",
    },
  },
  { _id: true }
);

/**
 * Schema para endpoints/URLs del servidor
 */
const EndpointSchema = new Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      description: "Etiqueta del endpoint (ej: 'API Base', 'Health Check', 'Admin Panel')",
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    method: {
      type: String,
      enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "WS", "WSS", "OTHER"],
      default: "GET",
    },
    description: {
      type: String,
      trim: true,
    },
  },
  { _id: true }
);

/**
 * Schema para aplicaciones que corren en el servidor
 */
const ApplicationSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      description: "Nombre de la aplicación",
    },
    description: {
      type: String,
      trim: true,
    },
    version: {
      type: String,
      trim: true,
    },
    port: {
      type: Number,
      description: "Puerto interno en el que corre la app",
    },
    publicUrl: {
      type: String,
      trim: true,
      description: "URL pública de la aplicación",
    },
    internalUrl: {
      type: String,
      trim: true,
      description: "URL interna de la aplicación",
    },
    status: {
      type: String,
      enum: ["running", "stopped", "error", "unknown"],
      default: "unknown",
    },
    technology: {
      type: String,
      trim: true,
      description: "Tecnología/framework (Node.js, Python, Docker, PM2, etc.)",
    },
    processManager: {
      type: String,
      trim: true,
      description: "Gestor de procesos (PM2, systemd, docker, etc.)",
    },
    processId: {
      type: String,
      trim: true,
      description: "ID del proceso o contenedor",
    },
    healthCheckUrl: {
      type: String,
      trim: true,
    },
    repository: {
      type: String,
      trim: true,
      description: "URL del repositorio de código",
    },
    environment: {
      type: String,
      enum: ["development", "staging", "production", "testing"],
      default: "production",
    },
    config: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {},
      description: "Configuración específica de la app",
    },
  },
  { _id: true }
);

/**
 * Schema para características técnicas
 */
const SpecificationSchema = new Schema(
  {
    cpu: {
      type: String,
      trim: true,
    },
    memory: {
      type: String,
      trim: true,
    },
    storage: {
      type: String,
      trim: true,
    },
    os: {
      type: String,
      trim: true,
    },
    region: {
      type: String,
      trim: true,
    },
    provider: {
      type: String,
      trim: true,
      description: "Proveedor cloud (AWS, GCP, Azure, DigitalOcean, etc.)",
    },
    additionalSpecs: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {},
      description: "Especificaciones adicionales flexibles",
    },
  },
  { _id: false }
);

/**
 * Schema principal para servidores/workers
 * Diseñado para ser flexible y soportar diferentes tipos de servidores
 */
const ServerSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "El nombre del servidor es requerido"],
      trim: true,
      index: true,
    },
    slug: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      description: "Identificador único legible (generado automáticamente si no se provee)",
    },
    type: {
      type: String,
      required: [true, "El tipo de servidor es requerido"],
      enum: ["worker", "ai", "database", "cache", "queue", "storage", "api", "proxy", "other"],
      default: "worker",
      index: true,
    },
    subtype: {
      type: String,
      trim: true,
      description: "Subtipo específico (ej: para AI: 'openai', 'anthropic', 'local-llm')",
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "maintenance", "deprecated", "error"],
      default: "active",
      index: true,
    },
    priority: {
      type: Number,
      default: 0,
      description: "Prioridad del servidor (mayor número = mayor prioridad)",
    },
    // Información de red
    network: {
      localIp: {
        type: String,
        trim: true,
        description: "IP local/privada del servidor",
      },
      publicIp: {
        type: String,
        trim: true,
        description: "IP pública/remota del servidor",
      },
      publicUrl: {
        type: String,
        trim: true,
        description: "URL pública principal del servidor",
      },
      hostname: {
        type: String,
        trim: true,
        description: "Hostname del servidor",
      },
      domain: {
        type: String,
        trim: true,
        description: "Dominio asociado",
      },
      sshPort: {
        type: Number,
        default: 22,
      },
      additionalIps: {
        type: [String],
        default: [],
        description: "IPs adicionales (ej: interfaces múltiples)",
      },
    },
    // Aplicaciones que corren en el servidor
    applications: {
      type: [ApplicationSchema],
      default: [],
    },
    // Especificaciones técnicas
    specifications: {
      type: SpecificationSchema,
      default: {},
    },
    // Endpoints y URLs
    endpoints: {
      type: [EndpointSchema],
      default: [],
    },
    // Credenciales (múltiples sets posibles)
    credentials: {
      type: [CredentialSchema],
      default: [],
    },
    // Documentación y recursos
    documentation: {
      type: [DocumentationSchema],
      default: [],
    },
    // Tags para categorización flexible
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    // Configuración específica del servidor (estructura flexible)
    config: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {},
      description: "Configuración específica del servidor en formato clave-valor",
    },
    // Metadatos adicionales (estructura completamente flexible)
    metadata: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {},
      description: "Metadatos adicionales sin estructura fija",
    },
    // Límites y cuotas
    limits: {
      requestsPerMinute: {
        type: Number,
      },
      requestsPerDay: {
        type: Number,
      },
      maxConcurrent: {
        type: Number,
      },
      additionalLimits: {
        type: Map,
        of: Schema.Types.Mixed,
        default: {},
      },
    },
    // Información de costos
    costs: {
      currency: {
        type: String,
        default: "USD",
      },
      costPerRequest: {
        type: Number,
      },
      monthlyCost: {
        type: Number,
      },
      additionalCosts: {
        type: Map,
        of: Schema.Types.Mixed,
        default: {},
      },
    },
    // Información de contacto/soporte
    support: {
      email: {
        type: String,
        trim: true,
      },
      phone: {
        type: String,
        trim: true,
      },
      url: {
        type: String,
        trim: true,
      },
      notes: {
        type: String,
        trim: true,
      },
    },
    // Control de acceso
    isPublic: {
      type: Boolean,
      default: false,
      description: "Si true, visible para usuarios no admin",
    },
    // Usuario que creó el registro
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Último usuario que modificó
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Fecha de última verificación de estado
    lastHealthCheck: {
      type: Date,
    },
    healthCheckResult: {
      type: String,
      enum: ["healthy", "unhealthy", "unknown"],
      default: "unknown",
    },
  },
  {
    timestamps: true,
    collection: "servers",
  }
);

// Índices compuestos para búsquedas frecuentes
ServerSchema.index({ type: 1, status: 1 });
ServerSchema.index({ type: 1, subtype: 1 });
ServerSchema.index({ tags: 1, status: 1 });
ServerSchema.index({ name: "text", description: "text" });

// Middleware pre-save para generar slug automáticamente
ServerSchema.pre("save", function (next) {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  next();
});

// Método para verificar si el servidor tiene credenciales
ServerSchema.methods.hasCredentials = function () {
  return this.credentials && this.credentials.length > 0;
};

// Método para obtener credencial por label
ServerSchema.methods.getCredential = function (label) {
  if (!this.credentials) return null;
  return this.credentials.find(
    (cred) => cred.label.toLowerCase() === label.toLowerCase()
  );
};

// Método para obtener endpoint por label
ServerSchema.methods.getEndpoint = function (label) {
  if (!this.endpoints) return null;
  return this.endpoints.find(
    (ep) => ep.label.toLowerCase() === label.toLowerCase()
  );
};

// Método para obtener URL principal (primer endpoint o endpoint con label 'main'/'base')
ServerSchema.methods.getMainUrl = function () {
  if (!this.endpoints || this.endpoints.length === 0) return null;
  const mainEndpoint = this.endpoints.find(
    (ep) =>
      ep.label.toLowerCase() === "main" ||
      ep.label.toLowerCase() === "base" ||
      ep.label.toLowerCase() === "api"
  );
  return mainEndpoint ? mainEndpoint.url : this.endpoints[0].url;
};

// Método estático para buscar servidores activos por tipo
ServerSchema.statics.findActiveByType = function (type) {
  return this.find({ type, status: "active" }).sort({ priority: -1 });
};

// Método estático para buscar por tags
ServerSchema.statics.findByTags = function (tags, options = {}) {
  const query = { tags: { $in: Array.isArray(tags) ? tags : [tags] } };
  if (options.status) query.status = options.status;
  if (options.type) query.type = options.type;
  return this.find(query).sort({ priority: -1 });
};

// Virtual para obtener el número de credenciales
ServerSchema.virtual("credentialsCount").get(function () {
  return this.credentials ? this.credentials.length : 0;
});

// Virtual para obtener el número de endpoints
ServerSchema.virtual("endpointsCount").get(function () {
  return this.endpoints ? this.endpoints.length : 0;
});

// Virtual para obtener el número de aplicaciones
ServerSchema.virtual("applicationsCount").get(function () {
  return this.applications ? this.applications.length : 0;
});

// Método para obtener aplicación por nombre
ServerSchema.methods.getApplication = function (name) {
  if (!this.applications) return null;
  return this.applications.find(
    (app) => app.name.toLowerCase() === name.toLowerCase()
  );
};

// Método para obtener aplicaciones en ejecución
ServerSchema.methods.getRunningApplications = function () {
  if (!this.applications) return [];
  return this.applications.filter((app) => app.status === "running");
};

// Asegurar que los virtuals se incluyan en JSON
ServerSchema.set("toJSON", { virtuals: true });
ServerSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Server", ServerSchema);
