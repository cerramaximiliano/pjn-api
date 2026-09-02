const mongoose = require('mongoose');
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

// Los 15 distritos de la justicia federal del interior más las casaciones se
// resuelven por nombre: sus modelos existen en pjn-models pero traerlos todos
// arriba engordaría el require sin necesidad, porque la matriz solo los toca
// cuando hay configuraciones de scraping para ellos.
function modeloDeFuero(fuero) {
  if (MODELO_POR_FUERO[fuero]) return MODELO_POR_FUERO[fuero];
  try {
    return require('pjn-models')[`Causas${fuero}`] || null;
  } catch (_) {
    return null;
  }
}

// Tope duro de numeración por año. Ningún fuero se acerca —el máximo observado
// es CIV con ~113.000— pero acota el escaneo y evita que un dato corrupto
// dispare una consulta enorme.
const TOPE_NUMERO = 150000;

// Un hueco menor a esto es ruido (números sueltos que fallaron y quedaron para
// el retry-worker), no un tramo sin barrer.
const HUECO_MINIMO = 50;

// La matriz se sirve desde un snapshot, no se calcula en cada request. El
// cálculo recorre cientos de miles de entradas de índice: 20 s para CIV en
// worker01 y más de 200 s en el hub, que lee una réplica remota. Eso hacía que
// la vista mostrara "Error al calcular" en los cuatro fueros grandes.
//
// La foto envejece lento —la flota avanza ~850 números por hora sobre millones
// ya barridos— así que unos minutos de desfasaje no cambian ninguna decisión.
const CACHE_COLECCION = 'cobertura-matriz-cache';
const CACHE_FRESCO_MS = 15 * 60 * 1000;

// Recálculos en curso, para no disparar dos del mismo fuero a la vez.
const recalculando = new Set();

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

/**
 * Calcula la matriz de un fuero. Cara: recorre el índice `cobertura_matriz`
 * entero del fuero. La llaman el handler (cuando no hay snapshot) y el
 * refresco en segundo plano, nunca el camino normal de la vista.
 */
