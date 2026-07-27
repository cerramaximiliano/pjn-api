/**
 * etapaStatsController — Estadísticas de etapas procesales para la vista admin
 * /admin/causas/etapa-stats y /admin/causas/etapas.
 *
 * Fuentes:
 *  - Colección `etapa-stats` (resúmenes materializados que el worker etapa-stats
 *    de pjn-workers-scraping computa en la Mongo local de worker_01 y replica a
 *    Atlas tras cada corrida): duración por fuero/objeto/juzgado/sala/etapa,
 *    matriz de transiciones y distribución de resultados. Sin modelo mongoose
 *    (raw collection, mismo patrón que failoverController).
 *  - Subdoc `etapaProcesal` embebido en cada causa (timeline con desde/hasta/
 *    días) para la vista por causa.
 */
const mongoose = require("mongoose");
const pjn = require("pjn-models");
const { logger } = require("../config/pino");

const MODELS = {
    CausasCivil: pjn.CausasCivil,
    CausasComercial: pjn.CausasComercial,
    CausasSegSoc: pjn.CausasSegSoc,
    CausasTrabajo: pjn.CausasTrabajo,
};

const FUERO_MODEL = { CIV: pjn.CausasCivil, COM: pjn.CausasComercial, CSS: pjn.CausasSegSoc, CNT: pjn.CausasTrabajo };

const TIPOS_VALIDOS = [
    "duracion-fuero-etapa",
    "duracion-objeto-etapa",
    "duracion-juzgado-etapa",
    "duracion-sala-etapa",
    "transicion",
    "resultado",
    "conformidad",
    "firma",
];

function statsCol() {
    return mongoose.connection.db.collection("etapa-stats");
}

