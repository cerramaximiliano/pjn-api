/**
 * plazosRevisionLegalController.js — Revisión legal de los plazos calculados (fase F0 de
 * "plazos automáticos para usuarios", ver la-ads/docs/producto/plazos-revision-legal.md).
 *
 * Un abogado revisa una muestra estratificada de cédulas con plazo calculado y deja su
 * veredicto (destinatario, acto, si el plazo y el vencimiento son correctos). La precisión
 * por estrato decide qué se les propone a los usuarios.
 *
 * Colección propia `plazos-revision-legal` (no toca el schema de PlazoNotificacion, que es
 * de pjn-models): cada ítem guarda una FOTO del cálculo al crear la muestra, así el
 * veredicto sigue valiendo aunque la cédula se reprocese después.
 *
 * Funciona igual en las dos instancias de pjn-api: la de caché (rs0, desarrollo) y la de
 * Atlas (cédulas de usuarios, producción). La admin elige la base con su selector.
 */
const mongoose = require("mongoose");
const { logger } = require("../config/pino");
const { gunzipText } = require("../utils/sentencia-text");

const COL = "plazos-revision-legal";
const MAX_MS = 120000; // crear la muestra hace $sample sobre la colección grande
let indicesListos = false;

const col = () => mongoose.connection.db.collection(COL);
const notifs = () => mongoose.connection.db.collection("plazos-notificaciones");

async function asegurarIndices() {
	if (indicesListos) return;
	await col().createIndex({ muestra: 1, notificacionId: 1 }, { unique: true });
	await col().createIndex({ muestra: 1, estado: 1 });
	indicesListos = true;
}

const fail = (res, scope, error) => {
	logger.error(`[plazos-revision-legal] ${scope}: ${error.message}`);
	if (error.code === 50) return res.status(504).json({ success: false, message: "La consulta tardó demasiado." });
	return res.status(500).json({ success: false, message: error.message });
};

const PROY = { fuero: 1, number: 1, year: 1, caratula: 1, tipoNotificacion: 1, processingStatus: 1, movimiento: 1, plazo: 1, "extraccion.menciones": 1, detectedAt: 1 };

