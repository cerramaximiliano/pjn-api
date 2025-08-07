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
  },

  async updateRange(req, res) {
    try {
      const { id } = req.params;
      const { range_start, range_end } = req.body;

      // Validaciones básicas
      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'El parámetro id es obligatorio',
          data: null
        });
      }

      if (!range_start || !range_end) {
        return res.status(400).json({
          success: false,
          message: 'Los parámetros range_start y range_end son obligatorios',
          data: null
        });
      }

      if (range_start >= range_end) {
        return res.status(400).json({
          success: false,
          message: 'El range_start debe ser menor que range_end',
          data: null
        });
      }

      // Buscar el documento actual
      const configuracion = await ConfiguracionScraping.findById(id);

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de scraping no encontrada',
          data: null
        });
      }

      // Verificar si el worker está terminado
      const isCompleted = configuracion.enabled === false && 
                         configuracion.completionEmailSent === true && 
                         configuracion.number >= configuracion.range_end;

      if (!isCompleted) {
        return res.status(400).json({
          success: false,
          message: 'El worker no está terminado. Debe cumplir: enabled=false, completionEmailSent=true y number >= range_end',
          data: null
        });
      }

      // Preparar datos para el historial
      const historicalData = {
        version: configuracion.rangeHistory ? configuracion.rangeHistory.length + 1 : 1,
        range_start: configuracion.range_start,
        range_end: configuracion.range_end,
        year: configuracion.year,
        completedAt: new Date(),
        lastProcessedNumber: configuracion.number,
        documentsProcessed: configuracion.documentsProcessed || 0,
        documentsFound: configuracion.documentsFound || 0,
        enabled: configuracion.enabled,
        completionEmailSent: configuracion.completionEmailSent,
        startedAt: configuracion.startedAt,
        duration: configuracion.duration
      };

      // Agregar captchaStats si existen
      if (configuracion.captchaStats) {
        historicalData.captchaStats = {
          totalCaptchas: configuracion.captchaStats.totalCaptchas,
          totalCaptchasFailed: configuracion.captchaStats.totalCaptchasFailed,
          totalCost: configuracion.captchaStats.totalCost,
          provider: configuracion.captchaStats.provider
        };
      }

      // Preparar la actualización
      const updateData = {
        range_start: range_start,
        range_end: range_end,
        enabled: true,
        completionEmailSent: false,
        // Mantener number en el valor actual como solicitado
        // Resetear campos que parecen apropiados para un nuevo ciclo
        documentsProcessed: 0,
        documentsFound: 0,
        startedAt: null,
        duration: null,
        errors: [],  // Resetear array de errores
        lastError: null,  // Limpiar último error
        retryCount: 0,  // Resetear contador de reintentos
        lastActivityAt: new Date(),  // Actualizar última actividad
        // Agregar el historial
        $push: { rangeHistory: historicalData }
      };

      // Si existe captchaStats, resetear sus valores
      if (configuracion.captchaStats) {
        updateData['captchaStats.totalCaptchas'] = 0;
        updateData['captchaStats.totalCaptchasFailed'] = 0;
        updateData['captchaStats.totalCost'] = 0;
      }

      // Si existe requestStats, resetear sus valores
      if (configuracion.requestStats) {
        updateData['requestStats.totalRequests'] = 0;
        updateData['requestStats.successfulRequests'] = 0;
        updateData['requestStats.failedRequests'] = 0;
      }

      // Actualizar el documento
      const configuracionActualizada = await ConfiguracionScraping.findByIdAndUpdate(
        id,
        updateData,
        { 
          new: true,
          runValidators: true
        }
      ).select('-__v');

      res.json({
        success: true,
        message: 'Rango actualizado exitosamente y datos anteriores archivados',
        data: configuracionActualizada
      });

    } catch (error) {
      logger.error(`Error actualizando rango de configuración: ${error}`);
      
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