async function calcularMatriz(fuero, { maxRange, desde, hasta } = {}) {
  const Model = modeloDeFuero(fuero);
  const tope = Math.min(Number(maxRange) || TOPE_NUMERO, TOPE_NUMERO);
  const anioDesde = Number(desde) || 2018;
  const anioHasta = Number(hasta) || new Date().getFullYear();
  const inicio = Date.now();

  const bloques = await Model.aggregate([
    { $match: { number: { $gte: 1, $lte: tope }, source: 'scraping' } },
    {
      $group: {
        _id: { y: '$year', b: { $floor: { $divide: [{ $subtract: ['$number', 1] }, 1000] } } },
        distintos: { $sum: 1 },
        validas: { $sum: { $cond: ['$isValid', 1, 0] } },
      },
    },
  ]).allowDiskUse(true);

  // Un año puede venir como Number o String según la colección.
  const porAnio = new Map();
  for (const b of bloques) {
    const y = Number(b._id.y);
    if (!Number.isFinite(y) || y < anioDesde || y > anioHasta) continue;
    if (!porAnio.has(y)) porAnio.set(y, { barridos: 0, validas: 0, frontera: 0, topeBloque: 0 });
    const a = porAnio.get(y);
    a.barridos += b.distintos;
    a.validas += b.validas;
    const finBloque = (b._id.b + 1) * 1000;
    if (b.validas >= 5 && finBloque > a.frontera) a.frontera = finBloque;
    if (finBloque > a.topeBloque) a.topeBloque = finBloque;
  }

  const workers = await ConfiguracionScraping.find(
    { fuero, isTemporary: { $ne: true } },
    { worker_id: 1, year: 1, range_start: 1, range_end: 1, number: 1, enabled: 1, completionEmailSent: 1 }
  ).lean();

  const anios = [];
  for (let y = anioDesde; y <= anioHasta; y++) {
    const a = porAnio.get(y) || { barridos: 0, validas: 0, frontera: 0, topeBloque: 0 };
    const ws = workers.filter((x) => Number(x.year) === y).map((x) => ({
      worker_id: x.worker_id,
      range_start: x.range_start,
      range_end: x.range_end,
      current: x.number,
      enabled: !!x.enabled,
      estado: estadoDeWorker(x),
      // Cuánto le queda a este worker dentro de su rango.
      restante: Math.max(0, x.range_end - x.number + 1),
    }));

    // Objetivo: frontera más el margen de confirmación. Un año sin barrer
    // arranca en 20.000 provisorios hasta saber de qué tamaño es.
    const objetivo = a.frontera > 0 ? Math.min(tope, a.frontera + 15000) : Math.min(tope, 20000);
    // Cobertura aproximada dentro del objetivo. El conteo exacto de huecos
    // vive en /coverage-real; acá alcanza con la proporción.
    const faltanAprox = Math.max(0, objetivo - a.barridos);

    const activos = ws.filter((x) => x.enabled).length;
    const detenidos = ws.filter((x) => x.estado === 'detenido').length;
    let estado;
    if (a.barridos === 0 && !ws.length) estado = 'sin_tocar';
    else if (a.barridos === 0) estado = 'asignado_sin_datos';
    else if (faltanAprox <= 0) estado = 'cerrado';
    else if (activos > 0) estado = 'en_curso';
    else if (detenidos > 0) estado = 'detenido';
    else estado = 'sin_worker';

    anios.push({
      year: y,
      barridos: a.barridos,
      validas: a.validas,
      densidad: a.barridos ? Number((a.validas / a.barridos * 100).toFixed(1)) : 0,
      frontera: a.frontera,
      objetivo,
      faltanAprox,
      avancePct: objetivo > 0 ? Math.min(100, Math.round((a.barridos / objetivo) * 100)) : 0,
      estado,
      workersActivos: activos,
      workers: ws,
    });
  }

  return {
    fuero,
    maxRange: tope,
    desde: anioDesde,
    hasta: anioHasta,
    calculoMs: Date.now() - inicio,
    totales: {
      barridos: anios.reduce((a, x) => a + x.barridos, 0),
      validas: anios.reduce((a, x) => a + x.validas, 0),
      faltanAprox: anios.reduce((a, x) => a + x.faltanAprox, 0),
      workersActivos: anios.reduce((a, x) => a + x.workersActivos, 0),
    },
    anios,
  };
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

  /**
   * Matriz de cobertura de un fuero: todos sus años en una sola pasada.
   *
   * La vista anterior obligaba a elegir un fuero y pedía un año por request.
   * Con 21 fueros en producción eso son 189 llamadas y ninguna foto del
   * conjunto. Acá una única agregación por colección devuelve todos los años
   * agrupados en bloques de 1.000, que es lo que hace falta para el panorama:
   * cuánto se barrió, cuántos expedientes salieron y dónde está la frontera.
   *
   * El detalle fino de huecos sigue en /coverage-real, que se llama al abrir
   * una celda. Acá interesa la foto, no el tramo exacto.
   *
   * Se apoya en el índice `cobertura_matriz` {source, year, number, isValid}:
   * sin él el filtro por `source` fuerza un scan completo (107 s para los seis
   * fueros grandes; con índice, ~12 s).
   */
  /**
   * Matriz de cobertura de un fuero. Se sirve SIEMPRE del snapshot: el cálculo
   * es demasiado caro para una request (20 s para CIV en worker01, más de 200 s
   * en el hub, que lee una réplica remota) y hacía fallar la vista.
   *
   * Si el snapshot está viejo se dispara un recálculo en segundo plano y se
   * devuelve igual la foto anterior: una foto de hace unos minutos es infinitamente
   * más útil que un timeout. `?refresh=1` fuerza el recálculo sincrónico.
   */
  async getCoverageMatrix(req, res) {
    try {
      const { fuero } = req.params;
      const { maxRange, desde, hasta, refresh } = req.query;

      if (!modeloDeFuero(fuero)) {
        return res.status(400).json({
          success: false,
          message: `Fuero sin colección de causas: ${fuero}`,
          data: null
        });
      }

      const col = mongoose.connection.db.collection(CACHE_COLECCION);
      const snap = await col.findOne({ _id: fuero });
      const edadMs = snap ? Date.now() - new Date(snap.calculadoEn).getTime() : Infinity;

      if (snap && refresh !== '1') {
        // Fuera de fecha: se refresca por detrás y se contesta con lo que hay.
        if (edadMs > CACHE_FRESCO_MS && !recalculando.has(fuero)) {
          recalculando.add(fuero);
          calcularMatriz(fuero, { maxRange, desde, hasta })
            .then((d) => col.updateOne({ _id: fuero }, { $set: { calculadoEn: new Date(), data: d } }, { upsert: true }))
            .catch((e) => logger.error(`[coberturaMatriz] recálculo de ${fuero} falló: ${e.message}`))
            .finally(() => recalculando.delete(fuero));
        }
        return res.json({
          success: true,
          message: 'Matriz de cobertura (snapshot)',
          data: { ...snap.data, calculadoEn: snap.calculadoEn, edadMinutos: Math.round(edadMs / 60000), recalculando: recalculando.has(fuero) }
        });
      }

      // Sin snapshot todavía, o refresh explícito: se calcula y se guarda.
      const data = await calcularMatriz(fuero, { maxRange, desde, hasta });
      await col.updateOne({ _id: fuero }, { $set: { calculadoEn: new Date(), data } }, { upsert: true });
      res.json({
        success: true,
        message: 'Matriz de cobertura calculada',
        data: { ...data, calculadoEn: new Date(), edadMinutos: 0, recalculando: false }
      });
    } catch (error) {
      logger.error(`Error sirviendo la matriz de cobertura: ${error}`);
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