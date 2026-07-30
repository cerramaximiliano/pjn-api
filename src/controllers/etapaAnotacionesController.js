/**
 * etapaAnotacionesController — Herramienta de etiquetado experto para el
 * dataset del clasificador de etapas (Fase 2, repo pjn-etapa-model).
 *
 * Flujo: una cola de causas a revisar (pobladas por script o marcadas a mano
 * desde /admin/causas/verified) → editor de anotación por causa (todos los
 * movimientos + etiquetas débiles actuales + cuerpo segmentado de las
 * resoluciones capturadas) → el abogado anota dimensiones factorizadas por
 * movimiento → el generador de dataset (pjn-workers-scraping) lee la
 * colección `etapa-anotaciones` de esta MISMA Mongo local como gold set.
 *
 * Colección: `etapa-anotaciones` (raw, un doc por causa):
 *   { fuero, causaType, causaId, number, year, caratula, objeto, juzgado, sala,
 *     motivo, prioridad, estado: pendiente|en_progreso|anotada|verificada,
 *     anotaciones: { "<idxMovimiento>": { esResolucion, tipoResolucion,
 *        instancia, objetoResolucion, modoTerminacion, resultado, etiqueta,
 *        replicaDe, descartar, notas } },
 *     notasCausa, creadoPor, actualizadoPor, createdAt, updatedAt }
 *
 * Cuerpos: la instancia local de pjn-api corre contra la Mongo local
 * (NODE_ENV=local) pero los documentos extraídos viven en Atlas
 * (`sentencias-capturadas`) — se abre una conexión secundaria lazy con
 * process.env.URLDB. Si no está disponible, el editor funciona sin cuerpos.
 */
const mongoose = require("mongoose");
const pjn = require("pjn-models");
const { logger } = require("../config/pino");
const { segmentar } = require("../utils/segmentarResolucion");

const FUERO_MODEL = {
    CIV: { model: () => pjn.CausasCivil, causaType: "CausasCivil" },
    COM: { model: () => pjn.CausasComercial, causaType: "CausasComercial" },
    CSS: { model: () => pjn.CausasSegSoc, causaType: "CausasSegSoc" },
    CNT: { model: () => pjn.CausasTrabajo, causaType: "CausasTrabajo" },
    CAF: { model: () => pjn.CausasCAF, causaType: "CausasCAF" },
    CCF: { model: () => pjn.CausasCCF, causaType: "CausasCCF" },
};

const ESTADOS = ["pendiente", "en_progreso", "anotada", "verificada", "descartada"];

// Valores permitidos de las dimensiones factorizadas (revisión experta 2026-07-30).
const DIMENSIONES = {
    tipoResolucion: ["providencia", "interlocutoria", "definitiva", "no_resolucion"],
    instancia: ["primera", "segunda", "csjn"],
    objetoResolucion: ["fondo", "incidental", "honorarios", "ejecucion", "terminacion", "impulso"],
    modoTerminacion: ["firmeza", "allanamiento", "desistimiento", "conciliacion", "caducidad", "otro"],
    resultado: ["hace_lugar", "rechaza", "parcial", "confirma", "revoca", "desierto", "concede", "deniega", "homologa", "otro"],
};

function col() {
    return mongoose.connection.db.collection("etapa-anotaciones");
}

// ── Conexión secundaria a Atlas para cuerpos (lazy) ────────────────────────────
let atlasConn = null;
async function atlasDb() {
    const uri = process.env.URLDB;
    if (!uri || !/mongodb\+srv|mongodb.net/.test(uri)) {
        // La instancia hub ya corre contra Atlas: reusar la conexión principal.
        if (mongoose.connection.host && /mongodb.net/.test(mongoose.connection.host)) return mongoose.connection.db;
        return null;
    }
    if (mongoose.connection.client.s.url === uri) return mongoose.connection.db;
    if (!atlasConn) {
        atlasConn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 });
        await atlasConn.asPromise().catch((e) => {
            logger.warn(`etapa-anotaciones: sin conexión Atlas para cuerpos: ${e.message}`);
            atlasConn = null;
        });
    }
    return atlasConn ? atlasConn.db : null;
}

