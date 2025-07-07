const mongoose = require("mongoose");
const { Schema } = mongoose;

const jurisdiccionSchema = new Schema({
  jurisdiccion: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  categoria: {
    type: String,
    required: true,
    index: true
  },
  codigo: {
    type: Number,
    sparse: true, // Permite valores null y solo indexa los que existen
    index: true
  }
}, {
  timestamps: true, // Agregar createdAt y updatedAt
  collection: 'jurisdicciones' // Nombre explícito de la colección
});

// Índice compuesto para búsquedas por categoría
jurisdiccionSchema.index({ categoria: 1, jurisdiccion: 1 });

module.exports = mongoose.model("Jurisdiccion", jurisdiccionSchema, "jurisdicciones");