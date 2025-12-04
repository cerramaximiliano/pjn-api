const WorkerLog = require('../models/workerLog');
const { logger } = require('../config/pino');

const workerLogController = {
  /**
   * GET /worker-logs
   * Lista logs con filtros y paginación
   *
   * Query params:
   * - workerType: verify | update | scraping | recovery | stuck_documents
   * - status: success | partial | failed | in_progress
   * - fuero: civil | ss | trabajo | comercial
   * - workerId: ID específico del worker
   * - hours: número de horas hacia atrás (default: 24)
   * - limit: cantidad de resultados (default: 50, max: 500)
   * - skip: offset para paginación (default: 0)
   * - documentId: filtrar por documento específico
   * - sort: campo para ordenar (default: -startTime)
   */
  async findAll(req, res) {
    try {
      const {
        workerType,
        status,
        fuero,
        workerId,
        hours = 24,
        limit = 50,
        skip = 0,
        documentId,
        sort = '-startTime'
      } = req.query;

      // Construir query
      const query = {};

      // Filtrar por fecha
      if (hours && hours !== 'all') {
        const since = new Date();
        since.setHours(since.getHours() - parseInt(hours));
        query.startTime = { $gte: since };
      }

      // Filtros opcionales
      if (workerType) query.workerType = workerType;
      if (status) query.status = status;
      if (workerId) query.workerId = workerId;
      if (fuero) query['document.fuero'] = fuero;
      if (documentId) query['document.documentId'] = documentId;

      // Limitar cantidad
      const limitNum = Math.min(parseInt(limit), 500);
      const skipNum = parseInt(skip);

      // Parsear sort
      const sortObj = {};
      const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
      const sortOrder = sort.startsWith('-') ? -1 : 1;
      sortObj[sortField] = sortOrder;

      // Ejecutar query con count
      const [logs, total] = await Promise.all([
        WorkerLog.find(query)
          .sort(sortObj)
          .skip(skipNum)
          .limit(limitNum)
          .lean(),
        WorkerLog.countDocuments(query)
      ]);

      res.json({
        success: true,
        data: logs,
        pagination: {
          total,
          limit: limitNum,
          skip: skipNum,
          hasMore: skipNum + logs.length < total,
          pages: Math.ceil(total / limitNum),
          currentPage: Math.floor(skipNum / limitNum) + 1
        }
      });
    } catch (error) {
      logger.error('Error obteniendo worker logs:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/stats
   * Obtiene estadísticas de logs
   */
  async getStats(req, res) {
    try {
      const { workerType, hours = 24 } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      const matchStage = { startTime: { $gte: since } };
      if (workerType) matchStage.workerType = workerType;

      const stats = await WorkerLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: {
              workerType: "$workerType",
              status: "$status"
            },
            count: { $sum: 1 },
            avgDuration: { $avg: "$duration" },
            totalMovimientosAdded: { $sum: "$changes.movimientosAdded" },
            totalNotifications: { $sum: "$notificationsSent" }
          }
        },
        {
          $group: {
            _id: "$_id.workerType",
            stats: {
              $push: {
                status: "$_id.status",
                count: "$count",
                avgDuration: "$avgDuration",
                totalMovimientosAdded: "$totalMovimientosAdded",
                totalNotifications: "$totalNotifications"
              }
            },
            totalCount: { $sum: "$count" }
          }
        },
        { $sort: { totalCount: -1 } }
      ]);

      // Calcular resumen general
      const summary = {
        totalOperations: 0,
        successCount: 0,
        failedCount: 0,
        successRate: 0,
        totalMovimientosAdded: 0,
        totalNotifications: 0,
        avgDuration: 0
      };

      let totalDuration = 0;
      let durationCount = 0;

      stats.forEach(workerStats => {
        summary.totalOperations += workerStats.totalCount;
        workerStats.stats.forEach(s => {
          if (s.status === 'success') summary.successCount += s.count;
          if (s.status === 'failed' || s.status === 'error') summary.failedCount += s.count;
          if (s.totalMovimientosAdded) summary.totalMovimientosAdded += s.totalMovimientosAdded;
          if (s.totalNotifications) summary.totalNotifications += s.totalNotifications;
          if (s.avgDuration) {
            totalDuration += s.avgDuration * s.count;
            durationCount += s.count;
          }
        });
      });

      summary.successRate = summary.totalOperations > 0
        ? parseFloat(((summary.successCount / summary.totalOperations) * 100).toFixed(2))
        : 0;
      summary.avgDuration = durationCount > 0
        ? Math.round(totalDuration / durationCount)
        : 0;

      res.json({
        success: true,
        period: `${hours} horas`,
        periodStart: since,
        periodEnd: new Date(),
        summary,
        byWorkerType: stats
      });
    } catch (error) {
      logger.error('Error obteniendo estadísticas:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/failed
   * Obtiene logs fallidos con análisis de patrones de error
   */
  async getFailed(req, res) {
    try {
      const { workerType, hours = 24, limit = 100 } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      const query = {
        status: { $in: ['failed', 'error'] },
        startTime: { $gte: since }
      };

      if (workerType) query.workerType = workerType;

      const logs = await WorkerLog.find(query)
        .sort({ startTime: -1 })
        .limit(parseInt(limit))
        .lean();

      // Agrupar errores por mensaje para identificar patrones
      const errorPatterns = {};
      logs.forEach(log => {
        const errorMsg = log.result?.error?.message || log.result?.message || 'Error desconocido';
        const key = errorMsg.substring(0, 100); // Truncar para agrupar

        if (!errorPatterns[key]) {
          errorPatterns[key] = {
            count: 0,
            lastOccurrence: null,
            workers: new Set(),
            examples: []
          };
        }
        errorPatterns[key].count++;
        errorPatterns[key].workers.add(log.workerId);

        if (!errorPatterns[key].lastOccurrence ||
            new Date(log.startTime) > new Date(errorPatterns[key].lastOccurrence)) {
          errorPatterns[key].lastOccurrence = log.startTime;
        }

        if (errorPatterns[key].examples.length < 3) {
          errorPatterns[key].examples.push({
            logId: log._id,
            workerId: log.workerId,
            documentId: log.document?.documentId,
            number: log.document?.number,
            year: log.document?.year,
            startTime: log.startTime
          });
        }
      });

      // Convertir Sets a Arrays
      Object.keys(errorPatterns).forEach(key => {
        errorPatterns[key].workers = Array.from(errorPatterns[key].workers);
      });

      res.json({
        success: true,
        total: logs.length,
        period: `${hours} horas`,
        errorPatterns,
        logs
      });
    } catch (error) {
      logger.error('Error obteniendo logs fallidos:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/activity
   * Obtiene actividad reciente (últimos N minutos)
   */
  async getActivity(req, res) {
    try {
      const { minutes = 5 } = req.query;

      const since = new Date();
      since.setMinutes(since.getMinutes() - parseInt(minutes));

      const [recentLogs, inProgress] = await Promise.all([
        WorkerLog.find({ startTime: { $gte: since } })
          .sort({ startTime: -1 })
          .limit(100)
          .lean(),
        WorkerLog.find({ status: 'in_progress' })
          .sort({ startTime: -1 })
          .lean()
      ]);

      // Resumen por worker type
      const activityByWorker = {};
      recentLogs.forEach(log => {
        if (!activityByWorker[log.workerType]) {
          activityByWorker[log.workerType] = {
            total: 0,
            success: 0,
            failed: 0,
            partial: 0,
            inProgress: 0,
            avgDuration: 0,
            durations: []
          };
        }
        activityByWorker[log.workerType].total++;
        if (log.status === 'success') activityByWorker[log.workerType].success++;
        if (log.status === 'failed' || log.status === 'error') activityByWorker[log.workerType].failed++;
        if (log.status === 'partial') activityByWorker[log.workerType].partial++;
        if (log.status === 'in_progress') activityByWorker[log.workerType].inProgress++;
        if (log.duration) activityByWorker[log.workerType].durations.push(log.duration);
      });

      // Calcular promedios
      Object.keys(activityByWorker).forEach(key => {
        const durations = activityByWorker[key].durations;
        if (durations.length > 0) {
          activityByWorker[key].avgDuration = Math.round(
            durations.reduce((a, b) => a + b, 0) / durations.length
          );
        }
        delete activityByWorker[key].durations;
      });

      res.json({
        success: true,
        timestamp: new Date(),
        period: `${minutes} minutos`,
        currentlyProcessing: inProgress.length,
        inProgressTasks: inProgress.map(log => ({
          _id: log._id,
          workerType: log.workerType,
          workerId: log.workerId,
          document: log.document ? {
            number: log.document.number,
            year: log.document.year,
            fuero: log.document.fuero
          } : null,
          startTime: log.startTime,
          runningFor: Date.now() - new Date(log.startTime).getTime()
        })),
        recentActivity: activityByWorker,
        totalRecent: recentLogs.length
      });
    } catch (error) {
      logger.error('Error obteniendo actividad:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/document/:documentId
   * Obtiene historial de logs para un documento específico
   */
  async getByDocument(req, res) {
    try {
      const { documentId } = req.params;
      const { limit = 50 } = req.query;

      const logs = await WorkerLog.find({
        'document.documentId': documentId
      })
        .sort({ startTime: -1 })
        .limit(parseInt(limit))
        .lean();

      if (logs.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No se encontraron logs para este documento'
        });
      }

      // Calcular estadísticas del documento
      const docStats = {
        totalOperations: logs.length,
        successCount: logs.filter(l => l.status === 'success').length,
        failedCount: logs.filter(l => l.status === 'failed' || l.status === 'error').length,
        partialCount: logs.filter(l => l.status === 'partial').length,
        totalMovimientosAdded: logs.reduce((sum, l) => sum + (l.changes?.movimientosAdded || 0), 0),
        lastOperation: logs[0]?.startTime,
        firstOperation: logs[logs.length - 1]?.startTime,
        document: logs[0]?.document
      };

      res.json({
        success: true,
        documentId,
        stats: docStats,
        logs
      });
    } catch (error) {
      logger.error('Error obteniendo logs del documento:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/workers
   * Lista todos los workers únicos con su última actividad
   */
  async getWorkers(req, res) {
    try {
      const { workerType, hours = 24 } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      const matchStage = { startTime: { $gte: since } };
      if (workerType) matchStage.workerType = workerType;

      const workers = await WorkerLog.aggregate([
        { $match: matchStage },
        { $sort: { startTime: -1 } },
        {
          $group: {
            _id: "$workerId",
            workerType: { $first: "$workerType" },
            lastActivity: { $first: "$startTime" },
            lastStatus: { $first: "$status" },
            totalOperations: { $sum: 1 },
            successCount: {
              $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] }
            },
            failedCount: {
              $sum: { $cond: [{ $in: ["$status", ["failed", "error"]] }, 1, 0] }
            },
            avgDuration: { $avg: "$duration" },
            totalMovimientos: { $sum: "$changes.movimientosAdded" }
          }
        },
        { $sort: { lastActivity: -1 } }
      ]);

      res.json({
        success: true,
        period: `${hours} horas`,
        total: workers.length,
        workers: workers.map(w => ({
          workerId: w._id,
          workerType: w.workerType,
          lastActivity: w.lastActivity,
          lastStatus: w.lastStatus,
          stats: {
            totalOperations: w.totalOperations,
            successCount: w.successCount,
            failedCount: w.failedCount,
            successRate: w.totalOperations > 0
              ? parseFloat(((w.successCount / w.totalOperations) * 100).toFixed(2))
              : 0,
            avgDuration: Math.round(w.avgDuration || 0),
            totalMovimientos: w.totalMovimientos
          }
        }))
      });
    } catch (error) {
      logger.error('Error obteniendo workers:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/:id
   * Obtiene un log específico por ID
   */
  async findById(req, res) {
    try {
      const { id } = req.params;

      const log = await WorkerLog.findById(id).lean();

      if (!log) {
        return res.status(404).json({
          success: false,
          message: 'Log no encontrado'
        });
      }

      res.json({
        success: true,
        data: log
      });
    } catch (error) {
      logger.error('Error obteniendo log:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/search-logs
   * Busca en logs detallados
   *
   * Query params:
   * - q: texto a buscar en los mensajes de log
   * - workerType: filtrar por tipo de worker
   * - status: filtrar por estado
   * - hours: número de horas hacia atrás (default: 24)
   * - level: filtrar por nivel de log (debug, info, warn, error)
   * - limit: cantidad de resultados (default: 50, max: 100)
   * - skip: offset para paginación (default: 0)
   */
  async searchDetailedLogs(req, res) {
    try {
      const {
        q: searchText,
        workerType,
        status,
        hours = 24,
        level,
        limit = 50,
        skip = 0
      } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      // Construir query base
      const matchStage = {
        startTime: { $gte: since },
        'detailedLogs.0': { $exists: true } // Solo documentos con logs
      };

      if (workerType) matchStage.workerType = workerType;
      if (status) matchStage.status = status;

      // Buscar texto en los mensajes de logs
      if (searchText) {
        matchStage['detailedLogs.message'] = { $regex: searchText, $options: 'i' };
      }

      if (level) {
        matchStage['detailedLogs.level'] = level;
      }

      const limitNum = Math.min(parseInt(limit), 100);
      const skipNum = parseInt(skip);

      const results = await WorkerLog.aggregate([
        { $match: matchStage },
        { $sort: { startTime: -1 } },
        { $skip: skipNum },
        { $limit: limitNum },
        {
          $project: {
            workerType: 1,
            workerId: 1,
            status: 1,
            startTime: 1,
            endTime: 1,
            duration: 1,
            'document.number': 1,
            'document.year': 1,
            'document.fuero': 1,
            'document.documentId': 1,
            'result.message': 1,
            'result.error': 1,
            // Filtrar logs que coinciden con la búsqueda
            detailedLogs: searchText ? {
              $filter: {
                input: '$detailedLogs',
                as: 'log',
                cond: {
                  $regexMatch: {
                    input: '$$log.message',
                    regex: searchText,
                    options: 'i'
                  }
                }
              }
            } : '$detailedLogs',
            matchCount: searchText ? {
              $size: {
                $filter: {
                  input: '$detailedLogs',
                  as: 'log',
                  cond: {
                    $regexMatch: {
                      input: '$$log.message',
                      regex: searchText,
                      options: 'i'
                    }
                  }
                }
              }
            } : { $size: '$detailedLogs' }
          }
        }
      ]);

      // Contar total
      const countPipeline = [
        { $match: matchStage },
        { $count: 'total' }
      ];
      const countResult = await WorkerLog.aggregate(countPipeline);
      const total = countResult[0]?.total || 0;

      res.json({
        success: true,
        searchText: searchText || null,
        period: `${hours} horas`,
        filters: {
          workerType: workerType || null,
          status: status || null,
          level: level || null
        },
        results,
        pagination: {
          total,
          limit: limitNum,
          skip: skipNum,
          hasMore: skipNum + results.length < total
        }
      });
    } catch (error) {
      logger.error('Error buscando en logs detallados:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/logs-stats
   * Obtiene estadísticas de uso de logs detallados
   */
  async getDetailedLogsStats(req, res) {
    try {
      const stats = await WorkerLog.aggregate([
        {
          $facet: {
            withLogs: [
              { $match: { 'detailedLogs.0': { $exists: true } } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  totalLogEntries: { $sum: { $size: '$detailedLogs' } },
                  avgLogsPerDoc: { $avg: { $size: '$detailedLogs' } }
                }
              }
            ],
            withoutLogs: [
              { $match: { 'detailedLogs.0': { $exists: false } } },
              { $count: 'count' }
            ],
            byWorkerType: [
              { $match: { 'detailedLogs.0': { $exists: true } } },
              {
                $group: {
                  _id: '$workerType',
                  count: { $sum: 1 },
                  totalLogEntries: { $sum: { $size: '$detailedLogs' } }
                }
              }
            ],
            pendingCleanup: [
              {
                $match: {
                  'logsRetention.detailedLogsExpireAt': { $lt: new Date() },
                  'detailedLogs.0': { $exists: true }
                }
              },
              { $count: 'count' }
            ]
          }
        }
      ]);

      const result = stats[0];
      res.json({
        success: true,
        statistics: {
          documentsWithLogs: result.withLogs[0]?.count || 0,
          documentsWithoutLogs: result.withoutLogs[0]?.count || 0,
          totalLogEntries: result.withLogs[0]?.totalLogEntries || 0,
          avgLogsPerDocument: Math.round(result.withLogs[0]?.avgLogsPerDoc || 0),
          byWorkerType: result.byWorkerType,
          pendingCleanup: result.pendingCleanup[0]?.count || 0
        }
      });
    } catch (error) {
      logger.error('Error obteniendo estadísticas de logs detallados:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * POST /worker-logs/cleanup
   * Ejecuta limpieza de logs detallados expirados
   */
  async cleanupExpiredLogs(req, res) {
    try {
      const { retentionDays = 7 } = req.body;

      const now = new Date();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(retentionDays));

      // 1. Limpiar logs detallados de documentos con fecha de expiración pasada
      const expiredResult = await WorkerLog.updateMany(
        {
          'logsRetention.detailedLogsExpireAt': { $lt: now },
          'detailedLogs.0': { $exists: true }
        },
        {
          $set: {
            detailedLogs: [],
            'logsRetention.keepDetailedLogs': false
          }
        }
      );

      // 2. Limpiar logs detallados de documentos antiguos sin fecha de expiración configurada
      const oldLogsResult = await WorkerLog.updateMany(
        {
          startTime: { $lt: cutoffDate },
          'logsRetention.detailedLogsExpireAt': { $exists: false },
          'detailedLogs.0': { $exists: true }
        },
        {
          $set: {
            detailedLogs: [],
            'logsRetention.keepDetailedLogs': false
          }
        }
      );

      res.json({
        success: true,
        cleanedAt: now,
        retentionDays: parseInt(retentionDays),
        cutoffDate,
        expiredLogsCleared: expiredResult.modifiedCount,
        oldLogsCleared: oldLogsResult.modifiedCount,
        totalCleared: expiredResult.modifiedCount + oldLogsResult.modifiedCount
      });
    } catch (error) {
      logger.error('Error limpiando logs expirados:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /worker-logs/count
   * Obtiene conteo de logs por tipo
   */
  async getCount(req, res) {
    try {
      const counts = await WorkerLog.aggregate([
        {
          $group: {
            _id: "$workerType",
            total: { $sum: 1 }
          }
        },
        { $sort: { total: -1 } }
      ]);

      const totalCount = counts.reduce((sum, c) => sum + c.total, 0);

      res.json({
        success: true,
        total: totalCount,
        byType: counts.reduce((acc, c) => {
          acc[c._id] = c.total;
          return acc;
        }, {})
      });
    } catch (error) {
      logger.error('Error obteniendo conteo:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
};

module.exports = workerLogController;
