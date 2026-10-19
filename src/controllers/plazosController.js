/**
 * plazosController.js — Administración del subsistema de plazos procesales.
 *
 * Expone las 3 colecciones del subsistema (viven en la Mongo LOCAL de
 * worker_01 — estos endpoints solo devuelven datos reales en la instancia
 * Local de pjn-api; la admin UI los consume vía workersAxios):
 *   - plazos-notificaciones (PlazoNotificacion): cédulas detectadas, con su
 *     extracción, cómputo y fundamento.
 *   - plazos-normativa (PlazoNormativa): reglas de plazo subsidiario,
 *     curadas por el admin (verificado/habilitado/matchers editables).
 *   - feriados-judiciales (FeriadoJudicial): calendario de días inhábiles.
 *
 * Nota de cache: el plazos-worker cachea reglas (10 min) y calendario
 * (15 min) en su propio proceso — una edición desde acá tarda ese TTL en
 * impactar los cómputos nuevos.
 */
const mongoose = require("mongoose");
const pjn = require("pjn-models");
const { logger } = require("../config/pino");
const { gunzipText } = require("../utils/sentencia-text");

const { PlazoNotificacion, PlazoNormativa, FeriadoJudicial, PlazoDatasetEjemplo } = pjn;

const parsePagination = (req, maxLimit = 100) => {
	const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
	const limit = Math.min(parseInt(req.query.limit, 10) || 25, maxLimit);
	return { page, limit, skip: (page - 1) * limit };
};

const paginated = (res, data, total, page, limit) =>
	res.json({
		success: true,
		count: total,
		pagination: {
			currentPage: page,
			totalPages: Math.ceil(total / limit) || 1,
			limit,
			hasNextPage: page * limit < total,
			hasPrevPage: page > 1,
		},
		data,
	});

const fail = (res, scope, error) => {
	logger.error(`[plazos] ${scope}: ${error.message}`);
	// MaxTimeMSExpired: la consulta superó el tope — responder rápido en vez de colgar la admin
	if (error.code === 50 || error.codeName === "MaxTimeMSExpired") {
		return res.status(504).json({ success: false, message: "La consulta tardó demasiado (más de 20 s). Probá con un filtro más acotado." });
	}
	return res.status(500).json({ success: false, message: error.message });
};

// Tope de tiempo para toda consulta de la admin: sin él, una consulta sin índice sobre
// plazos-notificaciones (2,5 GB) sigue corriendo en Mongo aunque la admin ya cortó a los 30 s,
// y cada visita apila otro barrido en el secundario.
const MAX_MS = 20000;
const agg = (Model, pipeline) => Model.aggregate(pipeline).option({ maxTimeMS: MAX_MS, allowDiskUse: true });
const cnt = (Model, filter = {}) =>
	Object.keys(filter).length ? Model.countDocuments(filter).maxTimeMS(MAX_MS) : Model.estimatedDocumentCount();

// Memo en proceso para estadísticas (agregaciones de decenas de segundos que cambian poco).
const memoStore = new Map();
const memo = async (key, ttlMs, fn) => {
	const hit = memoStore.get(key);
	if (hit && Date.now() - hit.at < ttlMs) return hit.value;
	const value = await fn();
	memoStore.set(key, { at: Date.now(), value });
	return value;
};
const STATS_TTL = 5 * 60 * 1000;


// ── Usuarios de cada cédula (solo base de usuarios) ───────────────────────────
// Los usuarios salen de las carpetas de la causa (folders.causaId → userId → usuarios.email); una cédula
// puede tener varios. En la caché (rs0) no hay carpetas: no se agrega nada.
const esAtlas = () => process.env.MONGO_TARGET !== "rs0";

async function causasDeUsuario(req) {
	const db = mongoose.connection.db;
	let userIds = [];
	if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) userIds = [new mongoose.Types.ObjectId(req.query.userId)];
	else if (req.query.email) {
		const q = String(req.query.email).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		userIds = (await db.collection("usuarios").find({ email: new RegExp(q, "i") }, { projection: { _id: 1 } }).limit(50).maxTimeMS(MAX_MS).toArray()).map((u) => u._id);
	} else return null;
	if (!userIds.length) return [];
	return db.collection("folders").distinct("causaId", { userId: { $in: userIds }, causaId: { $ne: null } });
}

async function conUsuarios(rows) {
	if (!esAtlas() || !rows.length) return rows;
	const db = mongoose.connection.db;
	const causaIds = [...new Set(rows.map((r) => String(r.causaId)))].map((id) => new mongoose.Types.ObjectId(id));
	const folders = await db.collection("folders")
		.find({ causaId: { $in: causaIds } }, { projection: { causaId: 1, userId: 1 } }).maxTimeMS(MAX_MS).toArray();
	const userIds = [...new Set(folders.map((f) => String(f.userId)))].filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
	const us = userIds.length
		? await db.collection("usuarios").find({ _id: { $in: userIds } }, { projection: { email: 1 } }).toArray()
		: [];
	const emailDe = new Map(us.map((u) => [String(u._id), u.email || null]));
	const porCausa = new Map();
	for (const f of folders) {
		const k = String(f.causaId);
		const lista = porCausa.get(k) || [];
		if (!lista.some((u) => u.userId === String(f.userId))) lista.push({ userId: String(f.userId), email: emailDe.get(String(f.userId)) || null });
		porCausa.set(k, lista);
	}
	return rows.map((r) => ({ ...r, usuarios: porCausa.get(String(r.causaId)) || [] }));
}

// ── Notificaciones ────────────────────────────────────────────────────────────

