/**
 * resolucionesClasificacionController — Cola de clasificación ligera de
 * resoluciones para el clasificador de plazos (repo pjn-clasificador-resoluciones).
 *
 * Un documento por resolución (no por causa, a diferencia de etapa-anotaciones).
 * La cola la alimentan: (a) los feeders Python del clasificador (desacuerdos y
 * predicciones de baja confianza, con texto y predicción incluidos), (b) altas
 * manuales desde la UI admin (fuero + causa + idx → se busca el texto), (c) más
 * adelante, las cédulas con resolución notificada. El operador elige el tipo de
 * resolución (7 opciones, mismas del gold de etapas), si regula honorarios y qué
 * ordena (traslado / vista / intimación). Las anotaciones se exportan como gold
 * adicional para reentrenar.
 *
 * Colección `resoluciones-clasificacion` (misma Mongo que etapa-anotaciones):
 *   { fuente: oof|baja_confianza|manual|cedula, modeloVersion,
 *     fuero, causaType, causaId, idx, url, fecha, titulo, previo, siguiente, objeto, caratula,
 *     texto, chars,
 *     prediccion: { version, tipo, confianza, probs, regulaHonorarios: {valor,p}, ordena: {traslado,vista,intimacion} },
 *     gold: { tipoResolucion, regulaHonorarios, ordena[] } | null,   // etiqueta previa del gold-v4, si existe
 *     anotacion: { tipoResolucion, regulaHonorarios, ordena[], notas } | null,
 *     estado: pendiente|anotada|descartada, prioridad, anotadoPor, anotadoAt, createdAt, updatedAt }
 * Índice único: { causaId, idx }.
 */
const mongoose = require("mongoose");
const axios = require("axios");
const pdfParse = require("pdf-parse");
const pjn = require("pjn-models");
const User = require("../models/user");
const { logger } = require("../config/pino");
const { getSentenciasDb } = require("../config/sentenciasConnection");
const { segmentar } = require("../utils/segmentarResolucion");
const { getSubdocText } = require("../utils/sentencia-text");

const FUERO_MODEL = {
    CIV: { model: () => pjn.CausasCivil, causaType: "CausasCivil" },
    COM: { model: () => pjn.CausasComercial, causaType: "CausasComercial" },
    CSS: { model: () => pjn.CausasSegSoc, causaType: "CausasSegSoc" },
    CNT: { model: () => pjn.CausasTrabajo, causaType: "CausasTrabajo" },
    CAF: { model: () => pjn.CausasCAF, causaType: "CausasCAF" },
    CCF: { model: () => pjn.CausasCCF, causaType: "CausasCCF" },
};
const TIPOS = ["providencia_simple", "sentencia_interlocutoria", "sentencia_definitiva", "sentencia_homologatoria", "acta", "otra_resolucion", "no_es_resolucion"];
const ORDENA = ["traslado", "vista", "intimacion"];
const ESTADOS = ["pendiente", "anotada", "descartada"];
const FUENTES = ["oof", "baja_confianza", "manual", "cedula"];
const TEXTO_MAX = 60000;

const col = () => mongoose.connection.db.collection("resoluciones-clasificacion");
const cacheCol = () => mongoose.connection.db.collection("etapa-cuerpos-cache");
const oid = (s) => new mongoose.Types.ObjectId(s);

let indicesListos = false;
async function asegurarIndices() {
    if (indicesListos) return;
    try {
        await col().createIndex({ causaId: 1, idx: 1 }, { unique: true });
        await col().createIndex({ estado: 1, prioridad: -1, "prediccion.confianza": 1 });
        await col().createIndex({ fuero: 1, estado: 1 });
        indicesListos = true;
    } catch (e) {
        logger.warn(`resoluciones-clasificacion índices: ${e.message}`);
    }
}

