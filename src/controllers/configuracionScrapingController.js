const { ConfiguracionScraping } = require("pjn-models");
const ConfiguracionScrapingHistory = require('../models/configuracionScrapingHistory');
const { logger } = require('../config/pino');

const configuracionScrapingController = {
  async findAll(req, res) {
    try {
      const {
        activo,
        enabled,
        fuero,
        year,
        progreso,
        includeTemporary = 'false',
        sortBy = 'nombre',
        sortOrder = 'asc',
        page = 1,
        limit = 20
      } = req.query;

      const filter = {};

      // Filtro por documentos temporales (por defecto solo mostrar permanentes)
      // Excluir solo los que tienen isTemporary: true
      // Incluir los que tienen isTemporary: false, undefined, null o sin el campo
      if (includeTemporary !== 'true') {
        filter.isTemporary = { $ne: true };
      }

      if (activo !== undefined) {
        filter.activo = activo === 'true';
      }

      // Filtro por estado (enabled/disabled)
      if (enabled !== undefined) {
        filter.enabled = enabled === 'true';
      }

      // Filtro por fuero
      if (fuero && fuero !== 'TODOS') {
        filter.fuero = fuero;
      }

      // Filtro por año
      if (year && year !== 'TODOS') {
        filter.year = Number(year);
      }

      // Filtro por progreso (completo/incompleto)
      if (progreso === 'completo') {
        // Progreso 100%: number >= range_end
        filter.$expr = { $gte: ['$number', '$range_end'] };
      } else if (progreso === 'incompleto') {
        // Progreso < 100%: number < range_end
        filter.$expr = { $lt: ['$number', '$range_end'] };
      }

      const skip = (page - 1) * limit;

      // Construir ordenamiento
      const sortOptions = {};
      const validSortFields = ['nombre', 'fuero', 'year', 'number', 'range_start', 'range_end', 'enabled', 'updatedAt', 'last_check'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'nombre';
      sortOptions[sortField] = sortOrder === 'desc' ? -1 : 1;

      logger.info(`[findAll] Query params: page=${page}, limit=${limit}, activo=${activo}, enabled=${enabled}, fuero=${fuero}, year=${year}, progreso=${progreso}, sortBy=${sortBy}, sortOrder=${sortOrder}, includeTemporary=${includeTemporary}`);
      logger.info(`[findAll] Filter applied:`, JSON.stringify(filter));
      logger.info(`[findAll] Sort applied:`, JSON.stringify(sortOptions));
      logger.info(`[findAll] Skip: ${skip}, Limit: ${Number(limit)}`);

      const [configuraciones, total] = await Promise.all([
        ConfiguracionScraping.find(filter)
          .select('-__v')
          .sort(sortOptions)
          .skip(skip)
          .limit(Number(limit)),
        ConfiguracionScraping.countDocuments(filter)
      ]);

      logger.info(`[findAll] Results: count=${configuraciones.length}, total=${total}, pages=${Math.ceil(total / limit)}`);

      // Log de IDs para detectar qué documentos cambian
      const ids = configuraciones.map(c => c._id.toString()).slice(0, 5).join(', ');
      logger.info(`[findAll] First 5 Document IDs: ${ids}...`);

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

  async create(req, res) {
    try {
      const {
        fuero,
        year,
        range_start,
        range_end,
        max_number,
        nombre,
        enabled = false,
        number
      } = req.body;

      // Validaciones básicas
      if (!fuero || !year || !range_start || !range_end || !max_number) {
        return res.status(400).json({
          success: false,
          message: 'Los campos fuero, year, range_start, range_end y max_number son obligatorios',
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

      // Verificar si hay rangos superpuestos en el historial
      const hasOverlappingHistory = await ConfiguracionScrapingHistory.hasOverlappingRange(
        fuero,
        year,
        range_start,
        range_end
      );

      if (hasOverlappingHistory) {
        return res.status(400).json({
          success: false,
          message: 'El rango especificado se superpone con un rango existente en el historial',
          data: null
        });
      }

      // Buscar si existe exactamente el mismo rango en el historial
      const duplicateInHistory = await ConfiguracionScrapingHistory.findOne({
        fuero: fuero,
        year: year,
        range_start: range_start,
        range_end: range_end
      });

      if (duplicateInHistory) {
        return res.status(400).json({
          success: false,
          message: `Este rango ya fue procesado anteriormente (versión ${duplicateInHistory.version}, completado el ${duplicateInHistory.completedAt.toLocaleDateString()})`,
          data: {
            existingRange: {
              version: duplicateInHistory.version,
              completedAt: duplicateInHistory.completedAt,
              documentsFound: duplicateInHistory.documentsFound,
              documentsProcessed: duplicateInHistory.documentsProcessed
            }
          }
        });
      }

      // Verificar si existe un documento de ConfiguracionScraping con rango superpuesto
      const overlappingConfig = await ConfiguracionScraping.findOne({
        fuero: fuero,
        year: year,
        $or: [
          // El nuevo rango comienza dentro de un rango existente
          { range_start: { $lte: range_start }, range_end: { $gte: range_start } },
          // El nuevo rango termina dentro de un rango existente
          { range_start: { $lte: range_end }, range_end: { $gte: range_end } },
          // El nuevo rango contiene completamente un rango existente
          { range_start: { $gte: range_start }, range_end: { $lte: range_end } }
        ]
      });

      if (overlappingConfig) {
        return res.status(400).json({
          success: false,
          message: `El rango se superpone con otra configuración activa: ${overlappingConfig.nombre || overlappingConfig._id}`,
          data: {
            conflictingConfig: {
              id: overlappingConfig._id,
              nombre: overlappingConfig.nombre,
              range_start: overlappingConfig.range_start,
              range_end: overlappingConfig.range_end,
              enabled: overlappingConfig.enabled,
              number: overlappingConfig.number
            }
          }
        });
      }

      // Crear el nuevo documento
      const nuevaConfiguracion = new ConfiguracionScraping({
        fuero,
        year,
        range_start,
        range_end,
        max_number,
        nombre: nombre || `${fuero} ${year} (${range_start}-${range_end})`,
        enabled: enabled,
        number: number || range_start,
        completionEmailSent: false,
        documentsProcessed: 0,
        documentsFound: 0,
        activo: true,
        createdAt: new Date(),
        lastActivityAt: new Date()
      });

      const configuracionGuardada = await nuevaConfiguracion.save();

      res.status(201).json({
        success: true,
        message: 'Configuración de scraping creada exitosamente',
        data: configuracionGuardada
      });

    } catch (error) {
      logger.error(`Error creando configuración de scraping: ${error}`);
      
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Error de validación',
          error: error.message,
          data: null
        });
      }

      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe una configuración con estos datos',
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

      // Verificar si el nuevo rango es igual al rango actual
      if (configuracion.range_start === range_start && configuracion.range_end === range_end) {
        return res.status(400).json({
          success: false,
          message: 'El nuevo rango es idéntico al rango actual',
          data: null
        });
      }

      // Verificar si hay rangos superpuestos en el historial
      const hasOverlapping = await ConfiguracionScrapingHistory.hasOverlappingRange(
        configuracion.fuero,
        configuracion.year,
        range_start,
        range_end
      );

      if (hasOverlapping) {
        return res.status(400).json({
          success: false,
          message: 'El rango especificado se superpone con un rango existente en el historial',
          data: null
        });
      }

      // Buscar si existe exactamente el mismo rango en el historial
      const duplicateRange = await ConfiguracionScrapingHistory.findOne({
        fuero: configuracion.fuero,
        year: configuracion.year,
        range_start: range_start,
        range_end: range_end
      });

      if (duplicateRange) {
        return res.status(400).json({
          success: false,
          message: `Este rango ya fue procesado anteriormente (versión ${duplicateRange.version}, completado el ${duplicateRange.completedAt.toLocaleDateString()})`,
          data: {
            existingRange: {
              version: duplicateRange.version,
              completedAt: duplicateRange.completedAt,
              documentsFound: duplicateRange.documentsFound,
              documentsProcessed: duplicateRange.documentsProcessed
            }
          }
        });
      }

      // Verificar si otro documento de ConfiguracionScraping tiene un rango superpuesto
      const overlappingConfig = await ConfiguracionScraping.findOne({
        _id: { $ne: id }, // Excluir el documento actual
        fuero: configuracion.fuero, // Mismo fuero
        year: configuracion.year, // Mismo año
        $or: [
          // El nuevo rango comienza dentro de un rango existente
          { range_start: { $lte: range_start }, range_end: { $gte: range_start } },
          // El nuevo rango termina dentro de un rango existente
          { range_start: { $lte: range_end }, range_end: { $gte: range_end } },
          // El nuevo rango contiene completamente un rango existente
          { range_start: { $gte: range_start }, range_end: { $lte: range_end } }
        ]
      });

      if (overlappingConfig) {
        return res.status(400).json({
          success: false,
          message: `El rango se superpone con otra configuración activa: ${overlappingConfig.nombre || overlappingConfig._id}`,
          data: {
            conflictingConfig: {
              id: overlappingConfig._id,
              nombre: overlappingConfig.nombre,
              range_start: overlappingConfig.range_start,
              range_end: overlappingConfig.range_end,
              enabled: overlappingConfig.enabled,
              number: overlappingConfig.number
            }
          }
        });
      }

      // Obtener la versión más alta del historial
      const lastHistory = await ConfiguracionScrapingHistory
        .findOne({ configuracionScrapingId: id })
        .sort({ version: -1 })
        .lean();

      const nextVersion = lastHistory ? lastHistory.version + 1 : 1;

      // Crear registro en el historial
      const historicalData = new ConfiguracionScrapingHistory({
        configuracionScrapingId: id,
        fuero: configuracion.fuero,
        year: configuracion.year,
        version: nextVersion,
        range_start: configuracion.range_start,
        range_end: configuracion.range_end,
        completedAt: new Date(),
        lastProcessedNumber: configuracion.number,
        documentsProcessed: configuracion.documentsProcessed || 0,
        documentsFound: configuracion.documentsFound || 0,
        enabled: configuracion.enabled,
        completionEmailSent: configuracion.completionEmailSent,
        startedAt: configuracion.startedAt,
        duration: configuracion.duration,
        errors: configuracion.errors || [],
        lastError: configuracion.lastError,
        retryCount: configuracion.retryCount || 0
      });

      // Agregar captchaStats si existen
      if (configuracion.captchaStats) {
        historicalData.captchaStats = {
          totalCaptchas: configuracion.captchaStats.totalCaptchas,
          totalCaptchasFailed: configuracion.captchaStats.totalCaptchasFailed,
          totalCost: configuracion.captchaStats.totalCost,
          provider: configuracion.captchaStats.provider
        };
      }

      // Agregar requestStats si existen
      if (configuracion.requestStats) {
        historicalData.requestStats = {
          totalRequests: configuracion.requestStats.totalRequests,
          successfulRequests: configuracion.requestStats.successfulRequests,
          failedRequests: configuracion.requestStats.failedRequests
        };
      }

      // Guardar el historial
      await historicalData.save();

      // Preparar la actualización del documento principal
      const updateData = {
        range_start: range_start,
        range_end: range_end,
        number: range_start, // Actualizar number al inicio del nuevo rango
        enabled: true,
        completionEmailSent: false,
        // Resetear campos para el nuevo ciclo
        documentsProcessed: 0,
        documentsFound: 0,
        startedAt: null,
        duration: null,
        errors: [],
        lastError: null,
        retryCount: 0,
        lastActivityAt: new Date()
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
        message: 'Rango actualizado exitosamente y datos anteriores archivados en el historial',
        data: {
          configuracion: configuracionActualizada,
          historialCreado: {
            _id: historicalData._id,
            version: historicalData.version,
            range_start: historicalData.range_start,
            range_end: historicalData.range_end
          }
        }
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
  },

  async deleteById(req, res) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'El parámetro id es obligatorio',
          data: null
        });
      }

      // Buscar la configuración antes de eliminarla
      const configuracion = await ConfiguracionScraping.findById(id);

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de scraping no encontrada',
          data: null
        });
      }

      // Verificar si el worker está activo (enabled = true)
      if (configuracion.enabled) {
        return res.status(400).json({
          success: false,
          message: 'No se puede eliminar una configuración activa. Desactívela primero.',
          data: null
        });
      }

      // Eliminar la configuración
      await ConfiguracionScraping.findByIdAndDelete(id);

      logger.info(`Configuración de scraping eliminada: ${id} - ${configuracion.nombre || configuracion.fuero}`);

      res.json({
        success: true,
        message: 'Configuración de scraping eliminada exitosamente',
        data: {
          _id: id,
          nombre: configuracion.nombre,
          fuero: configuracion.fuero
        }
      });

    } catch (error) {
      logger.error(`Error eliminando configuración de scraping: ${error}`);

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