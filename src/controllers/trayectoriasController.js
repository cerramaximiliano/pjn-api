/**
 * trayectoriasController.js — Endpoint admin (read-only) para visualizar la
 * TRAYECTORIA judicial de las causas PJN (timeline de organismos por los que pasó
 * el expediente). Consumido por la vista /admin/causas/trayectorias del panel.
 */
const pjn = require("pjn-models");
const { logger } = require("../config/pino");

// Mapa fuero → modelo (solo los que existen en pjn-models).
const FUERO_MODELS = {};
for (const [k, v] of Object.entries(pjn)) {
  if (!k.startsWith("Causas") || !v || !v.schema || !v.schema.path("trayectoria")) continue;
  // Derivar el código de fuero desde el nombre del modelo.
  const map = { CausasCivil: "CIV", CausasComercial: "COM", CausasSegSoc: "CSS", CausasTrabajo: "CNT" };
  const code = map[k] || k.replace(/^Causas/, "").toUpperCase();
  FUERO_MODELS[code] = v;
}

// Campos que se devuelven en la lista (incluye la trayectoria completa).
const SELECT = "number year fuero caratula juzgado secretaria sala vocalia tipoOrganizacion organizacionTextoCompleto movimientosCount folderIds lastUpdate trayectoria";

/**
 * GET /api/admin/trayectorias?fuero=CIV&page=1&limit=25
 * Lista causas con trayectoria poblada, paginadas y filtrables por fuero.
 */
async function listCausasWithTrayectoria(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const fueroFiltro = req.query.fuero && req.query.fuero !== "todos" ? String(req.query.fuero).toUpperCase() : null;

    const fueros = fueroFiltro ? [fueroFiltro] : Object.keys(FUERO_MODELS);
    const filter = { trayectoria: { $exists: true, $ne: [] } };

    // Conteo total por fuero (en paralelo).
    const counts = await Promise.all(
      fueros.map((f) => (FUERO_MODELS[f] ? FUERO_MODELS[f].countDocuments(filter) : Promise.resolve(0)))
    );
    const total = counts.reduce((a, b) => a + b, 0);

    // Traer todas las que matchean (dataset chico) + ordenar por lastUpdate desc + paginar en memoria.
    const all = (
      await Promise.all(
        fueros.map(async (f) => {
          const M = FUERO_MODELS[f];
          if (!M) return [];
          const docs = await M.find(filter).select(SELECT).lean();
          return docs.map((d) => ({ ...d, fuero: d.fuero || f }));
        })
      )
    ).flat();

    all.sort((a, b) => new Date(b.lastUpdate || 0) - new Date(a.lastUpdate || 0));
    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit).map((d) => ({
      _id: d._id,
      number: d.number,
      year: d.year,
      fuero: d.fuero,
      caratula: d.caratula,
      juzgado: d.juzgado,
      secretaria: d.secretaria,
      sala: d.sala,
      vocalia: d.vocalia,
      tipoOrganizacion: d.tipoOrganizacion,
      organizacionTextoCompleto: d.organizacionTextoCompleto,
      movimientosCount: d.movimientosCount,
      foldersCount: Array.isArray(d.folderIds) ? d.folderIds.length : 0,
      lastUpdate: d.lastUpdate,
      tramos: Array.isArray(d.trayectoria) ? d.trayectoria.length : 0,
      trayectoria: d.trayectoria || [],
    }));

    res.json({
      success: true,
      count: total,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit) || 1,
        limit,
        hasNextPage: start + limit < total,
        hasPrevPage: page > 1,
      },
      data,
    });
  } catch (error) {
    logger.error(`Error listCausasWithTrayectoria: ${error.message}`);
    res.status(500).json({ success: false, message: "Error interno del servidor", error: error.message });
  }
}

/**
 * GET /api/admin/trayectorias/stats — resumen por fuero (para el header de la vista).
 */
async function trayectoriaStats(req, res) {
  try {
    const filter = { trayectoria: { $exists: true, $ne: [] } };
    const byFuero = {};
    let total = 0;
    await Promise.all(
      Object.entries(FUERO_MODELS).map(async ([f, M]) => {
        const n = await M.countDocuments(filter);
        if (n > 0) { byFuero[f] = n; total += n; }
      })
    );
    res.json({ success: true, total, byFuero });
  } catch (error) {
    logger.error(`Error trayectoriaStats: ${error.message}`);
    res.status(500).json({ success: false, message: "Error interno del servidor", error: error.message });
  }
}

module.exports = { listCausasWithTrayectoria, trayectoriaStats };
