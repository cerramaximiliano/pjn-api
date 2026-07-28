/**
 * plazosWorkerConfigController.js — Configuración + estado del plazos-worker
 * (vista admin Workers PJN → Plazos). Singleton 'global' en la colección
 * `plazos-worker-config` (modelo ConfiguracionPlazosWorker de pjn-models).
 *
 * El worker relee la config en cada ciclo: enabled/params aplican al vuelo y
 * un cambio de cronPattern se re-agenda en caliente (sin restart PM2).
 * Solo tiene datos reales en la instancia LOCAL de pjn-api (worker_01).
 */
const pjn = require("pjn-models");
const { logger } = require("../config/pino");

const { ConfiguracionPlazosWorker, PlazoNotificacion } = pjn;

const fail = (res, scope, error) => {
	logger.error(`[plazos-worker-config] ${scope}: ${error.message}`);
	return res.status(500).json({ success: false, message: error.message });
};

// GET /plazos-worker-config — doc completo (config + heartbeat + stats).
exports.getFull = async (req, res) => {
	try {
		const doc = await ConfiguracionPlazosWorker.getGlobal();
		return res.json({ success: true, data: doc.toObject() });
	} catch (error) {
		return fail(res, "getFull", error);
	}
};

const EDITABLE = ["enabled", "cronPattern", "lockTimeoutMinutes", "maxRetries", "downloadTimeoutMs", "scanCharsPerPageThreshold"];

// PATCH /plazos-worker-config/settings
exports.updateSettings = async (req, res) => {
	try {
		const $set = {};
		for (const k of EDITABLE) if (req.body[k] !== undefined) $set[k] = req.body[k];
		if (!Object.keys($set).length) return res.status(400).json({ success: false, message: "Nada para actualizar" });
		// Validación liviana (5-6 tokens cron). La validación estricta la hace
		// el worker con cron.validate antes de re-agendar — un patrón inválido
		// no rompe nada: el worker mantiene el cron anterior.
		if ($set.cronPattern !== undefined) {
			const tokens = String($set.cronPattern).trim().split(/\s+/);
			if (tokens.length < 5 || tokens.length > 6 || !tokens.every((t) => /^[\d*,\-/A-Za-z?#]+$/.test(t))) {
				return res.status(400).json({ success: false, message: `cronPattern inválido: ${$set.cronPattern}` });
			}
		}

		const doc = await ConfiguracionPlazosWorker.findByIdAndUpdate("global", { $set }, {
			new: true,
			upsert: true,
			runValidators: true,
			setDefaultsOnInsert: true,
		}).lean();
		logger.info(`[plazos-worker-config] settings por user ${req.userId}: ${Object.keys($set).join(",")}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "updateSettings", error);
	}
};

// GET /plazos-worker-config/status — heartbeat + cola + stats acumuladas.
exports.getStatus = async (req, res) => {
	try {
		const [doc, cola] = await Promise.all([
			ConfiguracionPlazosWorker.getGlobal(),
			PlazoNotificacion.aggregate([{ $group: { _id: "$processingStatus", count: { $sum: 1 } } }]),
		]);
		const obj = doc.toObject();
		const now = Date.now();
		const lastCycle = obj.heartbeat?.lastCycleAt ? new Date(obj.heartbeat.lastCycleAt).getTime() : null;
		return res.json({
			success: true,
			data: {
				enabled: obj.enabled,
				cronPattern: obj.cronPattern,
				heartbeat: obj.heartbeat,
				// vivo = corrió un ciclo hace menos de 5 min (cron default */1)
				alive: lastCycle !== null && now - lastCycle < 5 * 60 * 1000,
				stats: obj.stats,
				cola: Object.fromEntries(cola.map((s) => [s._id, s.count])),
			},
		});
	} catch (error) {
		return fail(res, "getStatus", error);
	}
};

// POST /plazos-worker-config/reset-stats
exports.resetStats = async (req, res) => {
	try {
		const doc = await ConfiguracionPlazosWorker.findByIdAndUpdate(
			"global",
			{ $set: { stats: { processed: 0, computed: 0, parsed: 0, extracted: 0, ocrNeeded: 0, notPdf: 0, failed: 0 } } },
			{ new: true }
		).lean();
		logger.info(`[plazos-worker-config] stats reseteadas por user ${req.userId}`);
		return res.json({ success: true, data: doc });
	} catch (error) {
		return fail(res, "resetStats", error);
	}
};