// ── Presentación del texto (misma regla que etapa-anotaciones: nunca con huecos ocultos) ──
function cortarFin(s, max) {
    if (!s || s.length <= max) return s || "";
    const c = s.slice(0, max);
    const i = Math.max(c.lastIndexOf("\n"), c.lastIndexOf(" "));
    return (i > max * 0.6 ? c.slice(0, i) : c) + " […]";
}
const CUERPO_COMPLETO_MAX = 30000;
function presentarCuerpo(texto) {
    const t = (texto || "").trim();
    const seg = t.length > 2600 ? segmentar(t.length > 20000 ? t.slice(0, 2000) + t.slice(-8000) : t) : { tieneDispositiva: false };
    if (seg.tieneDispositiva) {
        if (t.length <= CUERPO_COMPLETO_MAX) {
            const marca = seg.dispositiva.slice(0, 100);
            const i = marca ? t.lastIndexOf(marca) : -1;
            if (i > 0) return { caracteres: t.length, completo: null, encabezado: t.slice(0, i).trim(), dispositiva: t.slice(i).trim(), tieneDispositiva: true, colaTexto: null };
        }
        return { caracteres: t.length, completo: null, encabezado: cortarFin(seg.encabezado, 400), dispositiva: cortarFin(seg.dispositiva, 2500), tieneDispositiva: true, colaTexto: null };
    }
    if (t.length <= CUERPO_COMPLETO_MAX) return { caracteres: t.length, completo: t, encabezado: null, dispositiva: null, tieneDispositiva: false, colaTexto: null };
    const omitidos = t.length - 8000;
    return { caracteres: t.length, completo: null, encabezado: cortarFin(t.slice(0, 2000), 2000), dispositiva: null, tieneDispositiva: false,
        colaTexto: `[… se omiten ~${omitidos.toLocaleString("es-AR")} caracteres del medio del documento …]\n\n${t.slice(-6000)}` };
}

