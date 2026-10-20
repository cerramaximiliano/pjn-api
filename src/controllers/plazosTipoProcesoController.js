/**
 * plazosTipoProcesoController.js — Tipo de proceso de la causa (P21). Solo base de usuarios (Atlas).
 *
 * Algunos actos tienen plazo distinto según el trámite (ordinario | sumario, que incluye el sumarísimo). El tipo
 * de cada causa vive en `causas-tipo-proceso` (lo llena tipo-proceso-worker desde las resoluciones; el operador
 * puede fijarlo acá: su evidencia gana siempre). Las cédulas de actos que dependen del tipo y no lo tienen quedan en
 * processingStatus 'requiere_tipo_proceso' (sin plazo) hasta que se conoce; al fijarlo se re-encolan.
 * La lógica (registrarEvidencia, resolverTipo, reencolarCausa) es de pjn-models (tipoProceso, v1.67.0).
 */
const mongoose = require("mongoose");
const pjn = require("pjn-models");
const { logger } = require("../config/pino");

const MAX_MS = 20000;
const LIMITE = 200;
const COL_TIPO = "causas-tipo-proceso";
const db = () => mongoose.connection.db;

const soloAtlas = (req, res) => {
	if (process.env.MONGO_TARGET === "rs0") {
		res.status(400).json({ success: false, message: "El tipo de proceso es de la base de usuarios (Atlas)" });
		return false;
	}
	return true;
};

async function emailDelAdmin(req) {
	try {
		if (mongoose.isValidObjectId(req.userId)) {
			const u = await db().collection("usuarios").findOne({ _id: new mongoose.Types.ObjectId(req.userId) }, { projection: { email: 1 } });
			if (u?.email) return u.email;
		}
	} catch (_) { /* sin usuarios */ }
	return String(req.userId || "desconocido");
}

// GET /admin/plazos/tipo-proceso/pendientes — causas con cédulas que esperan el tipo de proceso.
exports.pendientes = async (req, res) => {
	if (!soloAtlas(req, res)) return;
	try {
		const plazos = db().collection("plazos-notificaciones");
		const grupos = await plazos.aggregate([
			{ $match: { origen: "usuario", processingStatus: "requiere_tipo_proceso" } },
			{ $sort: { detectedAt: -1 } },
			{ $group: {
				_id: "$causaId", fuero: { $first: "$fuero" }, number: { $first: "$number" }, year: { $first: "$year" }, caratula: { $first: "$caratula" },
				ultima: { $max: "$detectedAt" },
				cedulas: { $push: { id: "$_id", sourceId: "$sourceId", acto: "$extraccion.tipoProceso.acto", label: "$extraccion.tipoProceso.label", snippet: "$extraccion.tipoProceso.snippet", detectedAt: "$detectedAt" } },
			} },
			{ $sort: { ultima: -1 } },
			{ $limit: LIMITE },
		], { maxTimeMS: MAX_MS, allowDiskUse: true }).toArray();

		const causaIds = grupos.map((g) => g._id);
		const [tipos, folders] = await Promise.all([
			causaIds.length ? db().collection(COL_TIPO).find({ _id: { $in: causaIds } }).toArray() : [],
			causaIds.length ? db().collection("folders").find({ causaId: { $in: causaIds } }, { projection: { causaId: 1, userId: 1 } }).toArray() : [],
		]);
		const userIds = [...new Set(folders.map((f) => String(f.userId)))].filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
		const us = userIds.length ? await db().collection("usuarios").find({ _id: { $in: userIds } }, { projection: { email: 1 } }).toArray() : [];
		const emailDe = new Map(us.map((u) => [String(u._id), u.email || null]));
		const tipoDe = new Map(tipos.map((t) => [String(t._id), t]));
		const usuariosDe = new Map();
		for (const f of folders) {
			const k = String(f.causaId);
			const l = usuariosDe.get(k) || [];
			if (!l.some((u) => u.userId === String(f.userId))) l.push({ userId: String(f.userId), email: emailDe.get(String(f.userId)) || null });
			usuariosDe.set(k, l);
		}

		const total = (await plazos.aggregate([{ $match: { origen: "usuario", processingStatus: "requiere_tipo_proceso" } }, { $group: { _id: "$causaId" } }, { $count: "n" }], { maxTimeMS: MAX_MS }).toArray())[0]?.n || 0;
		const data = grupos.map((g) => {
			const t = tipoDe.get(String(g._id));
			return {
				causaId: String(g._id),
				fuero: g.fuero,
				expediente: g.number ? `${g.number}/${g.year}` : null,
				caratula: g.caratula || null,
				cedulas: g.cedulas.slice(0, 20).map((c) => ({ plazoNotificacionId: String(c.id), cedula: `${g._id}:${c.sourceId}`, acto: c.acto || null, label: c.label || null, snippet: c.snippet || null })),
				cantidadCedulas: g.cedulas.length,
				usuarios: usuariosDe.get(String(g._id)) || [],
				tipo: t?.tipo || null,
				fuente: t?.fuente || null,
				conflicto: !!t?.conflicto,
				sugerencia: !t?.tipo && t?.sugerencia?.tipo ? { tipo: t.sugerencia.tipo, motivo: t.sugerencia.motivo || null } : null,
				evidencias: (t?.evidencias || []).map((e) => ({ tipo: e.tipo, fuente: e.fuente, movementId: e.movementId || null, fecha: e.fecha || null, frase: e.frase || null, operador: e.operador || null })),
			};
		});
		return res.json({ success: true, total, data });
	} catch (error) {
		logger.error(`[plazos] tipo-proceso pendientes: ${error.message}`);
		return res.status(error.code === 50 ? 504 : 500).json({ success: false, message: error.message });
	}
};

