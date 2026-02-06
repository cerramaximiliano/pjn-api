const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Modelo para la configuración del worker de documentos atorados
 * Refleja el mismo schema que en pjn-workers
 */
const configuracionStuckDocumentsSchema = new Schema({
    fuero: {
        type: String,
        required: true,
        enum: ['CIV', 'CSS', 'CNT', 'COM'],
        default: 'CIV'
    },
    worker_id: {
        type: String,
        required: true,
        unique: true,
        default: 'stuck_documents_main'
    },
    processing_mode: {
        type: String,
        enum: ['all', 'civil', 'ss', 'trabajo', 'comercial'],
        default: 'all'
    },
    enabled: {
        type: Boolean,
        default: true
    },
    // Configuración de horarios
    schedule: {
        cronPattern: {
            type: String,
            default: '*/10 * * * *'
        },
        workingDays: {
            type: [Number],
            default: [1, 2, 3, 4, 5],
            validate: {
                validator: function(arr) {
                    return arr.every(day => day >= 0 && day <= 6);
                },
                message: 'Los días deben estar entre 0 (Domingo) y 6 (Sábado)'
            }
        },
        workingHoursStart: {
            type: Number,
            default: 8,
            min: 0,
            max: 23
        },
        workingHoursEnd: {
            type: Number,
            default: 22,
            min: 0,
            max: 23
        },
        timezone: {
            type: String,
            default: 'America/Argentina/Buenos_Aires'
        },
        pauseOnWeekends: {
            type: Boolean,
            default: true
        },
        pauseOnHolidays: {
            type: Boolean,
            default: false
        }
    },
    batch_size: {
        type: Number,
        default: 3,
        min: 1,
        max: 10
    },
    lock_timeout_minutes: {
        type: Number,
        default: 20,
        min: 5,
        max: 60
    },
    captcha_provider: {
        type: String,
        enum: ['2captcha', 'capsolver'],
        default: 'capsolver'
    },
    captcha_key: String,
    captcha: {
        defaultProvider: {
            type: String,
            enum: ['2captcha', 'capsolver'],
            default: 'capsolver'
        },
        apiKeys: {
            capsolver: {
                key: String,
                enabled: { type: Boolean, default: true }
            },
            twocaptcha: {
                key: String,
                enabled: { type: Boolean, default: false }
            }
        }
    },
    balance: {
        provider: {
            type: String,
            enum: ['2captcha', 'capsolver'],
            default: 'capsolver'
        }
    },
    // Estadísticas
    documents_processed: { type: Number, default: 0 },
    documents_fixed: { type: Number, default: 0 },
    documents_failed: { type: Number, default: 0 },
    last_check: Date
}, {
    timestamps: true,
    collection: 'configuracion-stuck-documents'
});

module.exports = mongoose.model('ConfiguracionStuckDocuments', configuracionStuckDocumentsSchema);
