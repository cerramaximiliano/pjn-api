const ConfiguracionScrapingHistory = require('../models/configuracionScrapingHistory');
const { logger } = require('../config/pino');

const configuracionScrapingHistoryController = {
  async findAll(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        fuero,
        year,
        worker_id,
        sortBy = 'completedAt',
        sortOrder = 'desc'
      } = req.query;

      const filter = {};

      // Filtros opcionales
      if (fuero && fuero !== 'TODOS') {
        filter.fuero = fuero;
      }
      if (year && year !== 'TODOS') {
        filter.year = year;
      }
      if (worker_id) {
        filter.worker_id = worker_id;
      }

      const skip = (page - 1) * limit;

      // Validar campos de ordenamiento permitidos
      const validSortFields = [
        'worker_id',
        'fuero',
        'year',
        'range_start',
        'range_end',
        'documentsProcessed',
        'documentsFound',
        'completedAt',
        'startedAt',
        'version'
      ];

      const sortField = validSortFields.includes(sortBy) ? sortBy : 'completedAt';
      const sortOptions = {};
      sortOptions[sortField] = sortOrder === 'asc' ? 1 : -1;

      logger.info(`[findAll History] Query params: page=${page}, limit=${limit}, fuero=${fuero}, year=${year}, worker_id=${worker_id}, sortBy=${sortBy}, sortOrder=${sortOrder}`);
      logger.info(`[findAll History] Filter applied:`, JSON.stringify(filter));
      logger.info(`[findAll History] Sort applied:`, JSON.stringify(sortOptions));

      const [history, total] = await Promise.all([
        ConfiguracionScrapingHistory.find(filter)
          .populate('configuracionScrapingId', 'worker_id fuero year range_start range_end')
          .sort(sortOptions)
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        ConfiguracionScrapingHistory.countDocuments(filter)
      ]);

      // Extraer worker_id del documento poblado si existe
      const historyWithWorkerId = history.map(item => ({
        ...item,
        worker_id: item.configuracionScrapingId?.worker_id || 'N/A'
      }));

      logger.info(`[findAll History] Results: count=${history.length}, total=${total}, pages=${Math.ceil(total / limit)}`);

      res.json({
        success: true,
        message: 'Historial completo encontrado',
        count: historyWithWorkerId.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: historyWithWorkerId
      });

    } catch (error) {
      logger.error(`Error obteniendo historial completo: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async findByConfiguracion(req, res) {
    try {
      const { configuracionId } = req.params;
      const { page = 1, limit = 10 } = req.query;

      const skip = (page - 1) * limit;

      const [history, total] = await Promise.all([
        ConfiguracionScrapingHistory.getHistoryByConfiguracion(
          configuracionId, 
          { limit: Number(limit), skip }
        ),
        ConfiguracionScrapingHistory.countDocuments({ 
          configuracionScrapingId: configuracionId 
        })
      ]);

      res.json({
        success: true,
        message: 'Historial de configuración encontrado',
        count: history.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: history
      });

    } catch (error) {
      logger.error(`Error obteniendo historial de configuración: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async findByFueroAndYear(req, res) {
    try {
      const { fuero, year } = req.params;
      const { page = 1, limit = 20 } = req.query;

      const skip = (page - 1) * limit;

      const [history, total] = await Promise.all([
        ConfiguracionScrapingHistory.find({ fuero, year })
          .sort({ completedAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        ConfiguracionScrapingHistory.countDocuments({ fuero, year })
      ]);

      res.json({
        success: true,
        message: 'Historial encontrado por fuero y año',
        count: history.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: history
      });

    } catch (error) {
      logger.error(`Error obteniendo historial por fuero y año: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async getStatsByFueroAndYear(req, res) {
    try {
      const { fuero, year } = req.params;

      const stats = await ConfiguracionScrapingHistory.getStatsByFueroAndYear(
        fuero, 
        year
      );

      if (!stats || stats.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No se encontraron estadísticas para el fuero y año especificados',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Estadísticas obtenidas exitosamente',
        data: stats[0]
      });

    } catch (error) {
      logger.error(`Error obteniendo estadísticas: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async checkOverlappingRanges(req, res) {
    try {
      const { fuero, year, range_start, range_end } = req.query;

      if (!fuero || !year || !range_start || !range_end) {
        return res.status(400).json({
          success: false,
          message: 'Los parámetros fuero, year, range_start y range_end son obligatorios',
          data: null
        });
      }

      const hasOverlapping = await ConfiguracionScrapingHistory.hasOverlappingRange(
        fuero,
        year,
        Number(range_start),
        Number(range_end)
      );

      res.json({
        success: true,
        message: hasOverlapping ? 'Existen rangos superpuestos' : 'No hay rangos superpuestos',
        data: { hasOverlapping }
      });

    } catch (error) {
      logger.error(`Error verificando rangos superpuestos: ${error}`);
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

      const deleted = await ConfiguracionScrapingHistory.findByIdAndDelete(id);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          message: 'Registro de historial no encontrado',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Registro de historial eliminado exitosamente',
        data: deleted
      });

    } catch (error) {
      logger.error(`Error eliminando registro de historial: ${error}`);
      
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

module.exports = configuracionScrapingHistoryController;