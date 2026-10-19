/**
 * plazosPendientesController.js — "Pendientes del usuario" del feature de plazos automáticos.
 * GET /api/admin/plazos/pendientes — solo lectura, solo base de usuarios (Atlas).
 *
 * Junta en una respuesta todo lo que depende del usuario (el dueño del producto): decisiones P3–P8 con
 * sus requisitos medidos, reglas que retienen plazos, carpetas sin parte elegida, entregas sin feedback
 * y credenciales de la bandeja con errores. Doc: la-ads/docs/producto/plazos-automaticos.md §14.
 */
const mongoose = require("mongoose");
const pjn = require("pjn-models");
const { logger } = require("../config/pino");

const { PlazoNotificacion, PlazoNormativa, FeriadoJudicial } = pjn;

const MAX_MS = 20000;
const TTL = 60 * 1000;
const FRONT = "https://www.lawanalytics.app";
const LIMITE = 200;

const COLECCION_POR_TIPO = {
	CausasCivil: "causas-civil", CausasComercial: "causas-comercial", CausasTrabajo: "causas-trabajo",
	CausasSegSoc: "causas-segsocial", CausasSegSocial: "causas-segsocial",
};
const FUERO_POR_TIPO = { CausasCivil: "CIV", CausasComercial: "COM", CausasTrabajo: "CNT", CausasSegSoc: "CSS", CausasSegSocial: "CSS" };
const ACCIONES_FEEDBACK = /^(evento|aviso_|sugerencia_)/;

let cache = null;

const agg = (col, pipeline) => col.aggregate(pipeline, { maxTimeMS: MAX_MS, allowDiskUse: true }).toArray();