// ── Texto de un movimiento: corpus local → cache → sentencias-capturadas → descarga ──
async function obtenerTexto(id, mov) {
    const hermano = await mongoose.connection.db.collection("pjn-movements")
        .findOne({ causaId: oid(id), url: mov.url }, { projection: { _id: 1 } }).catch(() => null);
    if (hermano) {
        const t = await mongoose.connection.db.collection("pjn-movement-texts").findOne({ _id: hermano._id }, { projection: { texto: 1 } }).catch(() => null);
        if (t && t.texto && t.texto.length > 100) return { texto: t.texto, fuente: "corpus", movementId: hermano._id };
    }
    const cacheado = await cacheCol().findOne({ url: mov.url });
    if (cacheado && cacheado.texto) return { texto: cacheado.texto, fuente: "cache" };
    const db = await getSentenciasDb().catch(() => null);
    if (db) {
        const doc = await db.collection("sentencias-capturadas").findOne({ causaId: oid(id), url: mov.url },
            { projection: { "processingResult.text": 1, "processingResult.textGz": 1, "ocrResult.text": 1, "ocrResult.textGz": 1 } });
        const texto = doc && (getSubdocText(doc.processingResult) || getSubdocText(doc.ocrResult));
        if (texto && texto.length > 200) {
            await cacheCol().updateOne({ url: mov.url }, { $set: { url: mov.url, texto, fuente: "sentencias-capturadas", createdAt: new Date() } }, { upsert: true });
            return { texto, fuente: "sentencias-capturadas" };
        }
    }
    const resp = await axios.get(mov.url, { responseType: "arraybuffer", timeout: 25000,
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36", Accept: "application/pdf,*/*" } });
    const ct = (resp.headers["content-type"] || "").toLowerCase();
    const buffer = Buffer.from(resp.data);
    if (!ct.includes("pdf") || buffer.length < 500) throw Object.assign(new Error("el viewer no devolvió un PDF válido"), { status: 422 });
    const texto = ((await pdfParse(buffer)).text || "").trim();
    if (texto.length < 100) throw Object.assign(new Error(`documento escaneado o sin texto extraíble (${texto.length} caracteres)`), { status: 422 });
    await cacheCol().updateOne({ url: mov.url }, { $set: { url: mov.url, texto, fuente: "descarga", createdAt: new Date() } }, { upsert: true });
    return { texto, fuente: "descarga" };
}

const tituloDe = (m) => ((m.tipo || "") + " | " + (m.detalle || "")).replace(/\s+/g, " ").trim();
const RE_PARTE = /^ESCRITO/i, RE_NOTIF = /tipoDoc=(cedula|deo)\b|^CEDULA|^DEO$|^RETORNO CEDULA/i;
const esDocumentoJudicial = (m) => m.url && !RE_PARTE.test(m.tipo || "") && !RE_NOTIF.test(m.url) && !RE_NOTIF.test(m.tipo || "");

function filtroDesdeQuery(q) {
    const f = {};
    if (q.estado && ESTADOS.includes(q.estado)) f.estado = q.estado;
    if (q.fuero && FUERO_MODEL[q.fuero]) f.fuero = q.fuero;
    if (q.fuente && FUENTES.includes(q.fuente)) f.fuente = q.fuente;
    if (q.tipoPred && (TIPOS.includes(q.tipoPred) || q.tipoPred === "otra")) f["prediccion.tipo"] = q.tipoPred; // "otra" = clase agrupada del modelo
    if (q.confMax) f["prediccion.confianza"] = { ...(f["prediccion.confianza"] || {}), $lte: Number(q.confMax) };
    if (q.confMin) f["prediccion.confianza"] = { ...(f["prediccion.confianza"] || {}), $gte: Number(q.confMin) };
    if (q.desacuerdo === "1") f.$expr = { $and: [{ $ne: ["$gold", null] }, { $ne: ["$gold.tipoResolucion", "$prediccion.tipo"] }] };
    if (q.q && String(q.q).trim()) f.titulo = { $regex: String(q.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    return f;
}
const ORDENES = {
    confianza: { prioridad: -1, "prediccion.confianza": 1, _id: 1 },
    reciente: { createdAt: -1 },
    anotacion: { anotadoAt: -1 },
};
const proyeccionLista = { texto: 0 };

// GET /api/admin/resoluciones-clasificacion
exports.getCola = async (req, res) => {
    try {
        await asegurarIndices();
        const page = Math.max(0, parseInt(req.query.page, 10) || 0);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
        const filtro = filtroDesdeQuery(req.query);
        const orden = ORDENES[req.query.orden] || ORDENES.confianza;
        const [items, total, porEstado] = await Promise.all([
            col().find(filtro, { projection: proyeccionLista }).sort(orden).skip(page * limit).limit(limit).toArray(),
            col().countDocuments(filtro),
            col().aggregate([{ $group: { _id: "$estado", n: { $sum: 1 } } }]).toArray(),
        ]);
        res.json({ success: true, items, total, page, limit, porEstado: Object.fromEntries(porEstado.map((x) => [x._id, x.n])) });
    } catch (err) {
        logger.error(`resoluciones-clasificacion cola: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/admin/resoluciones-clasificacion/siguiente — el próximo pendiente según los mismos filtros
exports.getSiguiente = async (req, res) => {
    try {
        const filtro = { ...filtroDesdeQuery(req.query), estado: "pendiente" };
        if (req.query.excluir && mongoose.isValidObjectId(req.query.excluir)) filtro._id = { $ne: oid(req.query.excluir) };
        const doc = await col().find(filtro).sort(ORDENES[req.query.orden] || ORDENES.confianza).limit(1).next();
        if (!doc) return res.json({ success: true, item: null });
        res.json({ success: true, item: { ...doc, cuerpo: presentarCuerpo(doc.texto), texto: undefined } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/admin/resoluciones-clasificacion/stats
exports.getStats = async (req, res) => {
    try {
        const [porEstado, porFuente, porFuero, acuerdo, porDia, porAnotador, versiones] = await Promise.all([
            col().aggregate([{ $group: { _id: "$estado", n: { $sum: 1 } } }]).toArray(),
            col().aggregate([{ $group: { _id: "$fuente", n: { $sum: 1 } } }]).toArray(),
            col().aggregate([{ $group: { _id: { fuero: "$fuero", estado: "$estado" }, n: { $sum: 1 } } }]).toArray(),
            col().aggregate([{ $match: { estado: "anotada", "prediccion.tipo": { $exists: true } } },
                { $group: { _id: { pred: "$prediccion.tipo", anotado: "$anotacion.tipoResolucion" }, n: { $sum: 1 } } }]).toArray(),
            col().aggregate([{ $match: { anotadoAt: { $gte: new Date(Date.now() - 30 * 864e5) } } },
                { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$anotadoAt" } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
            col().aggregate([{ $match: { estado: { $in: ["anotada", "descartada"] } } }, { $group: { _id: "$anotadoPor", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
            col().distinct("prediccion.version"),
        ]);
        const confusion = acuerdo.map((x) => ({ pred: x._id.pred, anotado: x._id.anotado, n: x.n }));
        const total = confusion.reduce((a, x) => a + x.n, 0);
        const iguales = confusion.filter((x) => x.pred === x.anotado).reduce((a, x) => a + x.n, 0);
        // Acuerdo sobre el par caro, aparte.
        const ps = "providencia_simple", si = "sentencia_interlocutoria";
        const parCaro = confusion.filter((x) => [ps, si].includes(x.pred) && [ps, si].includes(x.anotado));
        res.json({
            success: true,
            porEstado: Object.fromEntries(porEstado.map((x) => [x._id, x.n])),
            porFuente: Object.fromEntries(porFuente.map((x) => [x._id, x.n])),
            porFuero: porFuero.map((x) => ({ fuero: x._id.fuero, estado: x._id.estado, n: x.n })),
            acuerdo: { anotadas: total, iguales, pct: total ? Math.round((1000 * iguales) / total) / 10 : null, confusion,
                parCaro: { ps_como_interlocutoria: parCaro.find((x) => x.anotado === ps && x.pred === si)?.n || 0,
                    interlocutoria_como_ps: parCaro.find((x) => x.anotado === si && x.pred === ps)?.n || 0 } },
            porDia: porDia.map((x) => ({ dia: x._id, n: x.n })),
            porAnotador: porAnotador.map((x) => ({ anotador: x._id || "—", n: x.n })),
            versiones: versiones.filter(Boolean),
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/admin/resoluciones-clasificacion/export?estado=anotada&desde=ISO — NDJSON para reentrenar
exports.exportar = async (req, res) => {
    try {
        const filtro = { estado: req.query.estado && ESTADOS.includes(req.query.estado) ? req.query.estado : "anotada" };
        if (req.query.desde) filtro.anotadoAt = { $gte: new Date(req.query.desde) };
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        const cursor = col().find(filtro);
        for await (const d of cursor) res.write(JSON.stringify(d) + "\n");
        res.end();
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
        else res.end();
    }
};

// GET /api/admin/resoluciones-clasificacion/:id
exports.getUno = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id inválido" });
        const doc = await col().findOne({ _id: oid(req.params.id) });
        if (!doc) return res.status(404).json({ success: false, message: "no encontrado" });
        const completo = req.query.completo === "1";
        const cuerpo = completo
            ? { caracteres: (doc.texto || "").length, completo: (doc.texto || "").slice(0, 150000), encabezado: null, dispositiva: null, tieneDispositiva: false, colaTexto: null }
            : presentarCuerpo(doc.texto);
        res.json({ success: true, item: { ...doc, texto: undefined, cuerpo } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// PUT /api/admin/resoluciones-clasificacion/:id — guarda la anotación (o descarta)
exports.anotar = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id inválido" });
        const { tipoResolucion, regulaHonorarios, ordena, notas, descartar, reabrir } = req.body || {};
        const quien = await User.findById(req.userId).select("email").lean().catch(() => null);
        const anotadoPor = (quien && quien.email) || String(req.userId || "");
        let set;
        if (reabrir) {
            set = { estado: "pendiente", anotacion: null, anotadoPor: null, anotadoAt: null, updatedAt: new Date() };
        } else if (descartar) {
            set = { estado: "descartada", anotacion: { notas: typeof notas === "string" ? notas.slice(0, 2000) : "" }, anotadoPor, anotadoAt: new Date(), updatedAt: new Date() };
        } else {
            if (!TIPOS.includes(tipoResolucion)) return res.status(400).json({ success: false, message: `tipoResolucion inválido: ${tipoResolucion}` });
            const ord = Array.isArray(ordena) ? [...new Set(ordena.filter((o) => ORDENA.includes(o)))] : [];
            set = {
                estado: "anotada",
                anotacion: { tipoResolucion, regulaHonorarios: !!regulaHonorarios, ordena: ord, notas: typeof notas === "string" ? notas.slice(0, 2000) : "" },
                anotadoPor, anotadoAt: new Date(), updatedAt: new Date(),
            };
        }
        const r = await col().findOneAndUpdate({ _id: oid(req.params.id) }, { $set: set }, { returnDocument: "after", projection: proyeccionLista });
        const doc = r && (r.value || r);
        if (!doc || !doc._id) return res.status(404).json({ success: false, message: "no encontrado" });
        res.json({ success: true, item: doc });
    } catch (err) {
        logger.error(`resoluciones-clasificacion anotar: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// POST /api/admin/resoluciones-clasificacion — alta manual { fuero, causaId, idx | idxs[] | todos }
exports.agregar = async (req, res) => {
    try {
        await asegurarIndices();
        const { fuero, causaId, prioridad = 2 } = req.body || {};
        const cfg = FUERO_MODEL[fuero];
        if (!cfg) return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });
        if (!mongoose.isValidObjectId(causaId)) return res.status(400).json({ success: false, message: "causaId inválido" });
        const causa = await cfg.model().findById(causaId).select("movimiento caratula objeto number year").lean();
        if (!causa) return res.status(404).json({ success: false, message: "causa no encontrada" });
        const mv = causa.movimiento || [];
        let idxs;
        if (req.body.todos) idxs = mv.map((m, i) => (esDocumentoJudicial(m) ? i : -1)).filter((i) => i >= 0);
        else idxs = (Array.isArray(req.body.idxs) ? req.body.idxs : [req.body.idx]).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
        if (!idxs.length) return res.status(400).json({ success: false, message: "sin movimientos para agregar" });
        if (idxs.length > 60) return res.status(400).json({ success: false, message: "máximo 60 movimientos por alta" });
        const docsJud = mv.map((m, i) => [m, i]).filter(([m]) => esDocumentoJudicial(m)).map(([, i]) => i);
        const vecino = (i, o) => { const p = docsJud.indexOf(i); const j = docsJud[p + o]; return j === undefined ? "" : tituloDe(mv[j]).slice(0, 200); };
        const objeto = (() => { let o = (causa.objeto || "").trim().toUpperCase(); if (o.includes(" S/")) o = o.slice(o.lastIndexOf(" S/") + 3).trim(); return o; })();
        const resultados = [];
        for (const idx of idxs) {
            const m = mv[idx];
            if (!m) { resultados.push({ idx, ok: false, motivo: "movimiento inexistente" }); continue; }
            if (!m.url) { resultados.push({ idx, ok: false, motivo: "sin documento" }); continue; }
            const existe = await col().findOne({ causaId: oid(causaId), idx }, { projection: { _id: 1, estado: 1 } });
            if (existe) { resultados.push({ idx, ok: false, motivo: `ya está en la cola (${existe.estado})`, _id: existe._id }); continue; }
            let t;
            try { t = await obtenerTexto(causaId, m); } catch (e) { resultados.push({ idx, ok: false, motivo: e.message }); continue; }
            const fecha = (() => { const d = new Date(m.fecha); return isNaN(d) ? String(m.fecha || "") : d.toISOString().slice(0, 10); })();
            const doc = {
                fuente: "manual", modeloVersion: null, fuero, causaType: cfg.causaType, causaId: oid(causaId), idx, url: m.url, movementId: t.movementId || null,
                fecha, titulo: tituloDe(m), previo: vecino(idx, 1), siguiente: vecino(idx, -1), objeto, caratula: causa.caratula || null,
                number: causa.number, year: causa.year, texto: t.texto.slice(0, TEXTO_MAX), chars: t.texto.length, textoFuente: t.fuente,
                prediccion: null, gold: null, anotacion: null, estado: "pendiente", prioridad: Number(prioridad) || 2,
                creadoPor: String(req.userId || ""), createdAt: new Date(), updatedAt: new Date(),
            };
            const ins = await col().insertOne(doc);
            resultados.push({ idx, ok: true, _id: ins.insertedId, chars: doc.chars, fuente: t.fuente });
        }
        res.json({ success: true, agregados: resultados.filter((r) => r.ok).length, resultados });
    } catch (err) {
        logger.error(`resoluciones-clasificacion agregar: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/admin/resoluciones-clasificacion/movimientos/:fuero/:causaId — para elegir qué agregar
exports.getMovimientos = async (req, res) => {
    try {
        const cfg = FUERO_MODEL[req.params.fuero];
        if (!cfg) return res.status(400).json({ success: false, message: "fuero inválido" });
        if (!mongoose.isValidObjectId(req.params.causaId)) return res.status(400).json({ success: false, message: "causaId inválido" });
        const causa = await cfg.model().findById(req.params.causaId).select("movimiento caratula objeto number year").lean();
        if (!causa) return res.status(404).json({ success: false, message: "causa no encontrada" });
        const enCola = await col().find({ causaId: oid(req.params.causaId) }, { projection: { idx: 1, estado: 1 } }).toArray();
        const estados = Object.fromEntries(enCola.map((x) => [x.idx, x.estado]));
        const movimientos = (causa.movimiento || []).map((m, idx) => ({ idx, fecha: m.fecha, tipo: m.tipo, detalle: m.detalle, tieneDoc: !!m.url, judicial: esDocumentoJudicial(m), enCola: estados[idx] || null }));
        res.json({ success: true, causa: { caratula: causa.caratula, objeto: causa.objeto, number: causa.number, year: causa.year }, movimientos });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// DELETE /api/admin/resoluciones-clasificacion/:id
exports.quitar = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id inválido" });
        const r = await col().deleteOne({ _id: oid(req.params.id) });
        res.json({ success: true, eliminado: r.deletedCount === 1 });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.TIPOS = TIPOS;
exports.ORDENA = ORDENA;
