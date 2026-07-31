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

// Taxonomía v2 de dimensiones factorizadas (revisión experta 2026-07-31):
// tipo preciso, instancia por metadatos, objeto triseccionado en
// materia × contexto × función, firmeza como estado independiente, modos de
// terminación ampliados, acto procesal como dimensión accionable, y
// decisiones[] multivaluadas. Ver memoria del proyecto.
const DIMENSIONES = {
    tipoResolucion: ["providencia_simple", "sentencia_interlocutoria", "sentencia_definitiva", "otra_resolucion", "no_es_resolucion"],
    instancia: ["primera_instancia", "segunda_instancia", "superior_tribunal_provincial", "csjn", "instancia_unica", "otro", "indeterminada"],
    materia: ["fondo", "prueba", "competencia", "cautelar", "conciliacion", "honorarios", "costas", "liquidacion", "ejecucion", "recurso", "nulidad", "otro"],
    contexto: ["principal", "incidental", "ejecucion", "recursiva", "cautelar", "otro"],
    funcion: ["impulso", "ordenacion", "decision", "terminacion", "suspension", "reanudacion", "otro"],
    modoTerminacion: [
        "sentencia_sobre_fondo", "allanamiento", "desistimiento_del_proceso", "desistimiento_del_derecho",
        "transaccion", "conciliacion", "caducidad_de_instancia", "homologacion_de_acuerdo",
        "sustraccion_de_materia", "declaracion_de_abstraccion", "archivo", "incompetencia_con_remision", "otro",
    ],
    estadoImpugnatorio: ["recurrible", "recurrida", "firme", "no_determinado"],
    actoProcesal: [
        "corre_traslado", "intima", "fija_audiencia", "ordena_notificacion", "ordena_oficio", "ordena_cedula",
        "tiene_presente", "agrega_documentacion", "abre_a_prueba", "declara_causa_puro_derecho",
        "pasa_autos_sentencia", "regula_honorarios", "aprueba_liquidacion", "designa_perito", "declara_rebeldia",
        "declara_caducidad", "concede_recurso", "deniega_recurso", "resuelve_fondo", "homologa_acuerdo",
        "ordena_embargo", "levanta_embargo", "suspende_proceso", "reanuda_proceso", "archiva", "otro",
    ],
    resultado: [
        "hace_lugar", "hace_lugar_parcialmente", "rechaza", "confirma", "revoca", "modifica",
        "desierto", "concede", "deniega", "homologa", "no_aplica", "otro",
    ],
    destinatario: [
        "actora", "demandada", "ambas_partes", "perito", "testigo", "tercero",
        "organismo_publico", "letrado", "sindico", "banco_o_registro", "oficial_de_justicia", "otro",
    ],
    accionRequerida: [
        "contestar_demanda", "contestar_traslado", "contestar_agravios", "expresar_agravios",
        "acompanar_documental", "acompanar_bono", "acreditar_personeria", "constituir_domicilio",
        "subsanar_defecto", "depositar_suma", "pagar_tasa", "presentar_liquidacion",
        "impugnar_liquidacion", "impugnar_pericia", "ofrecer_prueba", "producir_prueba",
        "reconocer_desconocer_documental", "presentar_informe",
        "aceptar_cargo", "comparecer_audiencia", "diligenciar_cedula", "presentar_oficio", "integrar_copias",
        "cumplir_intimacion", "otro",
    ],
    etiquetaFinal: [
        "demanda", "traba_litis", "prueba", "puro_derecho", "alegatos", "autos_sentencia",
        "sentencia_primera", "segunda_instancia", "sentencia_camara", "recurso_extraordinario",
        "sentencia_firme", "fin_litigio", "ejecucion", "sentencia_remate", "archivo",
        "apertura_sucesion", "edictos", "declaratoria", "inscripcion", "particion",
        "apertura_concurso", "verificacion", "informe_general", "categorizacion", "acuerdo", "homologacion",
        "hito:sentencia_interlocutoria", "hito:resolucion_incidente", "hito:audiencia",
        "hito:homologacion_acuerdo", "hito:desercion", "hito:inhabilidad_instancia", "hito:archivo",
        "ninguna",
    ],
};

