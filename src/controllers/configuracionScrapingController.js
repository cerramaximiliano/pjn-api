const { ConfiguracionScraping } = require("pjn-models");
const { logger } = require('../config/pino');

const configuracionScrapingController = {
  async findAll(req, res) {
    try {
      const { activo, page = 1, limit = 20 } = req.query;

      const filter = {};
      
      if (activo !== undefined) {
        filter.activo = activo === 'true';
      }

      const skip = (page - 1) * limit;

      const [configuraciones, total] = await Promise.all([
        ConfiguracionScraping.find(filter)
          .select('-__v')
          .sort({ nombre: 1 })
          .skip(skip)
          .limit(Number(limit)),
        ConfiguracionScraping.countDocuments(filter)
      ]);

      res.json({
        success: true,
        message: 'Configuraciones de scraping encontradas',
        count: configuraciones.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: configuraciones
      });

    } catch (error) {
      logger.error(`Error obteniendo configuraciones de scraping: ${error}`);
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

      const configuracion = await ConfiguracionScraping.findByIdAndUpdate(
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
          message: 'Configuración de scraping no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Configuración de scraping actualizada exitosamente',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error actualizando configuración de scraping: ${error}`);
      
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

module.exports = configuracionScrapingController;