function foto(d, estrato) {
	const p = d.plazo || {};
	const nr = p.norma || {};
	const mejor = (d.extraccion?.menciones || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
	return {
		estrato,
		fuero: d.fuero,
		number: d.number,
		year: d.year,
		caratula: d.caratula || null,
		tipoNotificacion: d.tipoNotificacion || null,
		processingStatus: d.processingStatus,
		movimiento: { fecha: d.movimiento?.fecha || null, tipo: d.movimiento?.tipo || null, detalle: d.movimiento?.detalle || null, url: d.movimiento?.url || null },
		plazo: {
			fuente: p.fuente || null,
			confianza: p.confianza || null,
			regla: nr.label || null,
			reglaClave: nr.clave || null,
			cita: nr.cita || null,
			reglaVerificada: nr.verificado == null ? null : !!nr.verificado,
			fragmento: nr.snippet || mejor?.snippet || null,
			plazoDias: p.plazoDias ?? null,
			tipoPlazo: p.tipoPlazo || null,
			fechaNotificacion: p.fechaNotificacion || null,
			fechaNotificacionFuente: p.fechaNotificacionFuente || null,
			perfeccionamiento: p.perfeccionamiento || null,
			inicioPlazo: p.inicioPlazo || null,
			vencimiento: p.vencimiento || null,
			vencimientoConGracia: p.vencimientoConGracia || null,
			feriadosAplicados: p.feriadosAplicados || [],
		},
	};
}

// POST /admin/plazos/revision-legal/muestras
// body: { nombre?, desde? (YYYY-MM-DD), textoAlta?, textoMedia?, porReglaNoVerificada?, porReglaVerificada?, sinPlazo? }
exports.crearMuestra = async (req, res) => {
	try {
		await asegurarIndices();
		const b = req.body || {};
		const n = (k, d) => Math.min(Math.max(parseInt(b[k], 10) || d, 0), 100);
		const desde = new Date(b.desde || Date.now() - 120 * 864e5);
		const muestra = String(b.nombre || `${b.regla ? `regla-${String(b.regla).slice(0, 30)}` : "muestra"}-${new Date().toISOString().slice(0, 16).replace("T", "-")}`).slice(0, 60);
		if (await col().findOne({ muestra })) return res.status(409).json({ success: false, message: `Ya existe una muestra "${muestra}"` });

		const sample = (match, size) =>
			size > 0 ? notifs().aggregate([{ $match: { detectedAt: { $gte: desde }, ...match } }, { $sample: { size } }, { $project: PROY }], { allowDiskUse: true, maxTimeMS: MAX_MS }).toArray() : [];
		const items = [];
		const add = (estrato, docs) => docs.forEach((d) => items.push({ d, estrato }));
		const soloUsuarios = process.env.MONGO_TARGET !== "rs0" ? { origen: "usuario" } : {};

		// Muestra de UNA regla (plazo.norma.clave): N cédulas calculadas con esa regla, para revisarla antes de verificarla.
		if (b.regla) {
			const clave = String(b.regla).slice(0, 80);
			const cantidad = Math.min(Math.max(parseInt(b.cantidad, 10) || 15, 1), 100);
			const docsRegla = await sample({ ...soloUsuarios, processingStatus: "computed", "plazo.fuente": "norma", "plazo.norma.clave": clave }, cantidad);
			if (!docsRegla.length) return res.status(404).json({ success: false, message: `No hay cédulas calculadas con la regla "${clave}" en el período elegido` });
			const ver = docsRegla[0].plazo?.norma?.verificado ? "verificada" : "NO verificada";
			add(`regla ${ver} · ${docsRegla[0].plazo?.norma?.label || clave}`, docsRegla);
		} else {
		add("texto · confianza alta", await sample({ processingStatus: "computed", "plazo.fuente": "texto", "plazo.confianza": "alta" }, n("textoAlta", 22)));
		add("texto · confianza media", await sample({ processingStatus: "computed", "plazo.fuente": "texto", "plazo.confianza": "media" }, n("textoMedia", 8)));
		const reglas = await notifs()
			.aggregate([{ $match: { detectedAt: { $gte: desde }, processingStatus: "computed", "plazo.fuente": "norma" } }, { $group: { _id: { l: "$plazo.norma.label", v: "$plazo.norma.verificado" }, n: { $sum: 1 } } }], { maxTimeMS: MAX_MS })
			.toArray();
		for (const r of reglas) {
			const size = r._id.v ? n("porReglaVerificada", 2) : n("porReglaNoVerificada", 6);
			add(`regla ${r._id.v ? "verificada" : "NO verificada"} · ${r._id.l}`, await sample({ processingStatus: "computed", "plazo.fuente": "norma", "plazo.norma.label": r._id.l }, size));
		}
		add("sin plazo (parsed)", await sample({ processingStatus: "parsed" }, n("sinPlazo", 12)));
		}

		if (!items.length) return res.status(404).json({ success: false, message: "No hay cédulas en el período elegido" });
		const ahora = new Date();
		const docs = items.map(({ d, estrato }) => ({
			muestra,
			notificacionId: d._id,
			...foto(d, estrato),
			estado: "pendiente",
			veredicto: null,
			creadoEn: ahora,
			creadoPor: req.userId || null,
		}));
		await col().insertMany(docs, { ordered: false });
		logger.info(`[plazos-revision-legal] muestra "${muestra}" creada con ${docs.length} cédulas por user ${req.userId}`);
		return res.json({ success: true, data: { muestra, total: docs.length } });
	} catch (error) {
		return fail(res, "crearMuestra", error);
	}
};

// GET /admin/plazos/revision-legal/muestras
exports.listarMuestras = async (req, res) => {
	try {
		const data = await col()
			.aggregate([
				{ $group: { _id: "$muestra", total: { $sum: 1 }, revisadas: { $sum: { $cond: [{ $eq: ["$estado", "revisada"] }, 1, 0] } }, creadoEn: { $min: "$creadoEn" } } },
				{ $sort: { creadoEn: -1 } },
			])
			.toArray();
		return res.json({ success: true, data: data.map((m) => ({ muestra: m._id, total: m.total, revisadas: m.revisadas, creadoEn: m.creadoEn })) });
	} catch (error) {
		return fail(res, "listarMuestras", error);
	}
};

// GET /admin/plazos/revision-legal?muestra=&estado=&estrato=&page=&limit=
exports.listar = async (req, res) => {
	try {
		if (!req.query.muestra) return res.status(400).json({ success: false, message: "Falta muestra" });
		const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
		const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
		const filter = { muestra: String(req.query.muestra) };
		if (req.query.estado) filter.estado = String(req.query.estado);
		if (req.query.estrato) filter.estrato = String(req.query.estrato);
		const [data, total] = await Promise.all([
			col().find(filter).sort({ estrato: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
			col().countDocuments(filter),
		]);
		return res.json({
			success: true,
			count: total,
			pagination: { currentPage: page, totalPages: Math.ceil(total / limit) || 1, limit, hasNextPage: page * limit < total, hasPrevPage: page > 1 },
			data,
		});
	} catch (error) {
		return fail(res, "listar", error);
	}
};

// GET /admin/plazos/revision-legal/item/:id — ítem + texto de la cédula (de la notificación viva)
exports.obtener = async (req, res) => {
	try {
		if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id inválido" });
		const item = await col().findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
		if (!item) return res.status(404).json({ success: false, message: "No encontrado" });
		const n = await notifs().findOne({ _id: item.notificacionId }, { projection: { "extraccion.textExcerpt": 1, "extraccion.textExcerptGz": 1 }, maxTimeMS: 20000 });
		let texto = n?.extraccion?.textExcerpt ?? null;
		if (texto == null && n?.extraccion?.textExcerptGz != null) texto = gunzipText(n.extraccion.textExcerptGz);
		return res.json({ success: true, data: { ...item, textoCedula: texto } });
	} catch (error) {
		return fail(res, "obtener", error);
	}
};

// PATCH /admin/plazos/revision-legal/item/:id  body: { veredicto: {...} }
const SI_NO = (v) => (v === true || v === "si" ? true : v === false || v === "no" ? false : null);
exports.guardarVeredicto = async (req, res) => {
	try {
		if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "id inválido" });
		const v = req.body?.veredicto || {};
		const destinatarios = ["actor", "demandado", "perito", "tercero", "otro", null];
		const veredicto = {
			destinatario: destinatarios.includes(v.destinatario) ? v.destinatario : null,
			actoNotificado: v.actoNotificado ? String(v.actoNotificado).slice(0, 300) : null,
			plazoCorrecto: SI_NO(v.plazoCorrecto),
			plazoQueCorresponde: v.plazoQueCorresponde ? String(v.plazoQueCorresponde).slice(0, 120) : null,
			vencimientoCorrecto: SI_NO(v.vencimientoCorrecto),
			vencimientoQueCorresponde: v.vencimientoQueCorresponde ? String(v.vencimientoQueCorresponde).slice(0, 10) : null,
			comentario: v.comentario ? String(v.comentario).slice(0, 2000) : null,
		};
		const completo = veredicto.plazoCorrecto !== null && veredicto.vencimientoCorrecto !== null;
		const r = await col().findOneAndUpdate(
			{ _id: new mongoose.Types.ObjectId(req.params.id) },
			{ $set: { veredicto, estado: completo ? "revisada" : "pendiente", revisadoEn: new Date(), revisadoPor: req.userId || null } },
			{ returnDocument: "after" }
		);
		const doc = r?.value !== undefined ? r.value : r;
		if (!doc) return res.status(404).json({ success: false, message: "No encontrado" });
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "guardarVeredicto", error);
	}
};

