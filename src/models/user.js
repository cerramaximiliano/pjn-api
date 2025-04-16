const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { Schema } = mongoose;

// Definimos un subschema específico para LawyerCollegeWithRegistration
const LawyerCollegeSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  registrationNumber: {
    type: String,
    default: '',
    trim: true
  },
  // Campos adicionales que podrían ser útiles
  issueDate: {
    type: Date
  },
  expirationDate: {
    type: Date
  },
  status: {
    type: String,
    enum: ['Activa', 'En trámite', 'Vencida', 'Suspendida'],
    default: 'Activa'
  },
  province: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  }
}, { _id: false });

// Esquema para configuración específica de notificación
const NotificationSettingsSchema = new Schema({
  // Por defecto, notificar solo una vez
  notifyOnceOnly: {
    type: Boolean,
    default: true
  },
  // Días de anticipación para la notificación
  daysInAdvance: {
    type: Number,
    default: 5
  }
}, { _id: false });

// Definimos un subschema para las preferencias del usuario
const UserPreferencesSchema = new Schema({
  // Zona horaria del usuario
  timeZone: {
    type: String,
    default: 'Europe/Madrid',
    trim: true
  },
  // Formato de fecha preferido (DD/MM/YYYY, MM/DD/YYYY, etc.)
  dateFormat: {
    type: String,
    default: 'DD/MM/YYYY',
    trim: true
  },
  // Preferencias de lenguaje
  language: {
    type: String,
    default: 'es',
    trim: true
  },
  // Tema de la interfaz
  theme: {
    type: String,
    enum: ['light', 'dark', 'system'],
    default: 'system'
  },
  // Preferencias de notificaciones
  notifications: {
    // Notificaciones generales
    enabled: { type: Boolean, default: true },

    // Tipos de canales de notificación
    channels: {
      email: { type: Boolean, default: true },
      browser: { type: Boolean, default: true },
      mobile: { type: Boolean, default: true }
    },

    // Notificaciones de usuario
    user: {
      enabled: { type: Boolean, default: true },

      // Estado simple (para mantener compatibilidad con controladores existentes)
      calendar: { type: Boolean, default: true },
      expiration: { type: Boolean, default: true },
      inactivity: { type: Boolean, default: true },

      // Configuración detallada para cada tipo de notificación
      calendarSettings: {
        type: NotificationSettingsSchema,
        default: () => ({})
      },
      expirationSettings: {
        type: NotificationSettingsSchema,
        default: () => ({})
      },
      inactivitySettings: {
        type: NotificationSettingsSchema,
        default: () => ({})
      }
    },

    // Notificaciones del sistema
    system: {
      enabled: { type: Boolean, default: true },
      alerts: { type: Boolean, default: true },
      news: { type: Boolean, default: true },
      userActivity: { type: Boolean, default: true },

      // Configuración detallada para cada tipo de notificación
      alertsSettings: {
        type: NotificationSettingsSchema,
        default: () => ({})
      },
      newsSettings: {
        type: NotificationSettingsSchema,
        default: () => ({})
      },
      userActivitySettings: {
        type: NotificationSettingsSchema,
        default: () => ({})
      }
    },

    // Otras notificaciones específicas (según la UI)
    otherCommunications: { type: Boolean, default: true },
    loginAlerts: { type: Boolean, default: true },

    // Configuración detallada para otras notificaciones
    otherCommunicationsSettings: {
      type: NotificationSettingsSchema,
      default: () => ({})
    },
    loginAlertsSettings: {
      type: NotificationSettingsSchema,
      default: () => ({})
    }
  }
}, { _id: false });

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    verificationCode: { type: String },
    isVerified: { type: Boolean },
    picture: { type: String },

    // Nuevas propiedades basadas en el tipo UserProfile
    address: { type: String },
    address1: { type: String },
    avatar: { type: String },
    contact: { type: String },
    country: { type: String },
    designation: { type: String },
    dob: { type: Date },
    note: { type: String },
    role: { type: String },
    skill: {
      type: [Schema.Types.Mixed],
      default: [],
      // Seguimos usando el validador para mantener compatibilidad con formatos anteriores
      validate: {
        validator: function (value) {
          if (!Array.isArray(value)) return false;

          // Si el array está vacío, es válido
          if (value.length === 0) return true;

          // Verificar si todos los elementos son strings (formato antiguo)
          const allStrings = value.every(item => typeof item === 'string');
          if (allStrings) return true;

          // Verificar si todos los elementos son objetos con el formato correcto
          const allObjects = value.every(item =>
            typeof item === 'object' &&
            item !== null &&
            'name' in item &&
            typeof item.name === 'string' &&
            ('registrationNumber' in item ? typeof item.registrationNumber === 'string' : true)
          );

          return allObjects;
        },
        message: 'El campo skill debe ser un array de strings o un array de objetos con propiedades name y registrationNumber'
      }
    },
    state: { type: String },
    // Campos de suscripción (mantener por compatibilidad, pero se recomienda usar el modelo Subscription)
    subscription: { type: String },
    tier: { type: String },
    // Campo de referencia a la suscripción
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription'
    },
    // Campo adicional para facilitar consultas por plan
    subscriptionPlan: {
      type: String,
      enum: ['free', 'standard', 'premium'],
      default: 'free'
    },
    url: { type: String },
    zipCode: { type: String },

    // Preferencias del usuario
    preferences: {
      type: UserPreferencesSchema,
      default: () => ({})
    },

    // Contador de cálculos activos
    activeCalculatorsCount: { type: Number, default: 0 },
    activeFoldersCount: { type: Number, default: 0 },

    // Puntaje de completitud del perfil (0-100)
    profileCompletionScore: { type: Number, default: 0 },

    // Subdocumento de usuarios según la definición de User
    users: [
      {
        userId: { type: String },
        name: { type: String },
        email: { type: String },
        role: { type: String },
        status: { type: String },
        avatar: { type: String },
      },
    ],

    // Sesiones activas
    activeSessions: [
      {
        deviceId: { type: String },
        deviceName: { type: String },
        deviceType: { type: String }, // desktop, mobile, tablet
        browser: { type: String },
        os: { type: String },
        ip: { type: String },
        lastActivity: { type: Date, default: Date.now },
        location: { type: String },
        token: { type: String }, // Token de sesión (puede ser JWT)
        isCurrentSession: { type: Boolean, default: false } // Indica si es la sesión actual
      }
    ],

    resetPasswordExpires: {
      type: Date,
      default: null
    },
    isActive: { type: Boolean, default: true },
    deactivatedAt: {
      type: Date
    },
  },
  { timestamps: true }
);


