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
	return res.status(500).json({ success: false, message: error.message });
};

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
		if (req.query.objeto) filter.objeto = new RegExp(String(req.query.objeto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		if (req.query.desde || req.query.hasta) {
			filter.detectedAt = {};
			if (req.query.desde) filter.detectedAt.$gte = new Date(req.query.desde);
			if (req.query.hasta) filter.detectedAt.$lte = new Date(req.query.hasta);
		}

		const [data, total] = await Promise.all([
			PlazoNotificacion.find(filter)
				.select({ "extraccion.textExcerpt": 0, "extraccion.menciones": 0 }) // pesados — solo en detail
				.sort({ detectedAt: -1 })
				.skip(skip)
				.limit(limit)
				.lean(),
			PlazoNotificacion.countDocuments(filter),
		]);
		return paginated(res, data, total, page, limit);
	} catch (error) {
		return fail(res, "listNotificaciones", error);
	}
};

// GET /admin/plazos/notificaciones/stats
exports.statsNotificaciones = async (req, res) => {
	try {
		const hoy = new Date().toISOString().slice(0, 10);
		const [porStatus, porFuente, vencimientosProximos, total] = await Promise.all([
			PlazoNotificacion.aggregate([{ $group: { _id: "$processingStatus", count: { $sum: 1 } } }]),
			PlazoNotificacion.aggregate([
				{ $match: { "plazo.fuente": { $ne: null } } },
				{ $group: { _id: "$plazo.fuente", count: { $sum: 1 } } },
			]),
			PlazoNotificacion.countDocuments({ processingStatus: "computed", "plazo.vencimiento": { $gte: hoy } }),
			PlazoNotificacion.countDocuments({}),
		]);
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

		const [data, total] = await Promise.all([
			PlazoNotificacion.find(filter)
				.select({
					causaId: 1, number: 1, year: 1, fuero: 1, objeto: 1, caratula: 1, tipoNotificacion: 1,
					"movimiento.fecha": 1, "movimiento.detalle": 1, plazo: 1, detectedAt: 1,
				})
				.sort({ "plazo.vencimiento": 1 })
				.skip(skip)
				.limit(limit)
				.lean(),
			PlazoNotificacion.countDocuments(filter),
		]);
		return paginated(res, data, total, page, limit);
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
		const doc = await PlazoNotificacion.findById(req.params.id).lean();
		if (!doc) return res.status(404).json({ success: false, message: "No encontrada" });
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
		).lean();
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
		const data = await PlazoNormativa.find(filter).sort({ prioridad: 1 }).lean();
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
		if (!Object.keys($set).length) return res.status(400).json({ success: false, message: "Nada para actualizar" });

		const doc = await PlazoNormativa.findByIdAndUpdate(req.params.id, { $set }, { new: true, runValidators: true }).lean();
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
		const data = await FeriadoJudicial.find(filter).sort({ fecha: 1 }).lean();
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
	const grupos = await PlazoDatasetEjemplo.aggregate([
		{ $match: { sinPlazo: false, plazoDias: { $ne: null }, "revision.estado": { $ne: "descartado" } } },
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
	]);
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
			const todos = await PlazoDatasetEjemplo.find(filter).sort({ harvestedAt: -1 }).limit(2000).lean();
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
				PlazoDatasetEjemplo.find(filter).sort({ harvestedAt: -1 }).skip(skip).limit(limit).lean(),
				PlazoDatasetEjemplo.countDocuments(filter),
			]);
		}
		return paginated(res, data, total, page, limit);
	} catch (error) {
		return fail(res, "listDataset", error);
	}
};

// PATCH /admin/plazos/dataset/:id/revision — confirmar o descartar un ejemplo.
// Los descartados se excluyen de stats y candidatos (depuración sin borrar).
exports.revisarDatasetEjemplo = async (req, res) => {
	try {
		const { estado, notas } = req.body || {};
		if (!["confirmado", "descartado", "sin_revisar"].includes(estado)) {
			return res.status(400).json({ success: false, message: "estado debe ser confirmado | descartado | sin_revisar" });
		}
		const doc = await PlazoDatasetEjemplo.findByIdAndUpdate(
			req.params.id,
			{ $set: { "revision.estado": estado, "revision.notas": notas || "", "revision.revisadoAt": new Date() } },
			{ new: true }
		).lean();
		if (!doc) return res.status(404).json({ success: false, message: "Ejemplo no encontrado" });
		logger.info(`[plazos] dataset ${req.params.id} → ${estado} por user ${req.userId}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "revisarDatasetEjemplo", error);
	}
};

// GET /admin/plazos/dataset/stats
exports.statsDataset = async (req, res) => {
	try {
		const noDescartado = { "revision.estado": { $ne: "descartado" } };
		const [total, conPlazo, descartados, porFuero, porActo] = await Promise.all([
			PlazoDatasetEjemplo.countDocuments(noDescartado),
			PlazoDatasetEjemplo.countDocuments({ sinPlazo: false, ...noDescartado }),
			PlazoDatasetEjemplo.countDocuments({ "revision.estado": "descartado" }),
			PlazoDatasetEjemplo.aggregate([
				{ $match: noDescartado },
				{ $group: { _id: "$fuero", n: { $sum: 1 }, conPlazo: { $sum: { $cond: ["$sinPlazo", 0, 1] } } } },
			]),
			PlazoDatasetEjemplo.aggregate([
				{ $match: { sinPlazo: false, ...noDescartado } },
				{ $group: { _id: "$acto", n: { $sum: 1 } } },
				{ $sort: { n: -1 } },
			]),
		]);
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

		const grupos = await PlazoDatasetEjemplo.aggregate([
			{ $match: { sinPlazo: false, plazoDias: { $ne: null }, "revision.estado": { $ne: "descartado" } } },
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
		]);

		const reglas = await PlazoNormativa.find({ habilitado: true }).sort({ prioridad: 1 }).lean();
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

// PATCH /admin/plazos/feriados/:id — editar (verificar/deshabilitar/notas).
exports.updateFeriado = async (req, res) => {
	try {
		const EDITABLE = ["tipo", "descripcion", "fuente", "verificado", "habilitado", "notas"];
		const $set = {};
		for (const k of EDITABLE) if (req.body[k] !== undefined) $set[k] = req.body[k];
		if (!Object.keys($set).length) return res.status(400).json({ success: false, message: "Nada para actualizar" });

		const doc = await FeriadoJudicial.findByIdAndUpdate(req.params.id, { $set }, { new: true, runValidators: true }).lean();
		if (!doc) return res.status(404).json({ success: false, message: "Feriado no encontrado" });
		FeriadoJudicial.clearSetCache();
		logger.info(`[plazos] feriado ${req.params.id} editado por user ${req.userId}: ${Object.keys($set).join(",")}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "updateFeriado", error);
	}
};