// GET /api/admin/etapa-stats/resumen?tipo=duracion-fuero-etapa&fuero=CNT&objeto=&juzgado=&sala=&etapa=&limit=
exports.getResumen = async (req, res) => {
    try {
        const { tipo, fuero, objeto, juzgado, sala, etapa } = req.query;
        if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
            return res.status(400).json({ success: false, message: `tipo inválido. Válidos: ${TIPOS_VALIDOS.join(", ")}` });
        }
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
        const filter = { tipo };
        if (fuero) filter.fuero = fuero;
        if (objeto) filter.objeto = objeto;
        if (etapa) filter.etapa = etapa;
        if (juzgado !== undefined && juzgado !== "") filter.juzgado = parseInt(juzgado, 10);
        if (sala !== undefined && sala !== "") filter.sala = parseInt(sala, 10);

        const data = await statsCol().find(filter).sort({ n: -1 }).limit(limit).toArray();
        const watermark = await mongoose.connection.db
            .collection("etapa-stats-config")
            .findOne({ _id: "etapa-stats-watermark" })
            .catch(() => null);
        res.json({ success: true, count: data.length, updatedAt: data[0]?.updatedAt || null, watermark: watermark?.lastComputedAt || null, data });
    } catch (error) {
        logger.error(`[etapa-stats] getResumen: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /api/admin/etapa-stats/filtros?fuero=CNT
// Valores disponibles para los dropdowns del explorador, derivados de los
// propios resúmenes (solo aparecen dimensiones con datos).
exports.getFiltros = async (req, res) => {
    try {
        const { fuero } = req.query;
        const col = statsCol();
        const matchF = fuero ? { fuero } : {};
        const [fueros, etapas, objetos, juzgados, salas] = await Promise.all([
            col.distinct("fuero", { tipo: "duracion-fuero-etapa" }),
            col.distinct("etapa", { tipo: "duracion-fuero-etapa", ...matchF }),
            col.distinct("objeto", { tipo: "duracion-objeto-etapa", ...matchF }),
            col.distinct("juzgado", { tipo: "duracion-juzgado-etapa", ...matchF }),
            col.distinct("sala", { tipo: "duracion-sala-etapa", ...matchF }),
        ]);
        res.json({
            success: true,
            data: {
                fueros: fueros.sort(),
                etapas,
                objetos: objetos.filter(Boolean).sort(),
                juzgados: juzgados.filter((j) => j != null).sort((a, b) => a - b),
                salas: salas.filter((s) => s != null).sort((a, b) => a - b),
                etiquetas: Object.fromEntries(Object.entries(pjn.etapaProcesal.ETAPAS).map(([k, v]) => [k, v.label])),
            },
        });
    } catch (error) {
        logger.error(`[etapa-stats] getFiltros: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /api/admin/etapa-stats/causas?fuero=CNT&etapaActual=&fase=&search=&page=&limit=
// Lista paginada de causas con etapa computada (para la vista de timelines).
exports.getCausas = async (req, res) => {
    try {
        const fuero = req.query.fuero || "CNT";
        const Model = FUERO_MODEL[fuero];
        if (!Model) return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

        const filter = { "etapaProcesal.etapaActual": { $ne: null } };
        if (req.query.etapaActual) filter["etapaProcesal.etapaActual"] = req.query.etapaActual;
        if (req.query.fase) filter["etapaProcesal.fase"] = req.query.fase;
        if (req.query.search) filter.caratula = { $regex: String(req.query.search).slice(0, 60), $options: "i" };

        const projection = {
            caratula: 1, number: 1, year: 1, objeto: 1, fuero: 1, juzgado: 1, sala: 1,
            etapaProcesal: 1, movimientosCount: 1, fechaUltimoMovimiento: 1,
        };
        const [data, total] = await Promise.all([
            Model.find(filter, projection).sort({ "etapaProcesal.asOf": -1 }).skip((page - 1) * limit).limit(limit).lean(),
            Model.countDocuments(filter),
        ]);
        res.json({
            success: true,
            count: total,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                limit,
                hasNextPage: page * limit < total,
                hasPrevPage: page > 1,
            },
            data,
        });
    } catch (error) {
        logger.error(`[etapa-stats] getCausas: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /api/admin/etapa-stats/causa/:causaType/:id
// Contexto completo para el panel de una causa: timeline + comparativa
// (duraciones de referencia para su fuero/objeto/juzgado/sala) + proyección
// (transiciones desde su etapa actual).
exports.getCausaContext = async (req, res) => {
    try {
        const { causaType, id } = req.params;
        const Model = MODELS[causaType];
        if (!Model) return res.status(400).json({ success: false, message: `causaType inválido: ${causaType}` });

        const causa = await Model.findById(id, {
            caratula: 1, number: 1, year: 1, objeto: 1, fuero: 1, juzgado: 1, sala: 1,
            etapaProcesal: 1, movimientosCount: 1, fechaUltimoMovimiento: 1,
        }).lean();
        if (!causa) return res.status(404).json({ success: false, message: "Causa no encontrada" });

        const ep = causa.etapaProcesal || {};
        const col = statsCol();
        const fuero = causa.fuero;
        const [porEtapa, porObjeto, porJuzgado, porSala, transiciones, resultados] = await Promise.all([
            col.find({ tipo: "duracion-fuero-etapa", fuero }).toArray(),
            causa.objeto ? col.find({ tipo: "duracion-objeto-etapa", fuero, objeto: causa.objeto }).toArray() : [],
            causa.juzgado != null ? col.find({ tipo: "duracion-juzgado-etapa", fuero, juzgado: causa.juzgado }).toArray() : [],
            causa.sala != null ? col.find({ tipo: "duracion-sala-etapa", fuero, sala: causa.sala }).toArray() : [],
            ep.etapaActual ? col.find({ tipo: "transicion", fuero, etapa: ep.etapaActual }).sort({ n: -1 }).toArray() : [],
            causa.objeto ? col.find({ tipo: "resultado", fuero, objeto: causa.objeto }).sort({ n: -1 }).limit(10).toArray() : [],
        ]);

        res.json({
            success: true,
            data: {
                causa,
                etiquetas: Object.fromEntries(Object.entries(pjn.etapaProcesal.ETAPAS).map(([k, v]) => [k, v.label])),
                referencia: { porEtapa, porObjeto, porJuzgado, porSala },
                transiciones,
                resultados,
            },
        });
    } catch (error) {
        logger.error(`[etapa-stats] getCausaContext: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
};
