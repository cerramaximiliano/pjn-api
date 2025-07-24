const { ConfiguracionAppUpdate } = require("pjn-models");
const { logger } = require('../config/pino');

const configuracionAppUpdateController = {
  async findAll(req, res) {
    try {
      const { activo, page = 1, limit = 20 } = req.query;

      const filter = {};
      
      if (activo !== undefined) {
        filter.activo = activo === 'true';
      }

      const skip = (page - 1) * limit;

      const [configuraciones, total] = await Promise.all([
        ConfiguracionAppUpdate.find(filter)
          .select('-__v')
          .sort({ nombre: 1 })
          .skip(skip)
          .limit(Number(limit)),
        ConfiguracionAppUpdate.countDocuments(filter)
      ]);

      res.json({
        success: true,
        message: 'Configuraciones de actualización de app encontradas',
        count: configuraciones.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: configuraciones
      });

    } catch (error) {
      logger.error(`Error obteniendo configuraciones de actualización de app: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: null
      });
    }
  },

  async updateById(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'El parámetro id es obligatorio',
          data: null
        });
      }

      const configuracion = await ConfiguracionAppUpdate.findByIdAndUpdate(
        id,
        updateData,
        { 
          new: true,
          runValidators: true
        }
      ).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de actualización de app no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Configuración de actualización de app actualizada exitosamente',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error actualizando configuración de actualización de app: ${error}`);
      
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Error de validación',
          error: error.message,
          data: null
        });
      }

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

module.exports = configuracionAppUpdateController;