function dayKey(f) {
    const d = new Date(f);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── GET /api/admin/etapa-anotaciones ──────────────────────────────────────────
// Cola de revisión. Query: estado, fuero, motivo, page, limit.
exports.getCola = async (req, res) => {
    try {
        const { estado, fuero, motivo } = req.query;
        const page = Math.max(parseInt(req.query.page, 10) || 0, 0);
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const filter = {};
        if (estado && ESTADOS.includes(estado)) filter.estado = estado;
        if (fuero) filter.fuero = fuero;
        if (motivo) filter.motivo = motivo;

        const [items, total, porEstado] = await Promise.all([
            col().find(filter).sort({ prioridad: 1, createdAt: 1 })
                .skip(page * limit).limit(limit)
                .project({ anotaciones: 0 }).toArray(),
            col().countDocuments(filter),
            col().aggregate([{ $group: { _id: "$estado", n: { $sum: 1 } } }]).toArray(),
        ]);
        // Progreso de anotación por item (cantidad de movimientos anotados).
        const ids = items.map((i) => i._id);
        const conteos = await col().aggregate([
            { $match: { _id: { $in: ids } } },
            { $project: { n: { $size: { $objectToArray: { $ifNull: ["$anotaciones", {}] } } } } },
        ]).toArray();
        const nPorId = Object.fromEntries(conteos.map((c) => [c._id.toString(), c.n]));
        items.forEach((i) => { i.movimientosAnotados = nPorId[i._id.toString()] || 0; });

        res.json({
            success: true, items, total, page, limit,
            porEstado: Object.fromEntries(porEstado.map((e) => [e._id, e.n])),
            dimensiones: DIMENSIONES,
        });
    } catch (err) {
        logger.error(`etapa-anotaciones getCola: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/admin/etapa-anotaciones/membership?fuero=CNT&ids=a,b,c ───────────
// Para que la vista verified marque qué causas están en cola.
exports.getMembership = async (req, res) => {
    try {
        const { fuero } = req.query;
        const ids = (req.query.ids || "").split(",").filter(Boolean).slice(0, 200);
        if (!ids.length) return res.json({ success: true, membership: {} });
        const filter = { causaId: { $in: ids.map((x) => new mongoose.Types.ObjectId(x)) } };
        if (fuero) filter.fuero = fuero;
        const docs = await col().find(filter).project({ causaId: 1, estado: 1, motivo: 1 }).toArray();
        res.json({
            success: true,
            membership: Object.fromEntries(docs.map((d) => [d.causaId.toString(), { estado: d.estado, motivo: d.motivo }])),
        });
    } catch (err) {
        logger.error(`etapa-anotaciones membership: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/admin/etapa-anotaciones/causa/:fuero/:id ─────────────────────────
// Payload completo para el editor: causa + movimientos + etiquetas débiles +
// anotaciones existentes + cuerpos segmentados.
exports.getCausaParaAnotar = async (req, res) => {
    try {
        const { fuero, id } = req.params;
        const cfg = FUERO_MODEL[fuero];
        if (!cfg) return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });

        const causa = await cfg.model().findById(id)
            .select("number year caratula objeto juzgado sala fuero movimiento etapaProcesal movimientosCount")
            .lean();
        if (!causa) return res.status(404).json({ success: false, message: "causa no encontrada" });

        // Etiquetas débiles por día (timeline + hitos del motor).
        const ep = causa.etapaProcesal || {};
        const debilesPorDia = {};
        (ep.hitos || []).forEach((h) => { const k = h.fecha && dayKey(h.fecha); if (k) debilesPorDia[k] = "hito:" + h.tipo; });
        (ep.timeline || []).forEach((s) => { const k = s.desde && dayKey(s.desde); if (k) debilesPorDia[k] = s.etapa; });

        const movimientos = (causa.movimiento || []).map((m, idx) => ({
            idx,
            fecha: m.fecha, dia: dayKey(m.fecha),
            tipo: (m.tipo || "").trim(),
            detalle: (m.detalle || "").trim(),
            url: m.url || null,
            etiquetaDebil: debilesPorDia[dayKey(m.fecha)] || null,
        }));

        // Cuerpos capturados (Atlas) segmentados.
        let cuerpos = [];
        const db = await atlasDb().catch(() => null);
        if (db) {
            const docs = await db.collection("sentencias-capturadas")
                .find({ causaId: new mongoose.Types.ObjectId(id) })
                .project({ url: 1, movimientoFecha: 1, movimientoDetalle: 1, "processingResult.text": 1, "ocrResult.text": 1 })
                .toArray();
            cuerpos = docs.map((d) => {
                const texto = (d.processingResult && d.processingResult.text) || (d.ocrResult && d.ocrResult.text) || "";
                const seg = segmentar(texto.length > 20000 ? texto.slice(0, 2000) + texto.slice(-8000) : texto);
                return {
                    url: d.url, dia: dayKey(d.movimientoFecha), detalle: (d.movimientoDetalle || "").trim(),
                    caracteres: texto.length,
                    encabezado: seg.encabezado.slice(0, 400),
                    dispositiva: seg.dispositiva.slice(0, 2500),
                    tieneDispositiva: seg.tieneDispositiva,
                    colaTexto: seg.tieneDispositiva ? null : texto.slice(-1800),
                };
            });
        }

        const anotacionDoc = await col().findOne({ causaId: new mongoose.Types.ObjectId(id) });
        res.json({
            success: true,
            causa: {
                fuero, causaType: cfg.causaType, id,
                number: causa.number, year: causa.year, caratula: causa.caratula,
                objeto: causa.objeto, juzgado: causa.juzgado, sala: causa.sala,
                etapaActual: ep.etapaActual, familia: ep.familia,
                timeline: ep.timeline || [], hitos: ep.hitos || [],
            },
            movimientos, cuerpos,
            anotacion: anotacionDoc || null,
            dimensiones: DIMENSIONES,
            cuerposDisponibles: !!db,
        });
    } catch (err) {
        logger.error(`etapa-anotaciones getCausa: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /api/admin/etapa-anotaciones/causa/:fuero/:id ────────────────────────
// Alta en cola (desde la vista verified u otra). Idempotente.
exports.agregarACola = async (req, res) => {
    try {
        const { fuero, id } = req.params;
        const cfg = FUERO_MODEL[fuero];
        if (!cfg) return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });
        const causa = await cfg.model().findById(id).select("number year caratula objeto juzgado sala").lean();
        if (!causa) return res.status(404).json({ success: false, message: "causa no encontrada" });

        const ahora = new Date();
        const r = await col().updateOne(
            { causaId: new mongoose.Types.ObjectId(id) },
            {
                $setOnInsert: {
                    fuero, causaType: cfg.causaType, causaId: new mongoose.Types.ObjectId(id),
                    number: causa.number, year: causa.year, caratula: causa.caratula,
                    objeto: causa.objeto, juzgado: causa.juzgado, sala: causa.sala,
                    motivo: (req.body && req.body.motivo) || "manual",
                    prioridad: (req.body && req.body.prioridad) || 2,
                    estado: "pendiente", anotaciones: {}, notasCausa: "",
                    creadoPor: (req.user && (req.user.email || req.user.id)) || "admin",
                    createdAt: ahora, updatedAt: ahora,
                },
            },
            { upsert: true }
        );
        res.json({ success: true, creado: !!r.upsertedId });
    } catch (err) {
        logger.error(`etapa-anotaciones agregar: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── PUT /api/admin/etapa-anotaciones/causa/:fuero/:id ─────────────────────────
// Guarda anotaciones (merge por movimiento) + notas + estado.
exports.guardarAnotaciones = async (req, res) => {
    try {
        const { id } = req.params;
        const { anotaciones, notasCausa, estado } = req.body || {};
        const set = { updatedAt: new Date(), actualizadoPor: (req.user && (req.user.email || req.user.id)) || "admin" };
        if (req.body && req.body.limpiarTodo === true) set.anotaciones = {};
        if (typeof notasCausa === "string") set.notasCausa = notasCausa.slice(0, 5000);
        if (estado && ESTADOS.includes(estado)) set.estado = estado;
        if (anotaciones && typeof anotaciones === "object") {
            for (const [idx, a] of Object.entries(anotaciones)) {
                if (!/^\d+$/.test(idx)) continue;
                if (a === null) { set[`__unset_${idx}`] = true; continue; }
                const limpia = {};
                for (const dim of ["tipoResolucion", "instancia", "objetoResolucion", "modoTerminacion", "resultado"]) {
                    if (a[dim] === null) limpia[dim] = null;
                    else if (a[dim] && DIMENSIONES[dim].includes(a[dim])) limpia[dim] = a[dim];
                }
                if (typeof a.esResolucion === "boolean") limpia.esResolucion = a.esResolucion;
                if (typeof a.descartar === "boolean") limpia.descartar = a.descartar;
                if (typeof a.etiqueta === "string") limpia.etiqueta = a.etiqueta.slice(0, 80);
                if (a.replicaDe !== undefined) limpia.replicaDe = a.replicaDe === null ? null : parseInt(a.replicaDe, 10);
                if (typeof a.notas === "string") limpia.notas = a.notas.slice(0, 2000);
                set[`anotaciones.${idx}`] = limpia;
            }
        }
        const unset = {};
        for (const k of Object.keys(set)) {
            if (k.startsWith("__unset_")) { unset[`anotaciones.${k.slice(8)}`] = ""; delete set[k]; }
        }
        const update = { $set: set };
        if (Object.keys(unset).length) update.$unset = unset;
        const r = await col().updateOne({ causaId: new mongoose.Types.ObjectId(id) }, update);
        if (!r.matchedCount) return res.status(404).json({ success: false, message: "la causa no está en la cola — agregala primero" });
        res.json({ success: true });
    } catch (err) {
        logger.error(`etapa-anotaciones guardar: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/admin/etapa-anotaciones/cuerpo/:fuero/:id/:idx ───────────────────
// Cuerpo bajo demanda para un movimiento con URL del viewer (las URLs del PJN
// no caducan). Orden: cache local → sentencias-capturadas (Atlas) → descarga
// del PDF + pdf-parse. Cachea en `etapa-cuerpos-cache` (Mongo local).
const axios = require("axios");
const pdfParse = require("pdf-parse");

function cacheCol() {
    return mongoose.connection.db.collection("etapa-cuerpos-cache");
}

function armarRespuestaCuerpo(texto, fuente) {
    const seg = segmentar(texto.length > 20000 ? texto.slice(0, 2000) + texto.slice(-8000) : texto);
    return {
        fuente,
        caracteres: texto.length,
        encabezado: seg.encabezado.slice(0, 400),
        dispositiva: seg.dispositiva.slice(0, 2500),
        tieneDispositiva: seg.tieneDispositiva,
        colaTexto: seg.tieneDispositiva ? null : texto.slice(-1800),
    };
}

exports.getCuerpoOnDemand = async (req, res) => {
    try {
        const { fuero, id, idx } = req.params;
        const cfg = FUERO_MODEL[fuero];
        if (!cfg) return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });
        const causa = await cfg.model().findById(id).select("movimiento").lean();
        const mov = causa && causa.movimiento && causa.movimiento[parseInt(idx, 10)];
        if (!mov) return res.status(404).json({ success: false, message: "movimiento no encontrado" });
        if (!mov.url) return res.status(400).json({ success: false, message: "el movimiento no tiene documento asociado" });

        // 1. Cache local
        const cacheado = await cacheCol().findOne({ url: mov.url });
        if (cacheado) {
            return res.json({ success: true, cuerpo: armarRespuestaCuerpo(cacheado.texto, "cache") });
        }

        // 2. Ya capturado por el pipeline de sentencias (Atlas)
        const db = await atlasDb().catch(() => null);
        if (db) {
            const doc = await db.collection("sentencias-capturadas").findOne(
                { causaId: new mongoose.Types.ObjectId(id), url: mov.url },
                { projection: { "processingResult.text": 1, "ocrResult.text": 1 } }
            );
            const texto = doc && (((doc.processingResult || {}).text) || ((doc.ocrResult || {}).text));
            if (texto && texto.length > 200) {
                await cacheCol().updateOne({ url: mov.url }, { $set: { url: mov.url, texto, fuente: "sentencias-capturadas", createdAt: new Date() } }, { upsert: true });
                return res.json({ success: true, cuerpo: armarRespuestaCuerpo(texto, "sentencias-capturadas") });
            }
        }

        // 3. Descarga directa del viewer + pdf-parse
        const resp = await axios.get(mov.url, {
            responseType: "arraybuffer",
            timeout: 25000,
            headers: {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
                Accept: "application/pdf,*/*",
            },
            validateStatus: (s) => s >= 200 && s < 300,
        });
        const contentType = (resp.headers["content-type"] || "").toLowerCase();
        const buffer = Buffer.from(resp.data);
        if (!contentType.includes("pdf") || buffer.length < 500) {
            return res.status(422).json({ success: false, message: "el viewer no devolvió un PDF válido" });
        }
        const parsed = await pdfParse(buffer);
        const texto = (parsed.text || "").trim();
        if (texto.length < 100) {
            return res.status(422).json({ success: false, message: `documento escaneado o sin texto extraíble (${texto.length} caracteres — requiere OCR)`, escaneado: true });
        }
        await cacheCol().updateOne({ url: mov.url }, { $set: { url: mov.url, texto, fuente: "descarga", createdAt: new Date() } }, { upsert: true });
        res.json({ success: true, cuerpo: armarRespuestaCuerpo(texto, "descarga") });
    } catch (err) {
        logger.error(`etapa-anotaciones cuerpo: ${err.message}`);
        res.status(500).json({ success: false, message: `no se pudo obtener el documento: ${err.message}` });
    }
};

// ── DELETE /api/admin/etapa-anotaciones/causa/:fuero/:id ──────────────────────
exports.quitarDeCola = async (req, res) => {
    try {
        const r = await col().deleteOne({ causaId: new mongoose.Types.ObjectId(req.params.id) });
        res.json({ success: true, eliminado: r.deletedCount > 0 });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