// GET /admin/plazos/revision-legal/stats?muestra=
// Precisión por estrato y por regla (sobre las revisadas) + distribución de destinatarios.
exports.stats = async (req, res) => {
	try {
		if (!req.query.muestra) return res.status(400).json({ success: false, message: "Falta muestra" });
		const m = { muestra: String(req.query.muestra) };
		const grupo = (campo) =>
			col()
				.aggregate([
					{ $match: m },
					{
						$group: {
							_id: campo,
							total: { $sum: 1 },
							revisadas: { $sum: { $cond: [{ $eq: ["$estado", "revisada"] }, 1, 0] } },
							plazoOk: { $sum: { $cond: [{ $eq: ["$veredicto.plazoCorrecto", true] }, 1, 0] } },
							vencOk: { $sum: { $cond: [{ $eq: ["$veredicto.vencimientoCorrecto", true] }, 1, 0] } },
							ambosOk: { $sum: { $cond: [{ $and: [{ $eq: ["$veredicto.plazoCorrecto", true] }, { $eq: ["$veredicto.vencimientoCorrecto", true] }] }, 1, 0] } },
						},
					},
					{ $sort: { total: -1 } },
				])
				.toArray();
		const [porEstrato, porRegla, destinatarios, global] = await Promise.all([
			grupo("$estrato"),
			grupo({ $ifNull: ["$plazo.regla", { $concat: ["texto ", { $ifNull: ["$plazo.confianza", "?"] }] }] }),
			col().aggregate([{ $match: { ...m, estado: "revisada" } }, { $group: { _id: "$veredicto.destinatario", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
			grupo(null),
		]);
		const fmt = (rows) => rows.map((r) => ({ clave: r._id, total: r.total, revisadas: r.revisadas, plazoOk: r.plazoOk, vencOk: r.vencOk, ambosOk: r.ambosOk, precision: r.revisadas ? r.ambosOk / r.revisadas : null }));
		return res.json({ success: true, data: { global: fmt(global)[0] || null, porEstrato: fmt(porEstrato), porRegla: fmt(porRegla), destinatarios: destinatarios.map((d) => ({ destinatario: d._id, n: d.n })) } });
	} catch (error) {
		return fail(res, "stats", error);
	}
};

// GET /admin/plazos/beta — seguimiento de la beta de plazos automáticos (F5). Tiene datos en la
// instancia de Atlas (usuarios, cédulas de usuarios, sugerencias y feedback); en la de caché da ceros.
exports.beta = async (req, res) => {
	try {
		const db = mongoose.connection.db;
		const n = (col, q) => db.collection(col).countDocuments(q, { maxTimeMS: 20000 });
		const desde7 = new Date(Date.now() - 7 * 864e5);
		const N = db.collection("plazos-notificaciones");
		const [activos, conCuit, cedulas, cedulas7d, porStatus, eventos, eventosArchivados, porAccion, feedback, feedbackPorRegla, negativos] = await Promise.all([
			n("usuarios", { "plazosAutomaticos.activo": true }),
			n("usuarios", { "plazosAutomaticos.activo": true, "plazosAutomaticos.cuit": { $nin: [null, ""] } }),
			n("plazos-notificaciones", { origen: "usuario" }),
			n("plazos-notificaciones", { origen: "usuario", detectedAt: { $gte: desde7 } }),
			N.aggregate([{ $match: { origen: "usuario" } }, { $group: { _id: "$processingStatus", n: { $sum: 1 } } }], { maxTimeMS: 20000 }).toArray(),
			n("events", { origen: "plazos-automaticos" }),
			n("events", { origen: "plazos-automaticos", archivedAt: { $ne: null } }),
			db.collection("foldernotifications").aggregate([{ $match: { user: "plazos-automaticos" } }, { $group: { _id: "$code", n: { $sum: 1 } } }], { maxTimeMS: 20000 }).toArray(),
			N.aggregate([{ $match: { origen: "usuario", "feedbackUsuarios.0": { $exists: true } } }, { $unwind: "$feedbackUsuarios" }, { $group: { _id: "$feedbackUsuarios.correcto", n: { $sum: 1 } } }], { maxTimeMS: 20000 }).toArray(),
			N.aggregate(
				[
					{ $match: { origen: "usuario", "feedbackUsuarios.0": { $exists: true } } },
					{ $unwind: "$feedbackUsuarios" },
					{ $group: { _id: { $ifNull: ["$plazo.norma.label", { $concat: ["texto ", { $ifNull: ["$plazo.confianza", "?"] }] }] }, total: { $sum: 1 }, correctos: { $sum: { $cond: ["$feedbackUsuarios.correcto", 1, 0] } } } },
					{ $sort: { total: -1 } },
				],
				{ maxTimeMS: 20000 }
			).toArray(),
			N.aggregate(
				[
					{ $match: { origen: "usuario", "feedbackUsuarios.correcto": false } },
					{ $unwind: "$feedbackUsuarios" },
					{ $match: { "feedbackUsuarios.correcto": false } },
					{ $sort: { "feedbackUsuarios.at": -1 } },
					{ $limit: 20 },
					{ $project: { _id: 1, fuero: 1, regla: "$plazo.norma.label", fuente: "$plazo.fuente", vencimiento: "$plazo.vencimiento", comentario: "$feedbackUsuarios.comentario", at: "$feedbackUsuarios.at" } },
				],
				{ maxTimeMS: 20000 }
			).toArray(),
		]);
		// Bandeja del PJN (pjn-mis-causas) como fuente de cédulas: cobertura y cuánto llega a plazos.
		const hoyArt = new Date(new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10) + "T03:00:00Z");
		const B = db.collection("pjn-notifications");
		const [bTotal, bHoy, bCreds, credsElegibles, bEnPlazos, bPorStatus, evPorConfirmacion] = await Promise.all([
			B.estimatedDocumentCount(),
			n("pjn-notifications", { fecha: { $gte: hoyArt } }),
			B.distinct("credentialsId").then((x) => x.length),
			n("pjn-credentials", { enabled: true, verified: true, isValid: true }),
			n("plazos-notificaciones", { origen: "usuario", "bandeja.notificationIds.0": { $exists: true } }),
			N.aggregate([{ $match: { origen: "usuario", "bandeja.notificationIds.0": { $exists: true } } }, { $group: { _id: "$processingStatus", n: { $sum: 1 } } }], { maxTimeMS: 20000 }).toArray(),
			db.collection("events").aggregate([{ $match: { origen: "plazos-automaticos" } }, { $group: { _id: { $ifNull: ["$confirmadoPor", "sin dato"] }, n: { $sum: 1 } } }], { maxTimeMS: 20000 }).toArray(),
		]);
		const fb = Object.fromEntries(feedback.map((f) => [String(f._id), f.n]));
		const correctos = fb.true || 0, incorrectos = fb.false || 0;
		return res.json({
			success: true,
			data: {
				usuarios: { activos, conCuit },
				bandeja: {
					cedulas: bTotal,
					hoy: bHoy,
					credencialesConCedulas: bCreds,
					credencialesElegibles: credsElegibles,
					enPlazos: bEnPlazos,
					porStatus: Object.fromEntries(bPorStatus.map((x) => [x._id, x.n])),
					eventosPorConfirmacion: Object.fromEntries(evPorConfirmacion.map((x) => [x._id, x.n])),
				},
				cedulas: { total: cedulas, ultimos7d: cedulas7d, porStatus: Object.fromEntries(porStatus.map((s) => [s._id, s.n])) },
				sugerencias: { eventos, eventosArchivados, porAccion: Object.fromEntries(porAccion.map((a) => [String(a._id).replace(/^plazo-/, ""), a.n])) },
				feedback: { correctos, incorrectos, precision: correctos + incorrectos ? correctos / (correctos + incorrectos) : null, porRegla: feedbackPorRegla.map((r) => ({ clave: r._id, total: r.total, correctos: r.correctos })), negativos },
			},
		});
	} catch (error) {
		return fail(res, "beta", error);
	}
};