// GET /admin/plazos/tipo-proceso/:causaId — documento y evidencias de la causa.
exports.obtener = async (req, res) => {
	if (!soloAtlas(req, res)) return;
	try {
		if (!mongoose.isValidObjectId(req.params.causaId)) return res.status(400).json({ success: false, message: "causaId inválido" });
		const doc = await db().collection(COL_TIPO).findOne({ _id: new mongoose.Types.ObjectId(req.params.causaId) });
		return res.json({ success: true, data: doc || null });
	} catch (error) {
		logger.error(`[plazos] tipo-proceso obtener: ${error.message}`);
		return res.status(500).json({ success: false, message: error.message });
	}
};

// PUT /admin/plazos/tipo-proceso/:causaId { tipo: 'ordinario'|'sumario'|'especial'|null }
// Fija la evidencia del operador (gana siempre) y re-encola las cédulas de la causa. tipo null = quita la del operador.
exports.fijar = async (req, res) => {
	if (!soloAtlas(req, res)) return;
	try {
		const { causaId: causaIdStr } = req.params;
		if (!mongoose.isValidObjectId(causaIdStr)) return res.status(400).json({ success: false, message: "causaId inválido" });
		const tipo = req.body?.tipo ?? null;
		if (![null, "ordinario", "sumario", "especial"].includes(tipo)) return res.status(400).json({ success: false, message: "tipo debe ser ordinario, sumario, especial o null" });
		const causaId = new mongoose.Types.ObjectId(causaIdStr);
		const to = pjn.tipoProceso;
		const colTipo = db().collection(COL_TIPO);
		const plazos = db().collection("plazos-notificaciones");

		const previo = await colTipo.findOne({ _id: causaId });
		const ref = await plazos.findOne({ causaId }, { projection: { fuero: 1 } });
		const fuero = ref?.fuero || previo?.fuero || null; // sin cédula, el fuero sale de causas-tipo-proceso
		if (!fuero || !to.FUEROS_TIPO_PROCESO.includes(fuero)) {
			return res.status(400).json({ success: false, message: `El tipo de proceso solo aplica a ${to.FUEROS_TIPO_PROCESO.join(", ")} (esta causa: ${fuero || "sin fuero"})` });
		}
		const quien = await emailDelAdmin(req);
		let resultado;
		if (tipo) {
			resultado = await to.registrarEvidencia(colTipo, { causaId, fuero, evidencia: { tipo, fuente: "operador", operador: quien, fecha: new Date() } });
		} else {
			// Quitar la evidencia del operador y recalcular con las detectadas.
			resultado = await to.quitarOperador(colTipo, causaId);
			if (!resultado) return res.json({ success: true, data: { tipo: null, reencoladas: 0 } });
		}
		// Copia el tipo vigente a la causa y a sus carpetas (causa.tipoProceso, folders.judFolder.tipoProceso).
		await to.propagarTipo(db(), { causaId, fuero, tipo: resultado.tipo, fuente: resultado.fuente, fecha: resultado.fecha });
		const reencoladas = await to.reencolarCausa(plazos, causaId);
		logger.info(`[plazos] tipo de proceso de ${causaIdStr} → ${tipo === null ? "sin dato del operador" : tipo} por ${quien} (${new Date().toISOString()}); ${reencoladas} cédula(s) re-encolada(s)`);
		return res.json({ success: true, data: { tipo: resultado.tipo ?? null, reencoladas } });
	} catch (error) {
		logger.error(`[plazos] tipo-proceso fijar: ${error.message}`);
		return res.status(500).json({ success: false, message: error.message });
	}
};