// GET /admin/plazos/notificaciones?status=&fuero=&causaId=&desde=&hasta=
exports.listNotificaciones = async (req, res) => {
	try {
		const { page, limit, skip } = parsePagination(req);
		const filter = {};
		if (req.query.status) filter.processingStatus = { $in: String(req.query.status).split(",") };
		if (req.query.fuero) filter.fuero = req.query.fuero;
		if (req.query.causaId && mongoose.isValidObjectId(req.query.causaId)) {
			filter.causaId = new mongoose.Types.ObjectId(req.query.causaId);
		}
		if (req.query.fuente) filter["plazo.fuente"] = req.query.fuente;
		// Regla (plazo.norma.clave) y verificación de la regla aplicada: enlaces desde Normativa y Pendientes.
		if (req.query.norma) filter["plazo.norma.clave"] = String(req.query.norma);
		if (req.query.normaVerificada !== undefined) filter["plazo.norma.verificado"] = req.query.normaVerificada === "true" ? true : { $ne: true };
		// Por dónde entró la cédula (base de usuarios): app-update | mis-causas | bandeja.
		if (req.query.via === "bandeja") filter.fuente = "bandeja";
		else if (req.query.via) {
			filter["source.worker"] = String(req.query.via);
			filter.fuente = { $ne: "bandeja" };
		}
		// Cómo se extrajo: resolucion | cuerpo_cedula | cedula (base de usuarios).
		if (req.query.textoFuente) filter["extraccion.textoFuente"] = String(req.query.textoFuente);
		// Usuario: ?userId= o ?email= (parcial) → causas de sus carpetas.
		if (esAtlas()) {
			const causas = await causasDeUsuario(req);
			if (causas) filter.causaId = filter.causaId ? { $in: causas.filter((c) => String(c) === String(filter.causaId)) } : { $in: causas };
		}
		if (req.query.objeto) filter.objeto = new RegExp(String(req.query.objeto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		if (req.query.desde || req.query.hasta) {
			filter.detectedAt = {};
			if (req.query.desde) filter.detectedAt.$gte = new Date(req.query.desde);
			if (req.query.hasta) filter.detectedAt.$lte = new Date(req.query.hasta);
		}

		const [data, total] = await Promise.all([
			PlazoNotificacion.find(filter)
				.select({ "extraccion.textExcerpt": 0, "extraccion.textExcerptGz": 0, "extraccion.menciones": 0 }) // pesados — solo en detail
				.sort({ detectedAt: -1 })
				.skip(skip)
				.limit(limit)
				.lean().maxTimeMS(MAX_MS),
			cnt(PlazoNotificacion, filter),
		]);
		return paginated(res, await conUsuarios(data), total, page, limit);
	} catch (error) {
		return fail(res, "listNotificaciones", error);
	}
};

// GET /admin/plazos/notificaciones/stats
exports.statsNotificaciones = async (req, res) => {
	try {
		const hoy = new Date().toISOString().slice(0, 10);
		const [porStatus, porFuente, vencimientosProximos, total] = await memo(`statsNotif:${mongoose.connection.name}:${hoy}`, STATS_TTL, () => Promise.all([
			agg(PlazoNotificacion, [{ $group: { _id: "$processingStatus", count: { $sum: 1 } } }]),
			agg(PlazoNotificacion, [
				{ $match: { "plazo.fuente": { $ne: null } } },
				{ $group: { _id: "$plazo.fuente", count: { $sum: 1 } } },
			]),
			cnt(PlazoNotificacion, { processingStatus: "computed", "plazo.vencimiento": { $gte: hoy } }),
			cnt(PlazoNotificacion, {}),
		]));
		return res.json({
			success: true,
			data: {
				total,
				porStatus: Object.fromEntries(porStatus.map((s) => [s._id, s.count])),
				porFuente: Object.fromEntries(porFuente.map((s) => [s._id, s.count])),
				vencimientosProximos,
			},
		});
	} catch (error) {
		return fail(res, "statsNotificaciones", error);
	}
};

// GET /admin/plazos/vencimientos — próximos vencimientos computados, asc.
exports.listVencimientos = async (req, res) => {
	try {
		const { page, limit, skip } = parsePagination(req);
		const desde = req.query.desde || new Date().toISOString().slice(0, 10);
		const filter = { processingStatus: "computed", "plazo.vencimiento": { $gte: desde } };
		if (req.query.hasta) filter["plazo.vencimiento"].$lte = req.query.hasta;
		if (req.query.fuero) filter.fuero = req.query.fuero;
		if (req.query.via === "bandeja") filter.fuente = "bandeja";
		else if (req.query.via) { filter["source.worker"] = String(req.query.via); filter.fuente = { $ne: "bandeja" }; }
		if (req.query.textoFuente) filter["extraccion.textoFuente"] = String(req.query.textoFuente);
		if (esAtlas()) {
			const causas = await causasDeUsuario(req);
			if (causas) filter.causaId = { $in: causas };
		}

		const [rows, total] = await Promise.all([
			PlazoNotificacion.find(filter)
				.select({
					causaId: 1, sourceId: 1, number: 1, year: 1, fuero: 1, objeto: 1, caratula: 1, tipoNotificacion: 1,
					"movimiento.fecha": 1, "movimiento.detalle": 1, plazo: 1, detectedAt: 1, fuente: 1, "source.worker": 1,
					"extraccion.textoFuente": 1, "extraccion.apercibimiento": 1, "extraccion.menciones": 1,
				})
				.sort({ "plazo.vencimiento": 1 })
				.skip(skip)
				.limit(limit)
				.lean().maxTimeMS(MAX_MS),
			cnt(PlazoNotificacion, filter),
		]);
		// Fragmento del que salió el plazo: el snippet de la regla (norma) o la mención de mayor score (texto).
		const data = rows.map((r) => {
			const m = (r.extraccion?.menciones || []).reduce((a, b) => (a && a.score >= b.score ? a : b), null);
			const fragmento = r.plazo?.fuente === "norma" ? r.plazo?.norma?.snippet || null : m?.snippet || r.extraccion?.apercibimiento || null;
			if (r.extraccion) delete r.extraccion.menciones;
			return { ...r, fragmento };
		});
		return paginated(res, await conUsuarios(data), total, page, limit);
	} catch (error) {
		return fail(res, "listVencimientos", error);
	}
};

// GET /admin/plazos/notificaciones/:id — detalle completo (con fundamento).
exports.getNotificacion = async (req, res) => {
	try {
		if (!mongoose.isValidObjectId(req.params.id)) {
			return res.status(400).json({ success: false, message: "id inválido" });
		}
		const doc = await PlazoNotificacion.findById(req.params.id).lean().maxTimeMS(MAX_MS);
		if (!doc) return res.status(404).json({ success: false, message: "No encontrada" });
		// El espejo de Atlas guarda el excerpt comprimido — descomprimir para la
		// UI, que sigue recibiendo extraccion.textExcerpt plano como siempre.
		if (doc.extraccion?.textExcerptGz != null && doc.extraccion.textExcerpt == null) {
			doc.extraccion.textExcerpt = gunzipText(doc.extraccion.textExcerptGz);
			delete doc.extraccion.textExcerptGz;
		}
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "getNotificacion", error);
	}
};

// POST /admin/plazos/notificaciones/:id/reprocess — volver a pending.
// Útil tras ajustar reglas normativas o corregir el calendario.
exports.reprocessNotificacion = async (req, res) => {
	try {
		if (!mongoose.isValidObjectId(req.params.id)) {
			return res.status(400).json({ success: false, message: "id inválido" });
		}
		const doc = await PlazoNotificacion.findByIdAndUpdate(
			req.params.id,
			{
				$set: { processingStatus: "pending", retryCount: 0, lastError: null },
				$unset: { processingLock: "" },
			},
			{ new: true }
		).lean().maxTimeMS(MAX_MS);
		if (!doc) return res.status(404).json({ success: false, message: "No encontrada" });
		logger.info(`[plazos] reprocess ${req.params.id} por user ${req.userId}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "reprocessNotificacion", error);
	}
};

// POST /admin/plazos/notificaciones/reprocess-parsed — re-encolar todos los
// 'parsed' (tras agregar/ajustar reglas normativas). Filtro opcional fuero.
exports.reprocessParsed = async (req, res) => {
	try {
		const filter = { processingStatus: "parsed" };
		if (req.body?.fuero) filter.fuero = req.body.fuero;
		const r = await PlazoNotificacion.updateMany(filter, {
			$set: { processingStatus: "pending", retryCount: 0, lastError: null },
			$unset: { processingLock: "" },
		});
		logger.info(`[plazos] reprocess-parsed: ${r.modifiedCount} docs por user ${req.userId}`);
		return res.json({ success: true, data: { reencoladas: r.modifiedCount } });
	} catch (error) {
		return fail(res, "reprocessParsed", error);
	}
};

// ── Normativa ─────────────────────────────────────────────────────────────────

// GET /admin/plazos/normativa
exports.listNormativa = async (req, res) => {
	try {
		const filter = {};
		if (req.query.habilitado !== undefined) filter.habilitado = req.query.habilitado === "true";
		if (req.query.verificado !== undefined) filter.verificado = req.query.verificado === "true";
		if (req.query.fuero) filter.fuero = { $in: [req.query.fuero, "*"] };
		const data = await PlazoNormativa.find(filter).sort({ prioridad: 1 }).lean().maxTimeMS(MAX_MS);
		return res.json({ success: true, count: data.length, data });
	} catch (error) {
		return fail(res, "listNormativa", error);
	}
};

const NORMATIVA_EDITABLE = [
	"label", "acto", "fuero", "matchers", "matchersDetalle", "plazoDias",
	"tipoPlazo", "norma", "descripcion", "prioridad", "habilitado", "verificado", "notas",
];

const validarMatchers = (body) => {
	for (const key of ["matchers", "matchersDetalle"]) {
		for (const p of body[key] || []) {
			try {
				new RegExp(p);
			} catch (_) {
				return `Regex inválida en ${key}: ${p}`;
			}
		}
	}
	return null;
};

// Correo del admin que hace la acción (cae al id si esta instancia no tiene la colección de usuarios).
async function quienEs(req) {
	try {
		if (mongoose.isValidObjectId(req.userId)) {
			const u = await mongoose.connection.db.collection("usuarios").findOne({ _id: new mongoose.Types.ObjectId(req.userId) }, { projection: { email: 1 } });
			if (u?.email) return u.email;
		}
	} catch (_) { /* sin usuarios en esta base */ }
	return String(req.userId || "desconocido");
}

// POST /admin/plazos/normativa — crear regla.
exports.createNormativa = async (req, res) => {
	try {
		const { _id } = req.body || {};
		if (!_id || !/^[a-z0-9_]+$/.test(_id)) {
			return res.status(400).json({ success: false, message: "_id requerido (slug snake_case)" });
		}
		const regexError = validarMatchers(req.body);
		if (regexError) return res.status(400).json({ success: false, message: regexError });

		const payload = { _id };
		for (const k of NORMATIVA_EDITABLE) if (req.body[k] !== undefined) payload[k] = req.body[k];
		const doc = await PlazoNormativa.create(payload);
		PlazoNormativa.clearReglasCache();
		logger.info(`[plazos] normativa creada: ${_id} por user ${req.userId}`);
		return res.status(201).json({ success: true, data: doc.toObject() });
	} catch (error) {
		if (error.code === 11000) return res.status(409).json({ success: false, message: "Ya existe una regla con ese _id" });
		return fail(res, "createNormativa", error);
	}
};

// PATCH /admin/plazos/normativa/:id — editar regla (curación del admin).
exports.updateNormativa = async (req, res) => {
	try {
		const regexError = validarMatchers(req.body || {});
		if (regexError) return res.status(400).json({ success: false, message: regexError });

		const $set = {};
		for (const k of NORMATIVA_EDITABLE) if (req.body[k] !== undefined) $set[k] = req.body[k];
		// Verificar / quitar la verificación deja constancia: quién, cuándo y por qué (nota obligatoria al verificar).
		// Solo cuando cambia: el formulario de edición manda `verificado` en cada guardado.
		const actual = req.body.verificado !== undefined ? await PlazoNormativa.findById(req.params.id).select("verificado").lean().maxTimeMS(MAX_MS) : null;
		if (actual && !!actual.verificado === !!req.body.verificado) delete $set.verificado;
		else if (actual) {
			const nota = String(req.body.nota || "").trim();
			if (req.body.verificado === true && nota.length < 5) {
				return res.status(400).json({ success: false, message: "Para verificar una regla hace falta una nota (qué se revisó y con qué criterio)" });
			}
			$set.verificadoPor = await quienEs(req);
			$set.verificadoAt = new Date();
			$set.verificadoNota = nota || null;
		}
		if (!Object.keys($set).length) return res.status(400).json({ success: false, message: "Nada para actualizar" });

		const doc = await PlazoNormativa.findByIdAndUpdate(req.params.id, { $set }, { new: true, runValidators: true }).lean().maxTimeMS(MAX_MS);
		if (!doc) return res.status(404).json({ success: false, message: "Regla no encontrada" });
		PlazoNormativa.clearReglasCache();
		logger.info(`[plazos] normativa ${req.params.id} editada por user ${req.userId}: ${Object.keys($set).join(",")}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "updateNormativa", error);
	}
};

// ── Feriados ──────────────────────────────────────────────────────────────────

// GET /admin/plazos/feriados?anio=2026&verificado=false
exports.listFeriados = async (req, res) => {
	try {
		const filter = {};
		if (req.query.anio) filter.fecha = { $gte: `${req.query.anio}-01-01`, $lte: `${req.query.anio}-12-31` };
		if (req.query.tipo) filter.tipo = req.query.tipo;
		if (req.query.verificado !== undefined) filter.verificado = req.query.verificado === "true";
		if (req.query.habilitado !== undefined) filter.habilitado = req.query.habilitado === "true";
		const data = await FeriadoJudicial.find(filter).sort({ fecha: 1 }).lean().maxTimeMS(MAX_MS);
		return res.json({ success: true, count: data.length, data });
	} catch (error) {
		return fail(res, "listFeriados", error);
	}
};

const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

// POST /admin/plazos/feriados — crear un día o un rango (ferias/asuetos).
// body: { fecha } | { desde, hasta }, + tipo, descripcion, fuente, verificado
exports.createFeriados = async (req, res) => {
	try {
		const { fecha, desde, hasta, tipo, ambito = "nacional", descripcion = "", fuente = "", verificado = false, notas = "" } = req.body || {};
		if (!tipo) return res.status(400).json({ success: false, message: "tipo requerido" });

		const dias = [];
		if (fecha) {
			if (!RE_DAY.test(fecha)) return res.status(400).json({ success: false, message: "fecha debe ser YYYY-MM-DD" });
			dias.push(fecha);
		} else if (desde && hasta) {
			if (!RE_DAY.test(desde) || !RE_DAY.test(hasta) || desde > hasta) {
				return res.status(400).json({ success: false, message: "rango desde/hasta inválido" });
			}
			for (let d = desde; d <= hasta; d = pjn.diasHabiles.addDays(d, 1)) dias.push(d);
			if (dias.length > 62) return res.status(400).json({ success: false, message: "rango demasiado largo (máx 62 días)" });
		} else {
			return res.status(400).json({ success: false, message: "fecha o desde/hasta requeridos" });
		}

		let upserts = 0;
		for (const d of dias) {
			const r = await FeriadoJudicial.updateOne(
				{ _id: FeriadoJudicial.makeId(d, ambito) },
				{ $set: { fecha: d, ambito, tipo, descripcion, fuente, verificado }, $setOnInsert: { habilitado: true, notas } },
				{ upsert: true }
			);
			if (r.upsertedCount || r.modifiedCount) upserts++;
		}
		FeriadoJudicial.clearSetCache();
		logger.info(`[plazos] feriados: ${dias.length} día(s) cargado(s) por user ${req.userId} (${tipo})`);
		return res.status(201).json({ success: true, data: { dias: dias.length, upserts } });
	} catch (error) {
		return fail(res, "createFeriados", error);
	}
};

// ── Dataset de plazos expresos (minería de reglas empíricas) ─────────────────

// Umbral heurístico de "plazo sospechoso" (los plazos procesales típicos son
// 3/5/6/10/15; >= 60 días casi siempre es una mención de otra cosa).
const PLAZO_SOSPECHOSO = 60;

// Dominante por grupo (fuero, objeto, acto) entre los NO descartados.
async function dominantesPorGrupo() {
	const grupos = await memo(`dominantes:${mongoose.connection.name}`, STATS_TTL, () => agg(PlazoDatasetEjemplo, [
		// Solo plazos procesales: los de pago/cumplimiento son vencimientos
		// reales pero no definen reglas de contestación/apelación/traslado.
		{ $match: { sinPlazo: false, plazoDias: { $ne: null }, "revision.estado": { $ne: "descartado" }, naturaleza: { $nin: ["pago", "cumplimiento"] } } },
		{
			$group: {
				_id: { fuero: "$fuero", objeto: "$objeto", acto: "$acto", plazoDias: "$plazoDias" },
				n: { $sum: 1 },
			},
		},
		{ $sort: { n: -1 } },
		{
			$group: {
				_id: { fuero: "$_id.fuero", objeto: "$_id.objeto", acto: "$_id.acto" },
				total: { $sum: "$n" },
				dominante: { $first: "$_id.plazoDias" },
				dominanteN: { $first: "$n" },
			},
		},
	]));
	const map = new Map();
	for (const g of grupos) {
		map.set(`${g._id.fuero}|${g._id.objeto || ""}|${g._id.acto}`, { dominante: g.dominante, total: g.total, dominanteN: g.dominanteN });
	}
	return map;
}

// GET /admin/plazos/dataset — ejemplos, paginado.
// ?dispersos=true → solo los que se apartan del plazo dominante de su grupo
// o tienen valor sospechoso (>= 60 días) — la cola de revisión humana.
exports.listDataset = async (req, res) => {
	try {
		const { page, limit, skip } = parsePagination(req);
		const filter = {};
		if (req.query.fuero) filter.fuero = req.query.fuero;
		if (req.query.acto) filter.acto = req.query.acto;
		if (req.query.objeto) filter.objeto = new RegExp(String(req.query.objeto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		if (req.query.conPlazo !== undefined) filter.sinPlazo = req.query.conPlazo !== "true";
		if (req.query.naturaleza) filter.naturaleza = req.query.naturaleza;
		if (req.query.revision) filter["revision.estado"] = req.query.revision === "sin_revisar"
			? { $in: ["sin_revisar", null] }
			: req.query.revision;

		const dispersos = req.query.dispersos === "true";
		let data;
		let total;

		if (dispersos) {
			// Cola de revisión: apartados del dominante de su grupo + sospechosos.
			filter.sinPlazo = false;
			filter.plazoDias = { $ne: null };
			const dominantes = await dominantesPorGrupo();
			const todos = await PlazoDatasetEjemplo.find(filter).sort({ harvestedAt: -1 }).limit(2000).lean().maxTimeMS(MAX_MS);
			const marcados = todos
				.map((e) => {
					const grupo = dominantes.get(`${e.fuero}|${e.objeto || ""}|${e.acto}`) || null;
					const apartado = grupo && grupo.total >= 2 && e.plazoDias !== grupo.dominante;
					const sospechoso = e.plazoDias >= PLAZO_SOSPECHOSO;
					return apartado || sospechoso
						? { ...e, _disperso: { apartado: !!apartado, sospechoso, dominanteGrupo: grupo ? grupo.dominante : null, nGrupo: grupo ? grupo.total : 0 } }
						: null;
				})
				.filter(Boolean);
			total = marcados.length;
			data = marcados.slice(skip, skip + limit);
		} else {
			[data, total] = await Promise.all([
				PlazoDatasetEjemplo.find(filter).sort({ harvestedAt: -1 }).skip(skip).limit(limit).lean().maxTimeMS(MAX_MS),
				cnt(PlazoDatasetEjemplo, filter),
			]);
		}
		return paginated(res, data, total, page, limit);
	} catch (error) {
		return fail(res, "listDataset", error);
	}
};

// PATCH /admin/plazos/dataset/:id/revision — confirmar/descartar y CORREGIR
// labels (acto/naturaleza). Una corrección humana marca revision.corregido
// = etiqueta ORO (nunca la pisa una re-cosecha) — la materia prima real
// para entrenar el clasificador de acto.
exports.revisarDatasetEjemplo = async (req, res) => {
	try {
		const { estado, notas, acto, naturaleza } = req.body || {};
		if (!["confirmado", "descartado", "sin_revisar"].includes(estado)) {
			return res.status(400).json({ success: false, message: "estado debe ser confirmado | descartado | sin_revisar" });
		}
		if (naturaleza !== undefined && naturaleza !== null && !["procesal", "pago", "cumplimiento", "otro"].includes(naturaleza)) {
			return res.status(400).json({ success: false, message: "naturaleza inválida" });
		}
		if (acto !== undefined && acto !== null && !/^[a-z0-9_]{2,60}$/.test(acto)) {
			return res.status(400).json({ success: false, message: "acto debe ser slug snake_case" });
		}

		const $set = { "revision.estado": estado, "revision.notas": notas || "", "revision.revisadoAt": new Date() };
		let corregido = false;
		if (acto !== undefined && acto !== null) {
			$set.acto = acto;
			corregido = true;
		}
		if (naturaleza !== undefined && naturaleza !== null) {
			$set.naturaleza = naturaleza;
			corregido = true;
		}
		if (corregido) $set["revision.corregido"] = true;

		const doc = await PlazoDatasetEjemplo.findByIdAndUpdate(req.params.id, { $set }, { new: true }).lean().maxTimeMS(MAX_MS);
		if (!doc) return res.status(404).json({ success: false, message: "Ejemplo no encontrado" });
		logger.info(`[plazos] dataset ${req.params.id} → ${estado}${corregido ? " (labels corregidos)" : ""} por user ${req.userId}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "revisarDatasetEjemplo", error);
	}
};

// GET /admin/plazos/dataset/stats
exports.statsDataset = async (req, res) => {
	try {
		const noDescartado = { "revision.estado": { $ne: "descartado" } };
		const [total, conPlazo, descartados, porFuero, porActo] = await memo(`statsDataset:${mongoose.connection.name}`, STATS_TTL, () => Promise.all([
			cnt(PlazoDatasetEjemplo, noDescartado),
			cnt(PlazoDatasetEjemplo, { sinPlazo: false, ...noDescartado }),
			cnt(PlazoDatasetEjemplo, { "revision.estado": "descartado" }),
			agg(PlazoDatasetEjemplo, [
				{ $match: noDescartado },
				{ $group: { _id: "$fuero", n: { $sum: 1 }, conPlazo: { $sum: { $cond: ["$sinPlazo", 0, 1] } } } },
			]),
			agg(PlazoDatasetEjemplo, [
				{ $match: { sinPlazo: false, ...noDescartado } },
				{ $group: { _id: "$acto", n: { $sum: 1 } } },
				{ $sort: { n: -1 } },
			]),
		]));
		return res.json({
			success: true,
			data: {
				total,
				conPlazo,
				sinPlazo: total - conPlazo,
				descartados,
				porFuero: porFuero.map((f) => ({ fuero: f._id, total: f.n, conPlazo: f.conPlazo })),
				porActo: porActo.map((a) => ({ acto: a._id, n: a.n })),
			},
		});
	} catch (error) {
		return fail(res, "statsDataset", error);
	}
};

// GET /admin/plazos/dataset/candidatos?minN=5&minShare=0.8
// Agrupa por (fuero, objeto, acto): donde el plazo dominante supera los
// umbrales, es un candidato a regla empírica. Se anota si ya existe una
// regla que cubre la combinación y si coincide el plazo.
exports.candidatosDataset = async (req, res) => {
	try {
		const minN = Math.max(parseInt(req.query.minN, 10) || 5, 2);
		const minShare = Math.min(Math.max(parseFloat(req.query.minShare) || 0.8, 0.5), 1);

		const grupos = await memo(`candidatos:${mongoose.connection.name}:${minN}:${minShare}`, STATS_TTL, () => agg(PlazoDatasetEjemplo, [
			{ $match: { sinPlazo: false, plazoDias: { $ne: null }, "revision.estado": { $ne: "descartado" }, naturaleza: { $nin: ["pago", "cumplimiento"] } } },
			{
				$group: {
					_id: { fuero: "$fuero", objeto: "$objeto", acto: "$acto", plazoDias: "$plazoDias", tipoPlazo: "$tipoPlazo" },
					n: { $sum: 1 },
					snippets: { $push: "$snippet" },
					normas: { $addToSet: "$normaCitada" },
				},
			},
			{
				$group: {
					_id: { fuero: "$_id.fuero", objeto: "$_id.objeto", acto: "$_id.acto" },
					total: { $sum: "$n" },
					variantes: { $push: { plazoDias: "$_id.plazoDias", tipoPlazo: "$_id.tipoPlazo", n: "$n", ejemplos: { $slice: ["$snippets", 3] }, normas: "$normas" } },
				},
			},
			{ $match: { total: { $gte: minN } } },
			{ $sort: { total: -1 } },
			{ $limit: 200 },
		]));

		const reglas = await PlazoNormativa.find({ habilitado: true }).sort({ prioridad: 1 }).lean().maxTimeMS(MAX_MS);
		const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

		const candidatos = [];
		for (const g of grupos) {
			const variantes = g.variantes.sort((a, b) => b.n - a.n);
			const dominante = variantes[0];
			const share = dominante.n / g.total;
			if (share < minShare) continue;

			// ¿Alguna regla vigente ya cubre esta combinación?
			const objetoNorm = norm(g._id.objeto);
			const reglaExistente = reglas.find((r) => {
				if (r.acto !== g._id.acto) return false;
				const fueros = r.fuero?.length ? r.fuero : ["*"];
				if (!fueros.includes("*") && !fueros.includes(g._id.fuero)) return false;
				const objetos = r.objetos?.length ? r.objetos : ["*"];
				if (objetos.includes("*")) return true;
				if (!objetoNorm) return false;
				return objetos.some((p) => {
					try {
						return new RegExp(p).test(objetoNorm);
					} catch (_) {
						return false;
					}
				});
			});

			candidatos.push({
				fuero: g._id.fuero,
				objeto: g._id.objeto,
				acto: g._id.acto,
				n: g.total,
				plazoDias: dominante.plazoDias,
				tipoPlazo: dominante.tipoPlazo,
				share: Math.round(share * 100) / 100,
				variantes: variantes.map(({ ejemplos, normas, ...v }) => v),
				ejemplos: dominante.ejemplos.filter(Boolean).slice(0, 3),
				// Origen normativo observado: citas legales que acompañan al
				// plazo dominante en los textos (norma especial o código).
				normasCitadas: (dominante.normas || []).filter(Boolean).slice(0, 4),
				reglaExistente: reglaExistente
					? {
							clave: reglaExistente._id,
							plazoDias: reglaExistente.plazoDias,
							tipoPlazo: reglaExistente.tipoPlazo,
							coincide: reglaExistente.plazoDias === dominante.plazoDias && (reglaExistente.tipoPlazo || "habiles") === (dominante.tipoPlazo || "habiles"),
						}
					: null,
			});
		}

		return res.json({ success: true, count: candidatos.length, data: candidatos });
	} catch (error) {
		return fail(res, "candidatosDataset", error);
	}
};

// ── Config del harvester del dataset (plazos-dataset-worker) ─────────────────

const DATASET_CFG_EDITABLE = ["enabled", "cronPattern", "batchSize", "maxPerCausa", "dailyLimit", "requestDelayMs", "fueros"];

// GET /admin/plazos/dataset-config
exports.getDatasetConfig = async (req, res) => {
	try {
		const doc = await mongoose.connection.db.collection("plazos-dataset-config").findOne({ _id: "global" });
		return res.json({ success: true, data: doc || null });
	} catch (error) {
		return fail(res, "getDatasetConfig", error);
	}
};

// PATCH /admin/plazos/dataset-config — tune del harvester en caliente.
exports.updateDatasetConfig = async (req, res) => {
	try {
		const $set = {};
		const $unset = {};
		for (const k of DATASET_CFG_EDITABLE) if (req.body[k] !== undefined) $set[k] = req.body[k];
		// fueros null o [] = "todos" (el worker usa el default dinámico).
		if (req.body.fueros === null || (Array.isArray(req.body.fueros) && req.body.fueros.length === 0)) {
			delete $set.fueros;
			$unset.fueros = "";
		}
		// Reset de cursor por fuero (para re-escanear un fuero agotado):
		// body.resetCursor = 'CIV' | ['CIV','CSS'] | '*'
		if (req.body.resetCursor) {
			const fueros = req.body.resetCursor === "*" ? null : [].concat(req.body.resetCursor);
			if (fueros) for (const f of fueros) $set[`cursor.${f}`] = null;
			else $set.cursor = {};
		}
		if (!Object.keys($set).length && !Object.keys($unset).length) {
			return res.status(400).json({ success: false, message: "Nada para actualizar" });
		}

		const update = {};
		if (Object.keys($set).length) update.$set = $set;
		if (Object.keys($unset).length) update.$unset = $unset;
		await mongoose.connection.db.collection("plazos-dataset-config").updateOne({ _id: "global" }, update, { upsert: true });
		const doc = await mongoose.connection.db.collection("plazos-dataset-config").findOne({ _id: "global" });
		logger.info(`[plazos] dataset-config por user ${req.userId}: ${[...Object.keys($set), ...Object.keys($unset)].join(",")}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "updateDatasetConfig", error);
	}
};

// ── Monitoreo consolidado del subsistema ─────────────────────────────────────

// GET /admin/plazos/monitor — salud de todos los workers del subsistema de
// plazos + colas + throughput, en una sola llamada (vista admin Monitoreo).
// GET /flujo — Contadores por etapa del flujo de plazos automáticos (solo base de usuarios).
// Responde "dónde está parada cada cédula": detectada (por fuente) → esperando documento →
// cola de cálculo (dentro / fuera del alcance) → calculada → pendiente de entrega → entregada.
// El alcance del cálculo sale de plazos-worker-config.filtroUsuarios (null = solo cuentas de
// prueba) y el de la entrega de plazos-folders-config.userFilter + plazosAutomaticos.activo.
exports.flujo = async (req, res) => {
	if (process.env.MONGO_TARGET === "rs0") {
		return res.status(400).json({ success: false, message: "El flujo de plazos automáticos es de la base de usuarios (Atlas)" });
	}
	try {
		const data = await memo("flujo:usuarios", 60 * 1000, async () => {
			const db = mongoose.connection.db;
			const now = Date.now();
			const hoy = new Date(new Date().toISOString().slice(0, 10));
			const hoyDia = new Date().toISOString().slice(0, 10);
			const alive = (t, min) => !!t && now - new Date(t).getTime() < min * 60 * 1000;
			const U = { origen: "usuario" };

			const [wCfg, foCfg] = await Promise.all([
				db.collection("plazos-worker-config").findOne({ _id: "global" }),
				db.collection("plazos-folders-config").findOne({ _id: "global" }),
			]);
			const filtroCalculo = wCfg?.filtroUsuarios == null ? { isTestAccount: true } : wCfg.filtroUsuarios;
			const calculoParaTodos = !Object.keys(filtroCalculo).length;
			const causasDe = async (filtroUsuarios) => {
				const ids = (await db.collection("usuarios").find(filtroUsuarios, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
				return ids.length ? db.collection("folders").distinct("causaId", { userId: { $in: ids }, causaId: { $ne: null } }) : [];
			};
			const [causasCalculo, causasEntrega] = await Promise.all([
				calculoParaTodos ? null : causasDe(filtroCalculo),
				causasDe({ ...(foCfg?.userFilter || { isTestAccount: true }), "plazosAutomaticos.activo": true }),
			]);
			const enAlcance = causasCalculo ? { causaId: { $in: causasCalculo } } : {};
			const fueraAlcance = causasCalculo ? { causaId: { $nin: causasCalculo } } : { _id: null };
			const confiable = { $or: [{ "plazo.fuente": "texto" }, { "plazo.fuente": "norma", "plazo.norma.verificado": true }] };
			const COLA = { $in: ["pending", "no_url", "processing"] };

			const [porStatus, porFuente, detectadasHoy, colaEnAlcance, colaFuera, confiables, paraEntregar, porValidacion, eventos, avisos] = await Promise.all([
				agg(PlazoNotificacion, [{ $match: U }, { $group: { _id: "$processingStatus", n: { $sum: 1 } } }]),
				agg(PlazoNotificacion, [{ $match: U }, { $group: { _id: { $cond: [{ $eq: ["$fuente", "bandeja"] }, "bandeja", { $ifNull: ["$source.worker", "otro"] }] }, n: { $sum: 1 } } }]),
				cnt(PlazoNotificacion, { ...U, detectedAt: { $gte: hoy } }),
				cnt(PlazoNotificacion, { ...U, processingStatus: COLA, ...enAlcance }),
				cnt(PlazoNotificacion, { ...U, processingStatus: COLA, ...fueraAlcance }),
				cnt(PlazoNotificacion, { ...U, processingStatus: "computed", ...confiable }),
				cnt(PlazoNotificacion, {
					...U,
					processingStatus: "computed",
					...confiable,
					"plazo.vencimiento": { $gte: hoyDia },
					"validacion.estado": { $in: [null, undefined] },
					causaId: { $in: causasEntrega },
				}),
				agg(PlazoNotificacion, [{ $match: { ...U, "validacion.estado": { $ne: null } } }, { $group: { _id: "$validacion.estado", n: { $sum: 1 } } }]),
				db.collection("events").countDocuments({ origen: "plazos-automaticos" }),
				db.collection("foldernotifications").countDocuments({ user: "plazos-automaticos" }),
			]);
			const st = Object.fromEntries(porStatus.map((x) => [x._id, x.n]));
			const val = Object.fromEntries(porValidacion.map((x) => [x._id, x.n]));
			const total = Object.values(st).reduce((a, b) => a + b, 0);
			const calculoVivo = alive(wCfg?.heartbeat?.lastCycleAt, 5);
			const entregaViva = alive(foCfg?.heartbeat?.lastCycleAt, 15);
			const dryRun = foCfg ? foCfg.dryRun !== false : true;

			return {
				alcance: { calculo: calculoParaTodos ? "todos" : "prueba", filtroCalculo, causasCalculo: causasCalculo ? causasCalculo.length : null, causasEntrega: causasEntrega.length, dryRun },
				etapas: [
					{
						id: "detectadas",
						label: "Detectadas",
						total,
						hoy: detectadasHoy,
						desglose: Object.fromEntries(porFuente.map((x) => [x._id, x.n])),
						nota: "Cédulas de causas de usuarios (app-update, Mis Causas, bandeja).",
					},
					{
						id: "esperando",
						label: "Esperando documento",
						total: st.esperando_documento || 0,
						enCola: st.esperando_documento || 0,
						nota: "Llegaron por la bandeja antes que su movimiento; se reconcilian solas.",
					},
					{
						id: "calculo",
						label: "En cola de cálculo",
						total: colaEnAlcance + colaFuera,
						enCola: colaEnAlcance,
						fueraDeAlcance: colaFuera,
						errores: (st.failed || 0) + (st.not_pdf || 0),
						pausada: wCfg?.enabled === false || !calculoVivo,
						motivoPausa: wCfg?.enabled === false ? "plazos-worker-usuarios deshabilitado" : !calculoVivo ? "plazos-worker-usuarios sin heartbeat" : null,
						nota: calculoParaTodos ? "Alcance: todas las causas de usuarios." : `Alcance: solo cuentas de prueba (${causasCalculo.length} causas). Las demás esperan.`,
					},
					{
						id: "calculadas",
						label: "Calculadas",
						total: st.computed || 0,
						confiables,
						sinPlazo: (st.parsed || 0) + (st.extracted || 0),
						revisionManual: st.revision_manual || 0,
						nota: "Con vencimiento. Confiables = plazo del texto o regla verificada.",
					},
					{
						id: "entrega",
						label: "Para entregar",
						total: paraEntregar,
						enCola: paraEntregar,
						errores: val.rechazada || 0,
						pausada: dryRun || foCfg?.enabled === false || !entregaViva,
						motivoPausa: foCfg?.enabled === false ? "plazos-folders-worker deshabilitado" : !entregaViva ? "plazos-folders-worker sin heartbeat" : dryRun ? "dry run: el hub simula" : null,
						nota: `Confiables y vigentes de ${causasEntrega.length} causa(s) de usuarios con plazos automáticos activos.`,
					},
					{
						id: "entregadas",
						label: "Entregadas",
						total: val.validada || 0,
						sinCarpeta: val.sin_carpeta || 0,
						eventos,
						avisos,
						nota: "Validadas por el hub: evento en el calendario y/o aviso en la carpeta; el correo del movimiento muestra el plazo.",
					},
				],
				generatedAt: new Date(),
			};
		});
		return res.json({ success: true, data });
	} catch (error) {
		return fail(res, "flujo", error);
	}
};

// GET /cedula?movementId=<causaId:sourceId> | ?plazoId=<id> — Detalle unificado de una cédula
// de usuario (solo Atlas): causa, movimiento espejado (con el bloque `cedula`: documento de
// pjn-rag-cedulas, recepción de la bandeja, plazo), texto extraído, plazo calculado, cédulas
// de la bandeja vinculadas, carpetas y usuarios de la causa, entrega del hub (eventos y avisos)
// y el correo del movimiento (JudicialMovement por usuario). El PDF lo sirve pjn-rag-api
// (/rag/admin/extraccion/documentos/:movementId/pdf).
const COLECCION_POR_TIPO = {
	CausasCivil: "causas-civil", CausasComercial: "causas-comercial", CausasTrabajo: "causas-trabajo",
	CausasSegSoc: "causas-segsocial", CausasSegSocial: "causas-segsocial",
};
const MOVEMENT_ID_RE = /^[0-9a-f]{24}:[\w-]{3,80}$/;

exports.cedula = async (req, res) => {
	if (process.env.MONGO_TARGET === "rs0") {
		return res.status(400).json({ success: false, message: "El detalle de cédula es de la base de usuarios (Atlas)" });
	}
	try {
		const db = mongoose.connection.db;
		let movementId = req.query.movementId ? String(req.query.movementId) : null;
		const plazoId = req.query.plazoId && mongoose.isValidObjectId(req.query.plazoId) ? new mongoose.Types.ObjectId(req.query.plazoId) : null;
		if (movementId && !MOVEMENT_ID_RE.test(movementId)) return res.status(400).json({ success: false, message: "movementId inválido" });
		if (!movementId && !plazoId) return res.status(400).json({ success: false, message: "Falta movementId o plazoId" });

		const SIN_TEXTO = { "extraccion.textExcerpt": 0, "extraccion.textExcerptGz": 0 };
		let plazo = plazoId ? await PlazoNotificacion.findById(plazoId, SIN_TEXTO).lean() : null;
		if (!movementId && plazo && plazo.sourceId && !plazo.sourceId.startsWith("bandeja-ced-")) movementId = `${plazo.causaId}:${plazo.sourceId}`;
		const causaIdStr = movementId ? movementId.split(":")[0] : String(plazo.causaId);
		const causaId = new mongoose.Types.ObjectId(causaIdStr);

		const mov = movementId ? await db.collection("pjn-movements").findOne({ _id: movementId }) : null;
		const numeroCedula = mov?.cedula?.recepcion?.numeroCedula || mov?.cedula?.documento?.numero ||
			(/C[EÉ]DULA\s*N[°º.:]*\s*(\d{10,16})/i.exec(mov?.detalle || "") || [])[1] || plazo?.bandeja?.numeroCedula || null;
		if (!plazo && movementId) {
			const sourceId = movementId.slice(25);
			plazo = await PlazoNotificacion.findOne({ causaId, sourceId }, SIN_TEXTO).lean() ||
				(numeroCedula ? await PlazoNotificacion.findOne({ causaId, "bandeja.numeroCedula": String(numeroCedula) }, SIN_TEXTO).lean() : null);
		}

		const coleccion = COLECCION_POR_TIPO[mov?.causaType] || plazo?.collection || null;
		const plazoOid = plazo?._id || null;
		const filtroCorreo = mov?.url
			? { "expediente.id": causaIdStr, "movimiento.url": mov.url }
			: mov?.fecha
				? { "expediente.id": causaIdStr, "movimiento.tipo": mov.tipo, "movimiento.fecha": { $gte: new Date(new Date(mov.fecha).getTime() - 12 * 3600e3), $lte: new Date(new Date(mov.fecha).getTime() + 36 * 3600e3) } }
				: null;

		// Resolución notificada y adjuntos remitidos: los vincula pjn-rag-cedulas en cedula.documento.
		const docCedula = mov?.cedula?.documento || null;
		const resId = docCedula?.resolucion?.movementId || null;
		const adjIds = (docCedula?.adjuntosRemitidos || []).filter((id) => typeof id === "string" && MOVEMENT_ID_RE.test(id)).slice(0, 30);
		const vinculadosIds = [...new Set([...(resId ? [resId] : []), ...adjIds])];

		const [causa, texto, folders, bandeja, eventos, avisos, correos, vinculados, textoRes] = await Promise.all([
			coleccion ? db.collection(coleccion).findOne({ _id: causaId }, { projection: { number: 1, year: 1, fuero: 1, caratula: 1, objeto: 1, juzgado: 1, secretaria: 1, isPrivate: 1, source: 1, incidente: 1 } }) : null,
			movementId ? db.collection("pjn-movement-texts").findOne({ _id: movementId }, { projection: { texto: 1 } }) : null,
			db.collection("folders").find({ causaId }, { projection: { userId: 1, folderName: 1, archived: 1, source: 1, causaType: 1 } }).toArray(),
			db.collection("pjn-notifications").find(
				movementId ? { $or: [{ "vinculo.movementId": movementId }, ...(numeroCedula ? [{ numeroCedula: Number(numeroCedula) }] : [])] } : { numeroCedula: Number(numeroCedula) || -1 },
				{ projection: { raw: 0 } },
			).limit(20).toArray(),
			plazoOid ? db.collection("events").find({ plazoNotificacionId: plazoOid }, { projection: { userId: 1, folderId: 1, title: 1, start: 1, allDay: 1, confirmadoPor: 1, archivedAt: 1, googleEventId: 1, createdAt: 1 } }).toArray() : [],
			plazoOid ? db.collection("foldernotifications").find({ idCode: String(plazoOid), code: { $regex: /^plazo-/ } }, { projection: { userId: 1, folderId: 1, code: 1, notification: 1, read: 1, createdAt: 1 } }).toArray() : [],
			filtroCorreo ? db.collection("judicialmovements").find(filtroCorreo, { projection: { userId: 1, notificationStatus: 1, "notificationSettings.notifyAt": 1, notifications: 1, createdAt: 1 } }).limit(50).toArray() : [],
			vinculadosIds.length ? db.collection("pjn-movements").find({ _id: { $in: vinculadosIds } }, { projection: { tipo: 1, fecha: 1, detalle: 1, textoStatus: 1 } }).toArray() : [],
			resId ? db.collection("pjn-movement-texts").findOne({ _id: resId }, { projection: { texto: 1 } }) : null,
		]);
		const porId = new Map(vinculados.map((m) => [m._id, m]));
		const resumenMov = (id) => { const m = porId.get(id); return { movementId: id, tipo: m?.tipo || null, fecha: m?.fecha || null, detalle: m?.detalle || null }; };
		const rn = docCedula?.resolucionNotificada || null;
		const resolucion = resId ? {
			...resumenMov(resId),
			metodo: docCedula.resolucion.metodo || null,
			cobertura: typeof docCedula.resolucion.cobertura === "number" ? docCedula.resolucion.cobertura : null,
			fuente: rn?.fuente || null,
			texto: textoRes?.texto ? { chars: textoRes.texto.length, texto: textoRes.texto.slice(0, 30000) } : null,
		} : null;

		const userIds = [...new Set([...folders.map((f) => String(f.userId)), ...bandeja.map((b) => String(b.userId)), ...correos.map((c) => String(c.userId))])]
			.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
		const usuarios = userIds.length
			? await db.collection("usuarios").find({ _id: { $in: userIds } }, { projection: { email: 1, firstName: 1, lastName: 1, isTestAccount: 1, plazosAutomaticos: 1 } }).toArray()
			: [];

		return res.json({
			success: true,
			data: {
				movementId,
				coleccion,
				causa,
				movimiento: mov,
				texto: texto?.texto ? { chars: texto.texto.length, texto: texto.texto.slice(0, 30000) } : null,
				plazo,
				bandeja,
				folders,
				usuarios,
				entrega: { resultados: plazo?.validacion?.resultados || [], estado: plazo?.validacion?.estado || null, eventos, avisos },
				correos,
				// Campos nuevos (14/10/2026): resolución notificada con su texto y adjuntos remitidos.
				resolucion,
				resolucionNotificada: rn,
				adjuntosRemitidos: adjIds.map(resumenMov),
			},
		});
	} catch (error) {
		return fail(res, "cedula", error);
	}
};

exports.monitor = async (req, res) => {
	try {
		const db = mongoose.connection.db;
		const now = Date.now();
		const hoy = new Date(new Date().toISOString().slice(0, 10));
		const alive = (t, umbralMin) => !!t && now - new Date(t).getTime() < umbralMin * 60 * 1000;
		// Mismo código, dos bases: la instancia de caché (MONGO_TARGET=rs0) monitorea el
		// laboratorio (plazos-worker, dataset, update-movimientos); la de Atlas, la base de
		// usuarios (plazos-worker-usuarios y plazos-folders-worker, en worker_02).
		const esCache = process.env.MONGO_TARGET === "rs0";

		// La pestaña Monitoreo consulta cada 15 s: memo de 60 s para no repetir los conteos.
		const [wCfg, dsCfg, foCfg, cola, detectadasHoy, computadasHoy, revisionManual, updaters, dispersosAprox, porFuente] = await memo(`monitor:${esCache ? "cache" : "usuarios"}`, 60 * 1000, () => Promise.all([
			db.collection("plazos-worker-config").findOne({ _id: "global" }),
			esCache ? db.collection("plazos-dataset-config").findOne({ _id: "global" }) : null,
			esCache ? null : db.collection("plazos-folders-config").findOne({ _id: "global" }),
			agg(PlazoNotificacion, [{ $match: esCache ? {} : { origen: "usuario" } }, { $group: { _id: "$processingStatus", n: { $sum: 1 } } }]),
			cnt(PlazoNotificacion, { detectedAt: { $gte: hoy }, ...(esCache ? {} : { origen: "usuario" }) }),
			cnt(PlazoNotificacion, { processingStatus: "computed", processedAt: { $gte: hoy }, ...(esCache ? {} : { origen: "usuario" }) }),
			cnt(PlazoNotificacion, { processingStatus: "revision_manual", ...(esCache ? {} : { origen: "usuario" }) }),
			esCache ? db.collection("configuracion-update-movimientos").find({}).project({ fuero: 1, enabled: 1, updateProgress: 1 }).toArray() : [],
			esCache ? cnt(PlazoDatasetEjemplo, { "revision.estado": { $in: [null, "sin_revisar"] }, sinPlazo: false, plazoDias: { $gte: 60 } }) : 0,
			esCache ? [] : agg(PlazoNotificacion, [{ $match: { origen: "usuario" } }, { $group: { _id: { $cond: [{ $eq: ["$fuente", "bandeja"] }, "bandeja", { $ifNull: ["$source.worker", "otro"] }] }, n: { $sum: 1 } } }]),
		]));

		const workers = {
			plazosWorker: {
				nombre: esCache ? "plazos-worker" : "plazos-worker-usuarios",
				servidor: esCache ? "worker_01" : "worker_02",
				enabled: wCfg?.enabled !== false,
				alive: alive(wCfg?.heartbeat?.lastCycleAt, 5),
				lastCycleAt: wCfg?.heartbeat?.lastCycleAt || null,
				lastResult: wCfg?.heartbeat?.lastResult || null,
				stats: wCfg?.stats || null,
				// Alcance del cálculo (solo usuarios): null = default, solo cuentas de prueba.
				filtroUsuarios: esCache ? undefined : (wCfg?.filtroUsuarios ?? null),
			},
			datasetWorker: esCache ? {
				enabled: dsCfg?.enabled !== false,
				// barre fueros vacíos sin tocar heartbeat — umbral generoso
				alive: alive(dsCfg?.heartbeat?.lastCycleAt, 60),
				lastCycleAt: dsCfg?.heartbeat?.lastCycleAt || null,
				lastFuero: dsCfg?.heartbeat?.lastFuero || null,
				hoy: dsCfg?.daily || null,
				dailyLimit: dsCfg?.dailyLimit || null,
				stats: dsCfg?.stats || null,
				fuerosAgotados: Object.entries(dsCfg?.cursor || {}).filter(([, v]) => v === "DONE").map(([f]) => f),
			} : null,
			foldersWorker: esCache ? null : {
				servidor: "worker_02",
				enabled: foCfg?.enabled !== false,
				alive: alive(foCfg?.heartbeat?.lastCycleAt, 15),
				lastCycleAt: foCfg?.heartbeat?.lastCycleAt || null,
				lastRun: foCfg?.heartbeat?.lastRun || null,
				dryRun: foCfg ? foCfg.dryRun !== false : true,
				userFilter: foCfg?.userFilter || null,
				stats: foCfg?.stats || null,
			},
		};

		const alertas = [];
		if (!workers.plazosWorker.alive && workers.plazosWorker.enabled) alertas.push(`${workers.plazosWorker.nombre} sin heartbeat (>5 min)`);
		if (workers.datasetWorker && !workers.datasetWorker.alive && workers.datasetWorker.enabled) alertas.push("plazos-dataset-worker sin heartbeat (>60 min)");
		if (workers.foldersWorker && !workers.foldersWorker.alive && workers.foldersWorker.enabled) alertas.push("plazos-folders-worker sin heartbeat (>15 min)");
		const colaMap = Object.fromEntries(cola.map((s) => [s._id, s.n]));
		if ((colaMap.pending || 0) > 500) alertas.push(`cola pending alta: ${colaMap.pending}`);
		if ((colaMap.failed || 0) > 20) alertas.push(`fallidas acumuladas: ${colaMap.failed}`);

		return res.json({
			success: true,
			data: {
				base: esCache ? "cache" : "usuarios",
				workers,
				cola: colaMap,
				hoy: { detectadas: detectadasHoy, computadas: computadasHoy },
				revisionManual,
				dispersosSinRevisar: dispersosAprox,
				updaters: updaters.map((u) => ({ fuero: u.fuero, enabled: u.enabled, processedToday: u.updateProgress?.processedToday ?? null })),
				// Solo usuarios: por dónde entraron las cédulas (app-update, mis-causas, bandeja).
				porFuente: Object.fromEntries(porFuente.map((f) => [f._id, f.n])),
				alertas,
				generatedAt: new Date(),
			},
		});
	} catch (error) {
		return fail(res, "monitor", error);
	}
};

// PATCH /admin/plazos/feriados/:id — editar (verificar/deshabilitar/notas) o MOVER de fecha.
// El _id es `${fecha}|${ambito}` (determinístico, con índice único): cambiar la fecha es otro documento.
// Mover = insertar el nuevo con los mismos datos y borrar el viejo; si el destino ya existe, 409.
exports.updateFeriado = async (req, res) => {
	try {
		const EDITABLE = ["tipo", "descripcion", "fuente", "verificado", "habilitado", "notas"];
		const $set = {};
		for (const k of EDITABLE) if (req.body[k] !== undefined) $set[k] = req.body[k];

		const nuevaFecha = req.body.fecha;
		if (nuevaFecha !== undefined) {
			if (!RE_DAY.test(nuevaFecha)) return res.status(400).json({ success: false, message: "fecha debe ser YYYY-MM-DD" });
			const viejo = await FeriadoJudicial.findById(req.params.id).lean().maxTimeMS(MAX_MS);
			if (!viejo) return res.status(404).json({ success: false, message: "Feriado no encontrado" });
			if (nuevaFecha !== viejo.fecha) {
				const nuevoId = FeriadoJudicial.makeId(nuevaFecha, viejo.ambito);
				if (await FeriadoJudicial.exists({ _id: nuevoId })) {
					return res.status(409).json({ success: false, message: `Ya existe un día inhábil el ${nuevaFecha}. Editalo o borralo antes de mover este.` });
				}
				const { _id, createdAt, updatedAt, __v, ...resto } = viejo;
				await FeriadoJudicial.create({ ...resto, ...$set, _id: nuevoId, fecha: nuevaFecha });
				await FeriadoJudicial.deleteOne({ _id: req.params.id });
				FeriadoJudicial.clearSetCache();
				logger.info(`[plazos] feriado ${req.params.id} movido a ${nuevaFecha} por ${await quienEs(req)} (${new Date().toISOString()})`);
				return res.json({ success: true, data: await FeriadoJudicial.findById(nuevoId).lean() });
			}
		}
		if (!Object.keys($set).length) return res.status(400).json({ success: false, message: "Nada para actualizar" });

		const doc = await FeriadoJudicial.findByIdAndUpdate(req.params.id, { $set }, { new: true, runValidators: true }).lean().maxTimeMS(MAX_MS);
		if (!doc) return res.status(404).json({ success: false, message: "Feriado no encontrado" });
		FeriadoJudicial.clearSetCache();
		logger.info(`[plazos] feriado ${req.params.id} editado por user ${req.userId}: ${Object.keys($set).join(",")}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "updateFeriado", error);
	}
};

// DELETE /admin/plazos/feriados/:id — borrar un día inhábil (queda en el log quién y cuándo).
exports.deleteFeriado = async (req, res) => {
	try {
		const doc = await FeriadoJudicial.findByIdAndDelete(req.params.id).lean().maxTimeMS(MAX_MS);
		if (!doc) return res.status(404).json({ success: false, message: "Feriado no encontrado" });
		FeriadoJudicial.clearSetCache();
		logger.info(`[plazos] feriado ${doc.fecha} (${doc.tipo}, ${doc.ambito}) BORRADO por ${await quienEs(req)} (${new Date().toISOString()})`);
		return res.json({ success: true, data: { _id: doc._id, fecha: doc.fecha } });
	} catch (error) {
		return fail(res, "deleteFeriado", error);
	}
};

// PUT /admin/plazos/feriados/bloque — reemplaza el bloque de una feria (tipo feria_*) por otro rango.
// body: { tipo, bloqueDesde, bloqueHasta (el bloque actual), desde, hasta (el nuevo), ambito?, aplicar? }
// Sin `aplicar` devuelve solo el diff (agregan / quitan / conflictos); con `aplicar: true` lo ejecuta.
// Los días del bloque nuevo que ya existen con OTRO tipo son conflictos y bloquean la operación.
exports.reemplazarBloque = async (req, res) => {
	try {
		const { tipo, bloqueDesde, bloqueHasta, desde, hasta, ambito = "nacional", aplicar = false } = req.body || {};
		if (!tipo || !String(tipo).startsWith("feria_")) return res.status(400).json({ success: false, message: "Solo se editan bloques de tipo feria_*" });
		for (const f of [bloqueDesde, bloqueHasta, desde, hasta]) {
			if (!RE_DAY.test(f || "")) return res.status(400).json({ success: false, message: "Las fechas deben ser YYYY-MM-DD" });
		}
		if (bloqueDesde > bloqueHasta || desde > hasta) return res.status(400).json({ success: false, message: "Rango inválido (desde > hasta)" });
		const rango = (a, b) => { const out = []; for (let d = a; d <= b; d = pjn.diasHabiles.addDays(d, 1)) out.push(d); return out; };
		const nuevos = rango(desde, hasta);
		if (nuevos.length > 62) return res.status(400).json({ success: false, message: "Rango demasiado largo (máx 62 días)" });

		const viejosDocs = await FeriadoJudicial.find({ tipo, ambito, fecha: { $gte: bloqueDesde, $lte: bloqueHasta } }).sort({ fecha: 1 }).lean().maxTimeMS(MAX_MS);
		if (!viejosDocs.length) return res.status(404).json({ success: false, message: "No hay días de esa feria en el bloque indicado" });
		const viejos = new Set(viejosDocs.map((d) => d.fecha));
		const setNuevos = new Set(nuevos);
		const quitan = [...viejos].filter((f) => !setNuevos.has(f));
		const faltan = nuevos.filter((f) => !viejos.has(f));
		// ¿Los que faltan ya existen con otro tipo (u otro bloque de la misma feria)? Se informan y bloquean.
		const existentes = faltan.length ? await FeriadoJudicial.find({ ambito, fecha: { $in: faltan } }, { fecha: 1, tipo: 1 }).lean().maxTimeMS(MAX_MS) : [];
		const existe = new Map(existentes.map((d) => [d.fecha, d.tipo]));
		const conflictos = faltan.filter((f) => existe.has(f) && existe.get(f) !== tipo).map((f) => ({ fecha: f, tipo: existe.get(f) }));
		const agregan = faltan.filter((f) => !existe.has(f));
		const diff = { agregan, quitan, conflictos, quedan: nuevos.length - agregan.length };

		if (!aplicar) return res.json({ success: true, data: { aplicado: false, ...diff } });
		if (conflictos.length) {
			return res.status(409).json({ success: false, message: `Hay ${conflictos.length} día(s) del bloque nuevo que ya son otro tipo de día inhábil: ${conflictos.map((c) => `${c.fecha} (${c.tipo})`).join(", ")}`, data: diff });
		}
		const base = viejosDocs[0];
		// Primero se agregan los que faltan y recién después se borran los que sobran (si algo falla no se pierde la feria).
		for (const f of agregan) {
			await FeriadoJudicial.updateOne(
				{ _id: FeriadoJudicial.makeId(f, ambito) },
				{ $set: { fecha: f, ambito, tipo, descripcion: base.descripcion || "", fuente: base.fuente || "", verificado: !!base.verificado }, $setOnInsert: { habilitado: true, notas: base.notas || "" } },
				{ upsert: true },
			);
		}
		if (quitan.length) await FeriadoJudicial.deleteMany({ tipo, ambito, fecha: { $in: quitan } });
		FeriadoJudicial.clearSetCache();
		logger.info(`[plazos] feria ${tipo} ${bloqueDesde}..${bloqueHasta} → ${desde}..${hasta} (+${agregan.length} −${quitan.length}) por ${await quienEs(req)} (${new Date().toISOString()})`);
		return res.json({ success: true, data: { aplicado: true, ...diff } });
	} catch (error) {
		return fail(res, "reemplazarBloque", error);
	}
};

// ── Calendario judicial: cobertura y generación de un año ─────────────────────
// La lógica vive en pjn-models (feriadosCalendario). Escriben/leen la base de referencias de ESTA instancia
// (rs0 por cache-api): los workers leen de ahí. Pendientes (Atlas) las consulta por HTTP interno.

// GET /admin/plazos/feriados/cobertura → { cobertura, sinVerificar (próximos 90 días) }
exports.coberturaFeriados = async (req, res) => {
	try {
		const fc = pjn.feriadosCalendario;
		const col = FeriadoJudicial.collection;
		const [cobertura, sinVerificar] = await Promise.all([fc.cobertura(col), fc.sinVerificarProximos(col, { dias: 90 })]);
		return res.json({ success: true, data: { cobertura, sinVerificar } });
	} catch (error) {
		return fail(res, "coberturaFeriados", error);
	}
};

// POST /admin/plazos/feriados/generar { anio, aplicar? } — sin aplicar devuelve el diff; con aplicar SOLO inserta lo que falta.
exports.generarFeriados = async (req, res) => {
	try {
		const anio = parseInt(req.body?.anio, 10);
		if (!(anio >= 2020 && anio <= 2100)) return res.status(400).json({ success: false, message: "anio inválido" });
		const aplicar = req.body?.aplicar === true;
		const r = await pjn.feriadosCalendario.generarAnio(FeriadoJudicial.collection, anio, { aplicar });
		if (aplicar) {
			FeriadoJudicial.clearSetCache();
			logger.info(`[plazos] calendario ${anio} generado por ${await quienEs(req)} (${new Date().toISOString()}): +${r.agregan.length} día(s), ${r.sinVerificar} sin verificar`);
		}
		return res.json({ success: true, data: r });
	} catch (error) {
		return fail(res, "generarFeriados", error);
	}
};
