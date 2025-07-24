const ConfiguracionVerificacion = require("../models/configuracionVerificacion");
const { logger } = require('../config/pino');

const configuracionVerificacionController = {
  // Obtener todos los documentos de configuración
  async findAll(req, res) {
    try {
      const { activo, page = 1, limit = 20 } = req.query;

      // Construir el filtro de búsqueda
      const filter = {};
      
      if (activo !== undefined) {
        filter.activo = activo === 'true';
      }

      // Calcular skip para paginación
      const skip = (page - 1) * limit;

      // Buscar configuraciones con paginación
      const [configuraciones, total] = await Promise.all([
        ConfiguracionVerificacion.find(filter)
          .select('-__v')
          .sort({ nombre: 1 })
          .skip(skip)
          .limit(Number(limit)),
        ConfiguracionVerificacion.countDocuments(filter)
      ]);

      res.json({
        success: true,
        message: 'Configuraciones encontradas',
        count: configuraciones.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: configuraciones
      });

    } catch (error) {
      logger.error(`Error obteniendo configuraciones de verificación: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: null
      });
    }
  },

  // Modificar un documento por _id
  async updateById(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      // Validar que el id sea proporcionado
      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'El parámetro id es obligatorio',
          data: null
        });
      }

      // Buscar y actualizar el documento
      const configuracion = await ConfiguracionVerificacion.findByIdAndUpdate(
        id,
        updateData,
        { 
          new: true, // Devolver el documento actualizado
          runValidators: true // Ejecutar validaciones del esquema
        }
      ).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Configuración actualizada exitosamente',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error actualizando configuración de verificación: ${error}`);
      
      // Manejar errores de validación de MongoDB
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Error de validación',
          error: error.message,
          data: null
        });
      }

      // Manejar errores de ObjectId inválido
      if (error.name === 'CastError') {
        return res.status(400).json({
          success: false,
          message: 'ID inválido',
          error: error.message,
          data: null
        });
      }

      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  }
};

module.exports = configuracionVerificacionController;