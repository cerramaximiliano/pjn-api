const ConfiguracionScrapingHistory = require('../models/configuracionScrapingHistory');
const {
  ConfiguracionScraping,
  CausasCivil, CausasComercial, CausasSegSoc, CausasTrabajo, CausasCCF, CausasCAF
} = require('pjn-models');
const { logger } = require('../config/pino');

// Colección de causas por fuero. El scraper deja UN DOCUMENTO POR CADA NÚMERO
// INTENTADO —con `isValid` marcando si el expediente existe—, así que la
// presencia del documento es el registro exacto de qué se barrió. Es una fuente
// mucho más fiel que el historial de rangos, que solo se escribe cuando un
// worker se reasigna: un worker que barrió y quedó parado no deja rastro ahí.
const MODELO_POR_FUERO = {
  CIV: CausasCivil, COM: CausasComercial, CSS: CausasSegSoc,
  CNT: CausasTrabajo, CCF: CausasCCF, CAF: CausasCAF,
};

// Tope duro de numeración por año. Ningún fuero se acerca —el máximo observado
// es CIV con ~113.000— pero acota el escaneo y evita que un dato corrupto
// dispare una consulta enorme.
const TOPE_NUMERO = 150000;

// Un hueco menor a esto es ruido (números sueltos que fallaron y quedaron para
// el retry-worker), no un tramo sin barrer.
const HUECO_MINIMO = 50;

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


/**
 * Estado de un worker respecto de su rango. La vista de cobertura necesita
 * distinguir "el período está cerrado" de "hay un worker asignado pero
 * detenido": son colores distintos y acciones distintas, y hasta ahora las dos
 * situaciones se veían igual.
 */
function estadoDeWorker(w) {
  const termino = w.number >= w.range_end;
  if (w.enabled) return termino ? 'terminando' : 'en_curso';
  if (termino && w.completionEmailSent) return 'cerrado';
  if (termino) return 'cerrado_sin_mail';
  return 'detenido';
}

/**
 * Cobertura REAL de un fuero/año, medida sobre las causas y no sobre el
 * historial de rangos.
 *
 * Devuelve además la FRONTERA: el último bloque de 1.000 con al menos 5
 * expedientes válidos. Más allá de eso el portal no tiene nada y barrer es
 * gasto puro — medido: CNT 2021 se barrió hasta 172.600 con cero válidas
 * después de 55.000.
 */
