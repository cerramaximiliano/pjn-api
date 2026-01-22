/**
 * Modelo Interviniente
 * Almacena intervinientes (partes y letrados) de expedientes judiciales
 * Cada documento representa un contacto individual vinculado a una causa
 */
const mongoose = require("mongoose");

const schema = new mongoose.Schema(
    {
        // Referencia a la causa
        causaId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            index: true
        },

        // Información del expediente (desnormalizada para búsquedas)
        expediente: {
            number: { type: Number, required: true },
            year: { type: Number, required: true },
            fuero: { type: String, required: true },
            caratula: { type: String }
        },

        // Tipo de interviniente
        tipoInterviniente: {
            type: String,
            enum: ['PARTE', 'LETRADO'],
            required: true,
            index: true
        },

        // Datos de la parte (si tipoInterviniente = 'PARTE')
        parte: {
            tipo: { type: String },        // ACTOR, DEMANDADO, TERCERO, etc.
            nombre: { type: String },
            tomoFolio: { type: String },
            iej: { type: String }
        },

        // Datos del letrado (si tipoInterviniente = 'LETRADO')
        letrado: {
            tipo: { type: String },        // LETRADO APODERADO, LETRADO PATROCINANTE, etc.
            nombre: { type: String },
            matricula: { type: String },   // Tomo: X Folio: Y - COLEGIO
            estadoIej: { type: String },   // CONSTITUIDO, NO CONSTITUIDO
            parteRepresentada: {           // Referencia a la parte que representa
                tipo: { type: String },
                nombre: { type: String }
            }
        },

        // Nombre normalizado para búsquedas
        nombreNormalizado: {
            type: String,
            index: true
        },

        // Metadata
        fechaExtraccion: {
            type: Date,
            default: Date.now
        },
        source: {
            type: String,
            default: 'extra-info-worker'
        }
    },
    {
        collection: "intervinientes",
        timestamps: true
    }
);

// Índices compuestos para búsquedas eficientes
schema.index({ causaId: 1, tipoInterviniente: 1 });
schema.index({ 'expediente.number': 1, 'expediente.year': 1, 'expediente.fuero': 1 });
schema.index({ 'parte.nombre': 1 });
schema.index({ 'letrado.nombre': 1 });
schema.index({ nombreNormalizado: 'text' });

// Pre-save hook para normalizar nombre
schema.pre('save', function(next) {
    if (this.tipoInterviniente === 'PARTE' && this.parte?.nombre) {
        this.nombreNormalizado = this.parte.nombre.toLowerCase().trim();
    } else if (this.tipoInterviniente === 'LETRADO' && this.letrado?.nombre) {
        this.nombreNormalizado = this.letrado.nombre.toLowerCase().trim();
    }
    next();
});

// Método estático para buscar intervinientes por causa
schema.statics.findByCausa = function(causaId) {
    return this.find({ causaId }).sort({ tipoInterviniente: 1, 'parte.tipo': 1 });
};

// Método estático para buscar por nombre
schema.statics.findByNombre = function(nombre) {
    const nombreNorm = nombre.toLowerCase().trim();
    return this.find({
        $or: [
            { 'parte.nombre': { $regex: nombre, $options: 'i' } },
            { 'letrado.nombre': { $regex: nombre, $options: 'i' } },
            { nombreNormalizado: { $regex: nombreNorm } }
        ]
    });
};

module.exports = mongoose.model("Interviniente", schema);