const DIMS_SIMPLES = ["tipoResolucion", "instancia", "materia", "contexto", "funcion", "modoTerminacion", "estadoImpugnatorio", "actoProcesal", "resultado"];

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

        // Espejo en el corpus: pjn-movements (PDF) + pjn-movement-texts (texto),
        // por url. Sirve para los indicadores por movimiento en el editor.
        const espejo = new Map();
        await mongoose.connection.db.collection("pjn-movements")
            .find({ causaId: new mongoose.Types.ObjectId(id), url: { $ne: null } })
            .project({ url: 1, pdfStatus: 1, textoStatus: 1 })
            .forEach((d) => espejo.set(d.url, { pdf: d.pdfStatus || null, texto: d.textoStatus || null }))
            .catch(() => {});

        const movimientos = (causa.movimiento || []).map((m, idx) => ({
            idx,
            fecha: m.fecha, dia: dayKey(m.fecha),
            tipo: (m.tipo || "").trim(),
            detalle: (m.detalle || "").trim(),
            url: m.url || null,
            etiquetaDebil: debilesPorDia[dayKey(m.fecha)] || null,
            corpus: (m.url && espejo.get(m.url)) || null,
        }));

        // Cuerpos: primero el corpus local (pjn-movement-texts, construido por
        // scripts/corpus de pjn-workers-scraping), después sentencias-capturadas.
        let cuerpos = [];
        const textosLocales = await mongoose.connection.db.collection("pjn-movement-texts")
            .find({ causaId: new mongoose.Types.ObjectId(id) })
            .project({ texto: 1, sourceId: 1 })
            .toArray()
            .catch(() => []);
        if (textosLocales.length) {
            // Metadata (fecha/detalle/url) del hermano operativo para matchear con movimientos.
            const hermanos = await mongoose.connection.db.collection("pjn-movements")
                .find({ causaId: new mongoose.Types.ObjectId(id), textoStatus: { $in: ["extracted", "ocr_done"] } })
                .project({ url: 1, fecha: 1, detalle: 1, sourceId: 1 })
                .toArray()
                .catch(() => []);
            const metaPorSource = new Map(hermanos.map((h) => [h.sourceId, h]));
            for (const t of textosLocales) {
                const meta = metaPorSource.get(t.sourceId);
                if (!meta) continue;
                cuerpos.push({
                    url: meta.url, dia: dayKey(meta.fecha), detalle: (meta.detalle || "").trim(),
                    ...presentarCuerpo(t.texto || ""),
                });
            }
        }
        const db = cuerpos.length ? null : await atlasDb().catch(() => null);
        if (db) {
            const docs = await db.collection("sentencias-capturadas")
                .find({ causaId: new mongoose.Types.ObjectId(id) })
                .project({ url: 1, movimientoFecha: 1, movimientoDetalle: 1, "processingResult.text": 1, "ocrResult.text": 1 })
                .toArray();
            cuerpos = docs.map((d) => {
                const texto = (d.processingResult && d.processingResult.text) || (d.ocrResult && d.ocrResult.text) || "";
                return {
                    url: d.url, dia: dayKey(d.movimientoFecha), detalle: (d.movimientoDetalle || "").trim(),
                    ...presentarCuerpo(texto),
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
                for (const dim of DIMS_SIMPLES) {
                    if (a[dim] === null) limpia[dim] = null;
                    else if (a[dim] && DIMENSIONES[dim].includes(a[dim])) limpia[dim] = a[dim];
                }
                // Actos secundarios (opcional): otros actos del mismo documento
                if (Array.isArray(a.actosSecundarios)) {
                    limpia.actosSecundarios = a.actosSecundarios
                        .filter((x) => DIMENSIONES.actoProcesal.includes(x))
                        .slice(0, 8);
                }
                // decisiones[]: disposiciones múltiples {objetoDecidido, resultado}
                if (Array.isArray(a.decisiones)) {
                    limpia.decisiones = a.decisiones.slice(0, 10)
                        .map((d) => ({
                            objetoDecidido: String(d && d.objetoDecidido || "").slice(0, 60),
                            resultado: d && DIMENSIONES.resultado.includes(d.resultado) ? d.resultado : null,
                        }))
                        .filter((d) => d.objetoDecidido || d.resultado);
                }
                // Cargas procesales (múltiples): [{destinatarios[], accion, plazo, apercibimiento}]
                if (Array.isArray(a.cargas)) {
                    limpia.cargas = a.cargas.slice(0, 8).map((c) => {
                        const carga = {
                            destinatarios: Array.isArray(c && c.destinatarios)
                                ? c.destinatarios.filter((x) => DIMENSIONES.destinatario.includes(x)).slice(0, 6)
                                : [],
                            accion: c && DIMENSIONES.accionRequerida.includes(c.accion) ? c.accion : null,
                            plazo: null,
                            apercibimiento: String(c && c.apercibimiento || "").slice(0, 200),
                        };
                        if (c && c.plazo && typeof c.plazo === "object") {
                            const cantidad = parseInt(c.plazo.cantidad, 10);
                            carga.plazo = {
                                cantidad: Number.isFinite(cantidad) ? cantidad : null,
                                unidad: ["dias", "horas", "meses"].includes(c.plazo.unidad) ? c.plazo.unidad : "dias",
                                tipo: ["procesales", "corridos"].includes(c.plazo.tipo) ? c.plazo.tipo : "procesales",
                            };
                        }
                        return carga;
                    }).filter((c) => c.destinatarios.length || c.accion || c.plazo || c.apercibimiento);
                }
                if (typeof a.descartar === "boolean") limpia.descartar = a.descartar;
                if (a.etiqueta === null || a.etiqueta === "") limpia.etiqueta = null;
                else if (typeof a.etiqueta === "string" && DIMENSIONES.etiquetaFinal.includes(a.etiqueta)) limpia.etiqueta = a.etiqueta;
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

// Corta en un límite de palabra/línea (nunca a mitad de palabra).
function cortarFin(s, max) {
    if (!s || s.length <= max) return s || "";
    const c = s.slice(0, max);
    const i = Math.max(c.lastIndexOf("\n"), c.lastIndexOf(" "));
    return (i > max * 0.6 ? c.slice(0, i) : c) + " […]";
}
// Al cortar por el inicio, arranca en la próxima línea completa.
function cortarInicio(s) {
    const nl = s.indexOf("\n");
    return nl > 0 && nl < 150 ? "[…] " + s.slice(nl + 1) : s;
}

// Presentación del cuerpo para el editor.
// Regla: NUNCA mostrar con huecos. Si hay dispositiva detectada → encabezado +
// dispositiva (lo demás es relato). Si NO hay dispositiva, el documento entero
// es potencialmente operativo (providencias/intimaciones) → texto completo
// hasta CUERPO_COMPLETO_MAX; más allá, encabezado + cola con hueco EXPLÍCITO.
// Cubre los autos de prueba largos (art. 80 LO) que no tienen fórmula
// dispositiva pero son operativos de punta a punta.
const CUERPO_COMPLETO_MAX = 30000;
function presentarCuerpo(texto) {
    const t = (texto || "").trim();
    const seg = t.length > 2600 ? segmentar(t.length > 20000 ? t.slice(0, 2000) + t.slice(-8000) : t) : { tieneDispositiva: false };
    if (seg.tieneDispositiva) {
        // Documento en tamaño razonable: TODO el texto previo a la dispositiva
        // (en actas de audiencia el "medio" son los términos del acuerdo — no
        // se puede descartar) + la dispositiva resaltada.
        if (t.length <= CUERPO_COMPLETO_MAX) {
            const marca = seg.dispositiva.slice(0, 100);
            const idx = marca ? t.lastIndexOf(marca) : -1;
            if (idx > 0) {
                return {
                    caracteres: t.length, completo: null,
                    encabezado: t.slice(0, idx).trim(),
                    dispositiva: t.slice(idx).trim(),
                    tieneDispositiva: true, colaTexto: null,
                };
            }
        }
        // Muy largo (o no se pudo ubicar el offset): resumen segmentado clásico.
        return {
            caracteres: t.length, completo: null,
            encabezado: cortarFin(seg.encabezado, 400),
            dispositiva: cortarFin(seg.dispositiva, 2500),
            tieneDispositiva: true, colaTexto: null,
        };
    }
    if (t.length <= CUERPO_COMPLETO_MAX) {
        return { caracteres: t.length, completo: t, encabezado: null, dispositiva: null, tieneDispositiva: false, colaTexto: null };
    }
    // Muy largo y sin dispositiva (raro): cabeza + cola con el hueco declarado.
    const encabezado = cortarFin(t.slice(0, 2000), 2000);
    const cola = cortarInicio(t.slice(-6000));
    const omitidos = t.length - 2000 - 6000;
    return {
        caracteres: t.length, completo: null, encabezado,
        dispositiva: null, tieneDispositiva: false,
        colaTexto: `[… se omiten ~${omitidos.toLocaleString("es-AR")} caracteres del medio del documento …]\n\n${cola}`,
    };
}

function armarRespuestaCuerpo(texto, fuente) {
    return { fuente, ...presentarCuerpo(texto) };
}

exports.getCuerpoOnDemand = async (req, res) => {
    try {
        const { fuero, id, idx } = req.params;
        // ?completo=1 → texto íntegro sin segmentar (para el botón "Ver documento completo")
        const modoCompleto = req.query.completo === "1";
        const responder = (texto, fuente) => {
            if (modoCompleto) {
                return res.json({
                    success: true,
                    cuerpo: {
                        fuente, caracteres: texto.length,
                        completo: texto.slice(0, 150000),
                        encabezado: null, dispositiva: null, tieneDispositiva: false, colaTexto: null,
                    },
                });
            }
            return res.json({ success: true, cuerpo: armarRespuestaCuerpo(texto, fuente) });
        };
        const cfg = FUERO_MODEL[fuero];
        if (!cfg) return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });
        const causa = await cfg.model().findById(id).select("movimiento").lean();
        const mov = causa && causa.movimiento && causa.movimiento[parseInt(idx, 10)];
        if (!mov) return res.status(404).json({ success: false, message: "movimiento no encontrado" });
        if (!mov.url) return res.status(400).json({ success: false, message: "el movimiento no tiene documento asociado" });

        // 0. Corpus local (pjn-movement-texts, vía el hermano operativo por url)
        const hermano = await mongoose.connection.db.collection("pjn-movements")
            .findOne({ causaId: new mongoose.Types.ObjectId(id), url: mov.url }, { projection: { _id: 1 } })
            .catch(() => null);
        if (hermano) {
            const textoDoc = await mongoose.connection.db.collection("pjn-movement-texts")
                .findOne({ _id: hermano._id }, { projection: { texto: 1 } })
                .catch(() => null);
            if (textoDoc && textoDoc.texto && textoDoc.texto.length > 100) {
                return responder(textoDoc.texto, "corpus");
            }
        }

        // 1. Cache local
        const cacheado = await cacheCol().findOne({ url: mov.url });
        if (cacheado) {
            return responder(cacheado.texto, "cache");
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
                return responder(texto, "sentencias-capturadas");
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
        return responder(texto, "descarga");
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