UserSchema.pre("save", function (next) {
  // Si skill es un array de strings, convertirlo a array de objetos
  if (Array.isArray(this.skill) && this.skill.length > 0 && typeof this.skill[0] === 'string') {
    this.skill = this.skill.map(name => ({
      name,
      registrationNumber: '',
      status: 'Activa' // Valor por defecto
    }));
  }

  next();
});

// Middleware para encriptar la contraseña antes de guardar
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Middleware para calcular el puntaje de completitud antes de guardar
UserSchema.pre("save", function (next) {
  this.profileCompletionScore = calculateCompletionScore(this);
  next();
});

// Middleware para establecer preferencias por defecto si no existen
UserSchema.pre("save", function (next) {
  if (!this.preferences) {
    this.preferences = {};
  }

  // Configurar la zona horaria del navegador si es una nueva cuenta
  if (this.isNew && !this.preferences.timeZone) {
    // Utilizamos Madrid como valor por defecto en el servidor
    // La aplicación cliente debe actualizar esto con la zona horaria real del navegador
    this.preferences.timeZone = 'Europe/Madrid';
  }

  // Inicializar la configuración detallada de notificaciones si no existe
  if (this.preferences.notifications) {
    // Inicializar configuraciones de notificaciones de usuario
    if (this.preferences.notifications.user) {
      if (!this.preferences.notifications.user.calendarSettings) {
        this.preferences.notifications.user.calendarSettings = {
          notifyOnceOnly: true,
          daysInAdvance: 5
        };
      }
      if (!this.preferences.notifications.user.expirationSettings) {
        this.preferences.notifications.user.expirationSettings = {
          notifyOnceOnly: true,
          daysInAdvance: 5
        };
      }
      if (!this.preferences.notifications.user.inactivitySettings) {
        this.preferences.notifications.user.inactivitySettings = {
          notifyOnceOnly: true,
          daysInAdvance: 5
        };
      }
    }

    // Inicializar configuraciones de notificaciones del sistema
    if (this.preferences.notifications.system) {
      if (!this.preferences.notifications.system.alertsSettings) {
        this.preferences.notifications.system.alertsSettings = {
          notifyOnceOnly: true,
          daysInAdvance: 5
        };
      }
      if (!this.preferences.notifications.system.newsSettings) {
        this.preferences.notifications.system.newsSettings = {
          notifyOnceOnly: true,
          daysInAdvance: 5
        };
      }
      if (!this.preferences.notifications.system.userActivitySettings) {
        this.preferences.notifications.system.userActivitySettings = {
          notifyOnceOnly: true,
          daysInAdvance: 5
        };
      }
    }

    // Inicializar otras configuraciones de notificaciones
    if (!this.preferences.notifications.otherCommunicationsSettings) {
      this.preferences.notifications.otherCommunicationsSettings = {
        notifyOnceOnly: true,
        daysInAdvance: 5
      };
    }
    if (!this.preferences.notifications.loginAlertsSettings) {
      this.preferences.notifications.loginAlertsSettings = {
        notifyOnceOnly: true,
        daysInAdvance: 5
      };
    }
  }

  next();
});

// Método para comparar contraseñas
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Agregamos métodos útiles para trabajar con skills
UserSchema.methods.addSkill = function (skillData) {
  // Si es solo un string, lo convertimos a objeto
  if (typeof skillData === 'string') {
    skillData = {
      name: skillData,
      registrationNumber: '',
      status: 'Activa'
    };
  }

  // Verificamos si ya existe la habilidad
  const existingIndex = this.skill.findIndex(s =>
    (typeof s === 'string' && s === skillData.name) ||
    (typeof s === 'object' && s.name === skillData.name)
  );

  if (existingIndex >= 0) {
    // Actualizar la existente
    this.skill[existingIndex] = skillData;
  } else {
    // Agregar nueva
    this.skill.push(skillData);
  }

  return this;
};

