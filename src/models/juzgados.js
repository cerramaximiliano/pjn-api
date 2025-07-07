const mongoose = require("mongoose");
const { Schema } = mongoose;

const juzgadoExistenteSchema = new Schema({
  jurisdiccion: {
    type: String,
    required: true
  },
  organismo: {
    type: String,
    required: true
  },
  codigo: {
    type: Number,
    required: true,
    index: true
  },
  ciudad: {
    type: String,
    required: true
  }
}, {
  timestamps: false, // No usar timestamps automáticos
  strict: true, // Solo permitir campos definidos en el esquema
  collection: 'juzgados' // Nombre explícito de la colección
});

// Índices para búsquedas comunes
juzgadoExistenteSchema.index({ codigo: 1, organismo: 1 });
juzgadoExistenteSchema.index({ jurisdiccion: 1 });

// Usar el nombre de colección existente
module.exports = mongoose.model("JuzgadoExistente", juzgadoExistenteSchema, "juzgados");