// GET /admin/plazos/tipo-proceso/cobertura — causas con tipo por fuero y fuente, y las sin tipo con sugerencia.
exports.cobertura = async (req, res) => {
	if (!soloAtlas(req, res)) return;
	try {
		const col = db().collection(COL_TIPO);
		const [porTipo, sinTipo, sugeridas] = await Promise.all([
			col.aggregate([{ $group: { _id: { fuero: "$fuero", tipo: "$tipo", fuente: "$fuente" }, n: { $sum: 1 } } }], { maxTimeMS: MAX_MS }).toArray(),
			col.countDocuments({ tipo: null }, { maxTimeMS: MAX_MS }),
			col.find({ tipo: null, "sugerencia.tipo": { $ne: null } }, { projection: { fuero: 1, sugerencia: 1, evidencias: 1 } }).sort({ updatedAt: -1 }).limit(LIMITE).maxTimeMS(MAX_MS).toArray(),
		]);
		const cols = pjn.tipoProceso.COLECCION_CAUSAS || {};
		const causas = new Map();
		await Promise.all(Object.entries(cols).map(async ([fuero, nombre]) => {
			const ids = sugeridas.filter((d) => d.fuero === fuero).map((d) => d._id);
			if (!ids.length) return;
			for (const c of await db().collection(nombre).find({ _id: { $in: ids } }, { projection: { number: 1, year: 1, caratula: 1, objeto: 1 } }).toArray()) causas.set(String(c._id), c);
		}));
		return res.json({
			success: true,
			data: {
				porTipo: porTipo.map((x) => ({ fuero: x._id.fuero, tipo: x._id.tipo, fuente: x._id.fuente, causas: x.n })),
				sinTipo,
				sugeridas: sugeridas.map((d) => {
					const c = causas.get(String(d._id));
					return { causaId: String(d._id), fuero: d.fuero, expediente: c?.number ? `${c.number}/${c.year}` : null, caratula: c?.caratula || null, objeto: c?.objeto || null, sugerencia: { tipo: d.sugerencia.tipo, motivo: d.sugerencia.motivo || null } };
				}),
			},
		});
	} catch (error) {
		logger.error(`[plazos] tipo-proceso cobertura: ${error.message}`);
		return res.status(error.code === 50 ? 504 : 500).json({ success: false, message: error.message });
	}
};
