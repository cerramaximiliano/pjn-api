const ConfiguracionScrapingHistory = require('../models/configuracionScrapingHistory');
const { ConfiguracionScraping } = require('pjn-models');
const { logger } = require('../config/pino');

// Helpers para análisis de cobertura
function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 1) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

function calculateGaps(mergedRanges, minStart, maxEnd) {
  const gaps = [];
  let current = minStart;
  for (const range of mergedRanges) {
    if (range.start > current) {
      gaps.push({ start: current, end: range.start - 1, size: range.start - current });
    }
    current = range.end + 1;
  }
  if (current <= maxEnd) {
    gaps.push({ start: current, end: maxEnd, size: maxEnd - current + 1 });
  }
  return gaps;
}

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

  async getCoverageByFueroAndYear(req, res) {
    try {
      const { fuero, year } = req.params;
      const { maxRange } = req.query;

      if (!fuero || !year) {
        return res.status(400).json({
          success: false,
          message: 'Los parámetros fuero y year son obligatorios',
          data: null
        });
      }

      // Traer todos los rangos cubiertos en el historial
      const historyRanges = await ConfiguracionScrapingHistory.find(
        { fuero, year: String(year) },
        { range_start: 1, range_end: 1 }
      ).lean();

      // Traer workers activos para ese fuero+año
      const activeWorkers = await ConfiguracionScraping.find(
        { fuero, year: Number(year), enabled: true, isTemporary: { $ne: true } },
        { worker_id: 1, range_start: 1, range_end: 1, number: 1, max_number: 1 }
      ).lean();

      // Determinar límite superior del rango
      const allEnds = [
        ...historyRanges.map(r => r.range_end),
        ...activeWorkers.map(w => w.max_number || w.range_end || 0)
      ].filter(Boolean);

      const computedMax = allEnds.length ? Math.max(...allEnds) : 0;
      const maxEnd = maxRange ? Number(maxRange) : computedMax;

      if (maxEnd === 0) {
        return res.json({
          success: true,
          message: 'No hay datos para el fuero y año especificados',
          data: {
            fuero,
            year,
            maxRange: 0,
            coveredRanges: [],
            totalCovered: 0,
            coveragePercent: 0,
            gaps: [],
            activeWorkers: []
          }
        });
      }

      // Mergear rangos cubiertos
      const rawRanges = historyRanges.map(r => ({ start: r.range_start, end: r.range_end }));
      const coveredRanges = mergeRanges(rawRanges);
      const totalCovered = coveredRanges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);

      // Calcular gaps
      const gaps = calculateGaps(coveredRanges, 1, maxEnd);

      // Enriquecer gaps: marcar si ya tienen worker asignado
      const enrichedGaps = gaps.map(gap => {
        const assignedWorker = activeWorkers.find(w =>
          (w.range_start <= gap.end && w.range_end >= gap.start)
        );
        return {
          ...gap,
          assigned: !!assignedWorker,
          workerId: assignedWorker?.worker_id || null
        };
      });

      logger.info(`[getCoverage] fuero=${fuero} year=${year} maxEnd=${maxEnd} covered=${totalCovered} gaps=${gaps.length}`);

      res.json({
        success: true,
        message: 'Cobertura calculada exitosamente',
        data: {
          fuero,
          year,
          maxRange: maxEnd,
          coveredRanges,
          totalCovered,
          coveragePercent: maxEnd > 0 ? Math.round((totalCovered / maxEnd) * 100) : 0,
          gaps: enrichedGaps,
          activeWorkers: activeWorkers.map(w => ({
            worker_id: w.worker_id,
            range_start: w.range_start,
            range_end: w.range_end,
            current: w.number,
            max_number: w.max_number
          }))
        }
      });

    } catch (error) {
      logger.error(`Error calculando cobertura: ${error}`);
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