UserSchema.methods.updateSkillRegistration = function (skillName, registrationNumber) {
  const skill = this.skill.find(s =>
    (typeof s === 'object' && s.name === skillName)
  );

  if (skill) {
    skill.registrationNumber = registrationNumber;
  }

  return this;
};

// Métodos para gestionar las preferencias del usuario
UserSchema.methods.updatePreferences = function (preferencesData) {
  // Actualizamos solo los campos proporcionados
  Object.keys(preferencesData).forEach(key => {
    if (key in this.preferences) {
      this.preferences[key] = preferencesData[key];
    }
  });

  return this;
};

// Método para actualizar configuración específica de notificaciones
UserSchema.methods.updateNotificationSettings = function (notificationType, settings) {
  // Asegurarse de que las preferencias y notificaciones existen
  if (!this.preferences) this.preferences = {};
  if (!this.preferences.notifications) this.preferences.notifications = {};

  // Mapeo de tipos de notificación a sus rutas en el objeto de preferencias
  const settingsMap = {
    // Usuario
    'calendar': 'user.calendarSettings',
    'expiration': 'user.expirationSettings',
    'inactivity': 'user.inactivitySettings',

    // Sistema
    'alerts': 'system.alertsSettings',
    'news': 'system.newsSettings',
    'userActivity': 'system.userActivitySettings',

    // Otros
    'otherCommunications': 'otherCommunicationsSettings',
    'loginAlerts': 'loginAlertsSettings'
  };

  // Si el tipo de notificación es válido
  if (notificationType in settingsMap) {
    const path = settingsMap[notificationType].split('.');

    // Navegar a la ruta correcta y actualizar la configuración
    let target = this.preferences.notifications;

    // Para rutas anidadas como 'user.calendarSettings'
    if (path.length > 1) {
      if (!target[path[0]]) target[path[0]] = {};
      target = target[path[0]];
    }

    // Actualizar la configuración
    const settingKey = path[path.length - 1];
    target[settingKey] = {
      ...target[settingKey],
      ...settings
    };
  }

  return this;
};

// Métodos para gestionar sesiones activas
UserSchema.methods.addSession = function (sessionData) {
  // Si ya existe una sesión con el mismo deviceId, la actualizamos
  const existingSessionIndex = this.activeSessions.findIndex(
    session => session.deviceId === sessionData.deviceId
  );

  const newSession = {
    ...sessionData,
    lastActivity: new Date()
  };

  if (existingSessionIndex >= 0) {
    this.activeSessions[existingSessionIndex] = newSession;
  } else {
    this.activeSessions.push(newSession);
  }

  return this;
};

UserSchema.methods.updateSessionActivity = function (deviceId) {
  const session = this.activeSessions.find(s => s.deviceId === deviceId);
  if (session) {
    session.lastActivity = new Date();
  }
  return this;
};

UserSchema.methods.removeSession = function (deviceId) {
  this.activeSessions = this.activeSessions.filter(s => s.deviceId !== deviceId);
  return this;
};

UserSchema.methods.removeAllSessionsExcept = function (deviceId) {
  this.activeSessions = this.activeSessions.filter(s => s.deviceId === deviceId);
  return this;
};

// Función para calcular el puntaje de completitud del perfil
function calculateCompletionScore(user) {
  const fieldsToCheck = [
    { field: 'firstName', weight: 10 },
    { field: 'lastName', weight: 10 },
    { field: 'email', weight: 15 },
    { field: 'avatar', weight: 5 },
    { field: 'contact', weight: 10 },
    { field: 'address', weight: 10 },
    { field: 'country', weight: 5 },
    { field: 'state', weight: 5 },
    { field: 'zipCode', weight: 5 },
    { field: 'designation', weight: 5 },
    { field: 'dob', weight: 5 },
    { field: 'note', weight: 5 },
    { field: 'skill', weight: 10 } // Para arrays, verificamos si tiene elementos
  ];

  let totalScore = 0;

  fieldsToCheck.forEach(item => {
    const fieldValue = user[item.field];
    if (fieldValue) {
      if (Array.isArray(fieldValue)) {
        // Si es un array, verificamos que tenga al menos un elemento
        if (fieldValue.length > 0) {
          totalScore += item.weight;
        }
      } else {
        // Para campos regulares, verificamos que no estén vacíos
        if (typeof fieldValue === 'string' && fieldValue.trim() !== '') {
          totalScore += item.weight;
        } else if (fieldValue instanceof Date || typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
          totalScore += item.weight;
        }
      }
    }
  });

  return Math.min(100, totalScore); // Aseguramos que no exceda 100
}

// Añadimos la función como método estático para poder usarla en el controlador
UserSchema.statics.calculateCompletionScore = calculateCompletionScore;

module.exports = mongoose.model("Usuarios", UserSchema);