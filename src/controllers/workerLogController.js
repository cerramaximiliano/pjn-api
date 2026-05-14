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
   * - hasMovimientos: true = solo con movimientos, false = solo sin movimientos
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
        sort = '-startTime',
        hasMovimientos
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

      // Filtrar por movimientos
      if (hasMovimientos === 'true' || hasMovimientos === '1') {
        query['changes.movimientosAdded'] = { $gt: 0 };
      } else if (hasMovimientos === 'false' || hasMovimientos === '0') {
        query.$or = [
          { 'changes.movimientosAdded': { $exists: false } },
          { 'changes.movimientosAdded': 0 },
          { 'changes.movimientosAdded': null }
        ];
      }

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

      // Top errorTypes en la ventana — alimenta el pie chart de "Tipo de error"
      const byErrorTypeMatch = { ...matchStage, 'result.errorType': { $exists: true, $ne: null } };
      const byErrorType = await WorkerLog.aggregate([
        { $match: byErrorTypeMatch },
        { $group: { _id: '$result.errorType', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);

      res.json({
        success: true,
        period: `${hours} horas`,
        periodStart: since,
        periodEnd: new Date(),
        summary,
        byWorkerType: stats,
        byErrorType: byErrorType.map(r => ({ errorType: r._id, count: r.count }))
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
   * Obtiene logs fallidos con análisis de patrones de error.
   *
   * IMPORTANTE: el agrupamiento se hace en Mongo sobre TODO el período, no sobre
   * los primeros N logs. Antes este endpoint perdía patrones del tail cuando un
   * tipo de error dominaba (ej: 300+ captcha errors enmascaraban 2
   * scraping_zero_movements del mismo día).
   *
   * Query params:
   * - workerType, fuero: filtros opcionales
   * - hours: ventana (default 24)
   * - limit: cantidad de logs en el tail (default 100, no afecta patterns)
   */
  async getFailed(req, res) {
    try {
      const { workerType, fuero, hours = 24, limit = 100 } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      // Considera "fallido" todo lo que tenga status failed/error O que tenga errorType
      // clasificado (capta partial+errorType como insufficient_balance/not_accessible).
      const query = {
        startTime: { $gte: since },
        $or: [
          { status: { $in: ['failed', 'error'] } },
          { 'result.errorType': { $exists: true, $ne: null } }
        ]
      };

      if (workerType) query.workerType = workerType;
      if (fuero) query['document.fuero'] = fuero;

      // Agrupar TODOS los logs del período por errorType (o mensaje truncado si
      // no hay errorType — logs legacy). Cada pattern trae 3 ejemplos con
      // documento+log_id para que el admin pueda hacer deep-link.
      const patternAggregation = await WorkerLog.aggregate([
        { $match: query },
        { $sort: { startTime: -1 } },
        {
          $group: {
            _id: {
              $ifNull: [
                '$result.errorType',
                {
                  $substrCP: [
                    {
                      $ifNull: [
                        '$result.error.message',
                        { $ifNull: ['$result.message', 'Error desconocido'] }
                      ]
                    },
                    0,
                    100
                  ]
                }
              ]
            },
            count: { $sum: 1 },
            lastOccurrence: { $max: '$startTime' },
            workers: { $addToSet: '$workerId' },
            examples: {
              $push: {
                logId: '$_id',
                workerId: '$workerId',
                documentId: '$document.documentId',
                number: '$document.number',
                year: '$document.year',
                fuero: '$document.fuero',
                startTime: '$startTime',
                status: '$status'
              }
            }
          }
        },
        { $sort: { count: -1 } }
      ]);

      // Recortamos examples a 3 por pattern (más liviano para la UI sin perder
      // representatividad). Como ordenamos por startTime desc antes del group,
      // los 3 que sobreviven son los más recientes.
      const errorPatterns = {};
      patternAggregation.forEach(p => {
        errorPatterns[p._id] = {
          count: p.count,
          lastOccurrence: p.lastOccurrence,
          workers: p.workers,
          examples: p.examples.slice(0, 3)
        };
      });

      // Tail con los logs más recientes para la tabla "Logs Fallidos".
      const logs = await WorkerLog.find(query)
        .sort({ startTime: -1 })
        .limit(parseInt(limit))
        .lean();

      res.json({
        success: true,
        total: logs.length,
        totalInPeriod: patternAggregation.reduce((s, p) => s + p.count, 0),
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
   * GET /worker-logs/error-breakdown
   * Devuelve la distribución de errores por errorType (para pie chart) y los top patrones
   * de mensaje cuando el log no tiene errorType clasificado.
   *
   * Query params:
   * - workerType: filtrar por tipo de worker (default: todos)
   * - hours: ventana temporal (default: 24)
   * - fuero: filtrar por fuero (CIV, CSS, CNT, COM, etc.)
   */
  async getErrorBreakdown(req, res) {
    try {
      const { workerType, hours = 24, fuero } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      // Considera "problemático" todo lo que no haya sido un success limpio:
      // failed, error (legacy) y partial con errorType clasificado.
      const matchStage = {
        startTime: { $gte: since },
        $or: [
          { status: { $in: ['failed', 'error'] } },
          { 'result.errorType': { $exists: true, $ne: null } }
        ]
      };
      if (workerType) matchStage.workerType = workerType;
      if (fuero) matchStage['document.fuero'] = fuero;

      const [byErrorType, totalProblems, byStatus] = await Promise.all([
        WorkerLog.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: { $ifNull: ['$result.errorType', 'unclassified'] },
              count: { $sum: 1 },
              lastOccurrence: { $max: '$startTime' },
              sampleMessage: { $first: '$result.message' },
              sampleErrorMessage: { $first: '$result.error.message' }
            }
          },
          { $sort: { count: -1 } }
        ]),
        WorkerLog.countDocuments(matchStage),
        WorkerLog.aggregate([
          { $match: matchStage },
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ])
      ]);

      // Patrones de los logs sin errorType (legacy / no clasificados): agrupamos por
      // los primeros 100 chars del mensaje para que se note qué falta clasificar.
      const unclassifiedMatch = {
        ...matchStage,
        $or: [
          { 'result.errorType': { $exists: false } },
          { 'result.errorType': null }
        ]
      };
      const unclassifiedPatterns = await WorkerLog.aggregate([
        { $match: unclassifiedMatch },
        {
          $group: {
            _id: {
              $substrCP: [
                { $ifNull: ['$result.error.message', { $ifNull: ['$result.message', 'desconocido'] }] },
                0,
                100
              ]
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]);

      res.json({
        success: true,
        period: `${hours} horas`,
        periodStart: since,
        periodEnd: new Date(),
        filters: { workerType: workerType || null, fuero: fuero || null },
        total: totalProblems,
        byErrorType: byErrorType.map(r => ({
          errorType: r._id,
          count: r.count,
          percentage: totalProblems > 0
            ? parseFloat(((r.count / totalProblems) * 100).toFixed(1))
            : 0,
          lastOccurrence: r.lastOccurrence,
          sample: r.sampleErrorMessage || r.sampleMessage || null
        })),
        byStatus: byStatus.map(s => ({ status: s._id, count: s.count })),
        unclassifiedPatterns: unclassifiedPatterns.map(p => ({ message: p._id, count: p.count }))
      });
    } catch (error) {
      logger.error('Error obteniendo breakdown de errores:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * GET /worker-logs/error-timeline
   * Devuelve la evolución temporal de errores agrupados por errorType.
   * Granularidad automática: hora si la ventana es ≤48h, día en caso contrario
   * (configurable con ?bucket=hour|day).
   *
   * Sirve para detectar patrones temporales: ej. "los captcha errors se
   * concentran entre 8am y 11am todos los días".
   *
   * Query params:
   * - workerType, fuero: filtros opcionales
   * - hours: ventana (default 24)
   * - bucket: 'hour' | 'day' | 'auto' (default 'auto')
   */
  async getErrorTimeline(req, res) {
    try {
      const { workerType, fuero, hours = 24, bucket = 'auto' } = req.query;

      const since = new Date();
      since.setHours(since.getHours() - parseInt(hours));

      const granularity = bucket === 'auto'
        ? (parseInt(hours) <= 48 ? 'hour' : 'day')
        : bucket;

      const dateFormat = granularity === 'hour'
        ? '%Y-%m-%dT%H:00:00Z'
        : '%Y-%m-%dT00:00:00Z';

      const matchStage = {
        startTime: { $gte: since },
        $or: [
          { status: { $in: ['failed', 'error'] } },
          { 'result.errorType': { $exists: true, $ne: null } }
        ]
      };
      if (workerType) matchStage.workerType = workerType;
      if (fuero) matchStage['document.fuero'] = fuero;

      const rows = await WorkerLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: {
              bucket: { $dateToString: { format: dateFormat, date: '$startTime', timezone: 'UTC' } },
              errorType: { $ifNull: ['$result.errorType', 'unclassified'] }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.bucket': 1 } }
      ]);

      // Pivot a filas wide para que el frontend pueda renderizar barras
      // apiladas sin tener que pivotear en JS. Cada fila = 1 bucket con
      // todos los errorTypes como propiedades.
      const buckets = {};
      const errorTypesSet = new Set();
      rows.forEach(r => {
        const b = r._id.bucket;
        const et = r._id.errorType;
        if (!buckets[b]) buckets[b] = { bucket: b };
        buckets[b][et] = r.count;
        errorTypesSet.add(et);
      });

      // Ordenar y rellenar errorTypes faltantes con 0 para que recharts no
      // tenga gaps visuales en el stack.
      const errorTypes = Array.from(errorTypesSet);
      const series = Object.values(buckets)
        .sort((a, b) => a.bucket.localeCompare(b.bucket))
        .map(row => {
          errorTypes.forEach(et => {
            if (row[et] === undefined) row[et] = 0;
          });
          return row;
        });

      res.json({
        success: true,
        period: `${hours} horas`,
        periodStart: since,
        periodEnd: new Date(),
        granularity,
        errorTypes,
        series
      });
    } catch (error) {
      logger.error('Error obteniendo timeline de errores:', error);
      res.status(500).json({ success: false, error: error.message });
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