async function armar() {
	const db = mongoose.connection.db;
	const hoyDia = new Date().toISOString().slice(0, 10);
	const hace7d = new Date(Date.now() - 7 * 24 * 3600e3);
	const U = { origen: "usuario" };

	// Usuarios con la función activa (la entrega real depende además de plazos-folders-config.userFilter).
	const activos = await db.collection("usuarios")
		.find({ "plazosAutomaticos.activo": true }, { projection: { email: 1 } }).toArray();
	const emailDe = new Map(activos.map((u) => [String(u._id), u.email || null]));
	const idsActivos = activos.map((u) => u._id);

	const folders = idsActivos.length
		? await db.collection("folders").find(
			{ userId: { $in: idsActivos }, causaId: { $ne: null }, pjn: true },
			{ projection: { userId: 1, causaId: 1, causaType: 1, plazosParte: 1, folderName: 1 } },
		).toArray()
		: [];
	const causasEntrega = [...new Set(folders.map((f) => String(f.causaId)))].map((id) => new mongoose.Types.ObjectId(id));

	// ── reglasSinVerificar ──────────────────────────────────────────────────
	// Mismo filtro que soloConfiables de plazos-folders-worker: computed + norma no verificada + sin validación.
	const sinVerificar = {
		...U, processingStatus: "computed", "plazo.fuente": "norma",
		"plazo.norma.verificado": { $ne: true }, "validacion.estado": null,
	};
	const [porRegla, reglasDoc, ultimas7] = await Promise.all([
		agg(db.collection("plazos-notificaciones"), [
			{ $match: { ...sinVerificar, ...(causasEntrega.length ? { causaId: { $in: causasEntrega } } : { _id: null }) } },
			{ $group: { _id: "$plazo.norma.clave", label: { $first: "$plazo.norma.label" }, fueros: { $addToSet: "$fuero" }, retenidos: { $sum: 1 } } },
			{ $sort: { retenidos: -1 } },
		]),
		PlazoNormativa.find({}, { label: 1, verificado: 1, habilitado: 1 }).lean().maxTimeMS(MAX_MS),
		agg(db.collection("plazos-notificaciones"), [
			{ $match: { ...sinVerificar, detectedAt: { $gte: hace7d }, ...(causasEntrega.length ? { causaId: { $in: causasEntrega } } : { _id: null }) } },
			{ $group: { _id: "$plazo.norma.clave", n: { $sum: 1 } } },
		]),
	]);
	const ult7 = new Map(ultimas7.map((x) => [x._id, x.n]));
	const labelDe = new Map(reglasDoc.map((r) => [String(r._id), r.label]));
	const reglasSinVerificar = porRegla.map((r) => ({
		normaId: r._id,
		label: r.label || labelDe.get(String(r._id)) || String(r._id),
		fueros: (r.fueros || []).sort(),
		retenidos: r.retenidos,
		ultimos7d: ult7.get(r._id) || 0,
	}));
	const reglasTotal = reglasDoc.length;
	const reglasVerificadas = reglasDoc.filter((r) => r.verificado).length;

	// ── carpetasSinParte ────────────────────────────────────────────────────
	const sinParte = folders.filter((f) => FUERO_POR_TIPO[f.causaType] && !f.plazosParte?.fuente).slice(0, LIMITE);
	const carpetasSinParte = [];
	if (sinParte.length) {
		const porTipo = new Map();
		for (const f of sinParte) {
			if (!porTipo.has(f.causaType)) porTipo.set(f.causaType, []);
			porTipo.get(f.causaType).push(f.causaId);
		}
		const causas = new Map();
		await Promise.all([...porTipo].map(async ([tipo, ids]) => {
			const rows = await db.collection(COLECCION_POR_TIPO[tipo]).find(
				{ _id: { $in: ids } }, { projection: { number: 1, year: 1, caratula: 1 } },
			).toArray();
			for (const c of rows) causas.set(String(c._id), c);
		}));
		const causaIds = sinParte.map((f) => f.causaId);
		const [ivs, ceds] = await Promise.all([
			agg(db.collection("intervinientes"), [{ $match: { causaId: { $in: causaIds } } }, { $group: { _id: "$causaId", n: { $sum: 1 } } }]),
			agg(db.collection("plazos-notificaciones"), [{ $match: { ...U, causaId: { $in: causaIds } } }, { $group: { _id: "$causaId", n: { $sum: 1 } } }]),
		]);
		const ivPor = new Map(ivs.map((x) => [String(x._id), x.n]));
		const cedPor = new Map(ceds.map((x) => [String(x._id), x.n]));
		for (const f of sinParte) {
			const c = causas.get(String(f.causaId));
			carpetasSinParte.push({
				folderId: String(f._id),
				userId: String(f.userId),
				email: emailDe.get(String(f.userId)) || null,
				causaId: String(f.causaId),
				fuero: FUERO_POR_TIPO[f.causaType],
				expediente: c?.number ? `${c.number}/${c.year}` : null,
				caratula: c?.caratula || f.folderName || null,
				intervinientes: ivPor.get(String(f.causaId)) || 0,
				parteDetectada: null, // pendiente: plazosParteService vive en el hub (la detección se hace allá)
				cedulasRecientes: cedPor.get(String(f.causaId)) || 0,
				linkFront: `${FRONT}/apps/folders/details/${f._id}`,
			});
		}
		carpetasSinParte.sort((a, b) => b.cedulasRecientes - a.cedulasRecientes);
	}
	const carpetasSinParteTotal = folders.filter((f) => FUERO_POR_TIPO[f.causaType] && !f.plazosParte?.fuente).length;

	// ── entregasSinFeedback ─────────────────────────────────────────────────
	const entregados = idsActivos.length
		? await db.collection("plazos-notificaciones").find(
			{ ...U, "validacion.estado": "validada", "validacion.resultados.userId": { $in: idsActivos } },
			{ projection: { causaId: 1, sourceId: 1, validacion: 1, feedbackUsuarios: 1, "plazo.vencimiento": 1 } },
		).sort({ "validacion.syncedAt": -1 }).limit(500).maxTimeMS(MAX_MS).toArray()
		: [];
	const entregasSinFeedback = [];
	let totalEntregas = 0;
	for (const p of entregados) {
		const fb = Array.isArray(p.feedbackUsuarios) ? p.feedbackUsuarios : [];
		for (const r of p.validacion?.resultados || []) {
			if (r.dryRun || !ACCIONES_FEEDBACK.test(r.accion || "")) continue;
			totalEntregas++;
			if (fb.some((x) => String(x.userId) === String(r.userId))) continue;
			if (entregasSinFeedback.length >= LIMITE) continue;
			entregasSinFeedback.push({
				plazoNotificacionId: String(p._id),
				cedula: `${p.causaId}:${p.sourceId}`,
				folderId: r.folderId ? String(r.folderId) : null,
				userId: r.userId ? String(r.userId) : null,
				email: emailDe.get(String(r.userId)) || null,
				accion: r.accion,
				confirmadoPor: r.confirmadoPor || null,
				entregadoAt: r.actualizadoAt || p.validacion.syncedAt || null,
				vencimiento: p.plazo?.vencimiento || null,
			});
		}
	}

	// ── credencialesBandeja ─────────────────────────────────────────────────
	const creds = await db.collection("bandeja-sync-state").find(
		{ consecutiveErrors: { $gt: 0 } },
		{ projection: { credentialsId: 1, userId: 1, consecutiveErrors: 1, lastError: 1, lastSuccessAt: 1, lastRunAt: 1 } },
	).sort({ consecutiveErrors: -1 }).limit(LIMITE).toArray();
	const faltan = creds.filter((c) => c.userId && !emailDe.has(String(c.userId))).map((c) => c.userId);
	if (faltan.length) {
		const us = await db.collection("usuarios").find({ _id: { $in: faltan } }, { projection: { email: 1 } }).toArray();
		for (const u of us) emailDe.set(String(u._id), u.email || null);
	}
	const credencialesBandeja = creds.map((c) => ({
		credentialsId: String(c.credentialsId),
		userId: c.userId ? String(c.userId) : null,
		email: c.userId ? emailDe.get(String(c.userId)) || null : null,
		consecutiveErrors: c.consecutiveErrors,
		code: c.lastError?.code || null,
		lastSuccessAt: c.lastSuccessAt || null,
		lastRunAt: c.lastRunAt || null,
	}));

	// ── decisiones ──────────────────────────────────────────────────────────
	const [eventos, avisosEntregados, respuestas, muestrasRevision, feriadosSinVerificar, feriadosTotal] = await Promise.all([
		db.collection("events").countDocuments({ origen: "plazos-automaticos" }),
		db.collection("foldernotifications").countDocuments({ user: "plazos-automaticos" }),
		db.collection("plazos-notificaciones").countDocuments({ ...U, "feedbackUsuarios.0": { $exists: true } }),
		db.collection("plazos-revision-legal").estimatedDocumentCount().catch(() => 0),
		FeriadoJudicial.countDocuments({ verificado: { $ne: true }, habilitado: { $ne: false }, fecha: { $gte: hoyDia } }).maxTimeMS(MAX_MS),
		FeriadoJudicial.countDocuments({ fecha: { $gte: hoyDia } }).maxTimeMS(MAX_MS),
	]);
	const retenidosTotal = reglasSinVerificar.reduce((a, r) => a + r.retenidos, 0);
	const reglasOk = reglasSinVerificar.length === 0;
	const feriadosOk = feriadosTotal > 0 && feriadosSinVerificar === 0;
	const conEvento = eventos >= 1;
	const conRespuesta = respuestas >= 1;
	const estadoDe = (ok, requisitos) => (ok ? "hecho" : requisitos.every((r) => r.ok) ? "listo_para_decidir" : "bloqueado");
	const decisiones = [];
	{
		const requisitos = [
			{ texto: "Al menos 1 evento entregado", ok: conEvento },
			{ texto: "Al menos 1 respuesta a «¿es correcto?»", ok: conRespuesta },
		];
		decisiones.push({
			id: "P3", titulo: "Prueba real interna: dar por validada la entrega",
			estado: conEvento && conRespuesta ? "listo_para_decidir" : "esperando", requisitos,
			impacto: { texto: "Habilita pasar a la etapa 3 (entrega real a usuarios)", n: eventos },
			accion: { texto: conEvento ? "Responder «¿es correcto?» en los avisos y eventos entregados" : "Elegir tu parte en las carpetas para que lleguen eventos", link: "?tab=pendientes" },
		});
	}
	{
		const requisitos = [
			{ texto: `Reglas verificadas (${reglasVerificadas}/${reglasTotal}) y ninguna retiene plazos`, ok: reglasOk },
			{ texto: "Muestras de revisión legal creadas", ok: muestrasRevision > 0 },
		];
		decisiones.push({
			id: "P4", titulo: "Revisión legal de las reglas",
			estado: reglasOk ? "hecho" : muestrasRevision > 0 ? "listo_para_decidir" : "bloqueado", requisitos,
			impacto: { texto: "Plazos retenidos por reglas sin verificar", n: retenidosTotal },
			accion: { texto: "Revisar la muestra de cada regla y verificarla", link: "?tab=normativa" },
		});
	}
	{
		const requisitos = [
			{ texto: "P1: primeras cédulas reales verificadas", ok: true },
			{ texto: "P2: control de 7 días terminado", ok: new Date() >= new Date("2026-10-19T00:00:00-03:00") },
		];
		decisiones.push({
			id: "P5", titulo: "Etapa 2: calcular las cédulas de todos los usuarios",
			estado: estadoDe(false, requisitos), requisitos,
			impacto: { texto: "Las cédulas de usuarios reales dejan de quedar pending" },
			accion: { texto: "Cambiar el alcance del cálculo", link: "/admin/workers/plazos?base=usuarios" },
		});
	}
	{
		const requisitos = [
			{ texto: "P3: entrega interna validada", ok: conEvento && conRespuesta },
			{ texto: "P4: reglas verificadas", ok: reglasOk },
		];
		decisiones.push({
			id: "P6", titulo: "Etapa 3: entrega real + copy + beta 5–10 usuarios",
			estado: estadoDe(false, requisitos), requisitos,
			impacto: { texto: "Los usuarios que activaron la función empiezan a recibir plazos" },
			accion: { texto: "Quitar dryRun y el filtro de prueba de plazos-folders-config", link: "/admin/workers/plazos?base=usuarios" },
		});
	}
	{
		const requisitos = [
			{ texto: "Reglas revisadas", ok: reglasOk },
			{ texto: "Feriados revisados (ninguno vigente sin verificar)", ok: feriadosOk },
		];
		decisiones.push({
			id: "P8", titulo: "Pasar reglas y feriados a Atlas",
			estado: estadoDe(false, requisitos), requisitos,
			impacto: { texto: "Feriados vigentes sin verificar", n: feriadosSinVerificar },
			accion: { texto: "La base maestra hoy es rs0 (la que usan los workers); Atlas es la copia del 10/10. Re-sincronizar rs0 → Atlas y PLAZOS_REFS=atlas (deploy)" },
		});
	}

	return {
		generadoAt: new Date(),
		resumen: {
			total: decisiones.filter((d) => d.estado === "listo_para_decidir").length +
				reglasSinVerificar.length + carpetasSinParteTotal + entregasSinFeedback.length + credencialesBandeja.length,
			decisionesListas: decisiones.filter((d) => d.estado === "listo_para_decidir").length,
			reglasSinVerificar: reglasSinVerificar.length,
			plazosRetenidos: retenidosTotal,
			carpetasSinParte: carpetasSinParteTotal,
			entregasSinFeedback: entregasSinFeedback.length,
			credencialesBandeja: credencialesBandeja.length,
			cuentasActivas: idsActivos.length,
			eventos, avisos: avisosEntregados, respuestas, entregas: totalEntregas,
		},
		decisiones, reglasSinVerificar, carpetasSinParte, entregasSinFeedback, credencialesBandeja,
	};
}

// GET /admin/plazos/pendientes
exports.pendientes = async (req, res) => {
	if (process.env.MONGO_TARGET === "rs0") {
		return res.status(400).json({ success: false, message: "Los pendientes del usuario son de la base de usuarios (Atlas)" });
	}
	try {
		if (!cache || Date.now() - cache.at > TTL || req.query.fresh === "1") cache = { at: Date.now(), data: await armar() };
		return res.json({ success: true, data: cache.data });
	} catch (error) {
		logger.error(`[plazos] pendientes: ${error.message}`);
		const timeout = error.code === 50 || error.codeName === "MaxTimeMSExpired";
		return res.status(timeout ? 504 : 500).json({ success: false, message: timeout ? "La consulta tardó demasiado (más de 20 s)." : error.message });
	}
};