async function coberturaReal(fuero, year, tope) {
  const Model = MODELO_POR_FUERO[fuero];
  if (!Model) return null;

  const filtroBase = {
    $or: [{ year: Number(year) }, { year: String(year) }],
    number: { $gte: 1, $lte: tope },
    // Excluye las causas cargadas por usuarios (`cache`/`app`): existen sin que
    // nadie las haya barrido y simularían cobertura donde no la hay.
    source: 'scraping',
  };

  // Una sola pasada agregada, resuelta íntegramente en Mongo: deduplica por
  // número (un expediente con incidentes tiene varios documentos) y agrupa en
  // bloques de 1.000 contando números distintos y válidos.
  //
  // La versión anterior traía los ~84.000 documentos a Node para marcarlos en
  // un array: 26 segundos para CIV 2022, por encima del timeout del panel. Acá
  // solo viajan ~150 filas y después se escanean en detalle únicamente los
  // bloques que no están completos, que son pocos.
  const BLOQUE = 1000;
  const bloques = await Model.aggregate([
    { $match: filtroBase },
    { $group: { _id: '$number', v: { $max: { $cond: ['$isValid', 1, 0] } } } },
    {
      $group: {
        _id: { $floor: { $divide: [{ $subtract: ['$_id', 1] }, BLOQUE] } },
        distintos: { $sum: 1 },
        validas: { $sum: '$v' },
      },
    },
    { $sort: { _id: 1 } },
  ]).allowDiskUse(true);

  if (!bloques.length) {
    return {
      barridos: 0, validas: 0, frontera: 0, coveredRanges: [],
      gaps: [{ start: 1, end: tope, size: tope }], sueltos: 0, topeBarrido: 0,
    };
  }

  let frontera = 0;
  let barridos = 0;
  let validas = 0;
  const porBloque = new Map();
  for (const b of bloques) {
    porBloque.set(b._id, b);
    barridos += b.distintos;
    validas += b.validas;
    if (b.validas >= 5) frontera = (b._id + 1) * BLOQUE;
  }

  const ultimoBloque = bloques[bloques.length - 1]._id;
  const vistos = new Uint8Array(tope + 2);

  // Bloques completos: se dan por cubiertos sin tocar un documento.
  const parciales = [];
  for (let b = 0; b <= ultimoBloque; b++) {
    const info = porBloque.get(b);
    const desde = b * BLOQUE + 1;
    const hasta = Math.min((b + 1) * BLOQUE, tope);
    const capacidad = hasta - desde + 1;
    if (info && info.distintos >= capacidad) {
      vistos.fill(1, desde, hasta + 1);
    } else if (info) {
      parciales.push({ desde, hasta });
    }
    // Sin `info` el bloque está entero sin barrer: se deja en 0.
  }

  // Solo los bloques incompletos se resuelven número por número.
  if (parciales.length) {
    const cursor = Model.find(
      { ...filtroBase, $and: [{ $or: parciales.map(r => ({ number: { $gte: r.desde, $lte: r.hasta } })) }] },
      { number: 1, _id: 0 }
    ).lean().cursor({ batchSize: 5000 });
    for (let d = await cursor.next(); d != null; d = await cursor.next()) {
      if (d.number >= 1 && d.number <= tope) vistos[d.number] = 1;
    }
  }

  const coveredRanges = [];
  const gaps = [];
  let sueltos = 0;
  let inicioHueco = null;
  let inicioTramo = null;
  let topeBarrido = 0;

  for (let i = 1; i <= tope + 1; i++) {
    const hay = i <= tope && vistos[i] === 1;
    if (hay) {
      topeBarrido = i;
      if (inicioTramo === null) inicioTramo = i;
      if (inicioHueco !== null) {
        const size = i - inicioHueco;
        if (size >= HUECO_MINIMO) gaps.push({ start: inicioHueco, end: i - 1, size });
        else sueltos += size;
        inicioHueco = null;
      }
    } else {
      if (inicioTramo !== null) {
        coveredRanges.push({ start: inicioTramo, end: i - 1 });
        inicioTramo = null;
      }
      if (inicioHueco === null) inicioHueco = i;
    }
  }
  if (inicioHueco !== null && inicioHueco <= tope) {
    gaps.push({ start: inicioHueco, end: tope, size: tope - inicioHueco + 1 });
  }

  return { barridos, validas, frontera, coveredRanges, gaps, sueltos, topeBarrido };
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

      // Todos los workers del fuero/año, encendidos o no. Antes se filtraba por
      // `enabled: true` y eso hacía que un rango ocupado por un worker apagado
      // se mostrara como libre — pero la validación de solapamiento de
      // updateRange NO mira `enabled`, así que al intentar asignarlo el backend
      // lo rechazaba. La vista y la validación tienen que ver lo mismo.
      const activeWorkers = await ConfiguracionScraping.find(
        { fuero, year: Number(year), isTemporary: { $ne: true } },
        { worker_id: 1, range_start: 1, range_end: 1, number: 1, max_number: 1, enabled: 1, completionEmailSent: 1 }
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
          workerId: assignedWorker?.worker_id || null,
          // `assigned` solo dice que el rango está ocupado. `estado` dice si hay
          // alguien trabajándolo o si quedó un worker detenido a mitad de camino.
          estado: assignedWorker ? estadoDeWorker(assignedWorker) : 'libre'
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
            max_number: w.max_number,
            enabled: !!w.enabled,
            estado: estadoDeWorker(w)
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

  /**
   * Cobertura medida sobre los datos reales, no sobre el historial de rangos.
   * Complementa a getCoverageByFueroAndYear, que sigue sirviendo para saber qué
   * rangos se dieron por cerrados administrativamente.
   */
  async getRealCoverageByFueroAndYear(req, res) {
    try {
      const { fuero, year } = req.params;
      const { maxRange } = req.query;

      if (!MODELO_POR_FUERO[fuero]) {
        return res.status(400).json({
          success: false,
          message: `Fuero sin colección de causas: ${fuero}. Válidos: ${Object.keys(MODELO_POR_FUERO).join(', ')}`,
          data: null
        });
      }

      const tope = Math.min(Number(maxRange) || TOPE_NUMERO, TOPE_NUMERO);
      const inicio = Date.now();
      const real = await coberturaReal(fuero, year, tope);

      const workers = await ConfiguracionScraping.find(
        { fuero, year: Number(year), isTemporary: { $ne: true } },
        { worker_id: 1, range_start: 1, range_end: 1, number: 1, enabled: 1, completionEmailSent: 1 }
      ).lean();

      const gaps = real.gaps.map(gap => {
        const w = workers.find(x => x.range_start <= gap.end && x.range_end >= gap.start);
        return {
          ...gap,
          assigned: !!w,
          workerId: w?.worker_id || null,
          estado: w ? estadoDeWorker(w) : 'libre',
          // Un hueco más allá de la frontera no tiene expedientes que encontrar:
          // asignarle un worker es quemar tiempo. La UI lo puede atenuar.
          masAllaDeFrontera: real.frontera > 0 && gap.start > real.frontera
        };
      });

      // Objetivo sugerido: hasta la frontera observada más un margen, para
      // confirmar que el año efectivamente terminó. Nunca el tope duro.
      const objetivo = real.frontera > 0 ? Math.min(tope, real.frontera + 15000) : Math.min(tope, 20000);
      const faltanHastaObjetivo = gaps
        .filter(g => g.start <= objetivo)
        .reduce((a, g) => a + (Math.min(g.end, objetivo) - g.start + 1), 0);

      logger.info(
        `[coberturaReal] fuero=${fuero} year=${year} tope=${tope} barridos=${real.barridos} ` +
        `frontera=${real.frontera} huecos=${gaps.length} ms=${Date.now() - inicio}`
      );

      res.json({
        success: true,
        message: 'Cobertura real calculada exitosamente',
        data: {
          fuero,
          year: String(year),
          maxRange: tope,
          // Cuántos números se intentaron y cuántos resultaron ser expedientes.
          barridos: real.barridos,
          validas: real.validas,
          densidad: real.barridos ? Number((real.validas / real.barridos * 100).toFixed(1)) : 0,
          // Último bloque de 1.000 con >=5 válidas: dónde termina el año de verdad.
          frontera: real.frontera,
          topeBarrido: real.topeBarrido,
          objetivo,
          faltanHastaObjetivo,
          coveragePercent: tope > 0 ? Math.round((real.barridos / tope) * 100) : 0,
          coveredRanges: real.coveredRanges,
          totalCovered: real.barridos,
          // Números sueltos sin barrer, por debajo del umbral de hueco: son
          // territorio del retry-worker, no de un worker de rango.
          sueltos: real.sueltos,
          gaps,
          workers: workers.map(w => ({
            worker_id: w.worker_id,
            range_start: w.range_start,
            range_end: w.range_end,
            current: w.number,
            enabled: !!w.enabled,
            estado: estadoDeWorker(w)
          }))
        }
      });
    } catch (error) {
      logger.error(`Error calculando cobertura real: ${error}`);
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