/**
 * causasElegiblesUpdateController
 *
 * Expone las causas que el `update-movimientos-worker` (en pjn-workers-scraping)
 * considera elegibles para scraping de movimientos. Replica el mismo criterio
 * que usa el worker en src/tasks/update-movimientos-worker.js:
 *
 *   { update: true, verified: true, isValid: { $ne: false } }
 *
 * Esta API se levanta también en el server worker_01 (NODE_ENV=local) leyendo
 * la DB local — así la admin UI (vía VITE_WORKERS_URL) puede mostrar las causas
 * que el worker tiene en su caché local.
 */

const { CausasCivil, CausasComercial, CausasSegSoc, CausasTrabajo, updateFlagAudit } = require('pjn-models');
const { logger } = require('../config/pino');

// Mapping fuero (UI) → modelo Mongoose. Keep in sync con update-movimientos-worker.js
const FUERO_MODELS = {
	CIV: CausasCivil,
	COM: CausasComercial,
	CSS: CausasSegSoc,
	CNT: CausasTrabajo,
};

const ALL_FUEROS = Object.keys(FUERO_MODELS);

/**
 * Filtro base de elegibilidad (idéntico al del worker).
 */
const BASE_QUERY = { update: true, verified: true, isValid: { $ne: false } };

/**
 * GET /api/causas-elegibles-update/stats
 * Devuelve counts por fuero: total elegibles, en proceso (lock activo), en cooldown.
 */
exports.getStats = async (req, res) => {
	try {
		const now = new Date();
		const lockActive = { 'processingLock.expiresAt': { $gt: now } };
		const cooldownActive = { 'scrapingProgress.skipUntil': { $gt: now } };

		const stats = {};
		for (const fuero of ALL_FUEROS) {
			const Model = FUERO_MODELS[fuero];
			const [total, eligibles, processing, cooldown] = await Promise.all([
				// estimatedDocumentCount lee metadata: countDocuments({}) hacía COLLSCAN
				// de la colección entera (~87s en causas-civil con cache frío)
				Model.estimatedDocumentCount(),
				Model.countDocuments(BASE_QUERY),
				Model.countDocuments({ ...BASE_QUERY, ...lockActive }),
				Model.countDocuments({ ...BASE_QUERY, ...cooldownActive }),
			]);
			stats[fuero] = { total, eligibles, processing, cooldown };
		}

		res.json({ success: true, data: stats });
	} catch (error) {
		logger.error(`Error en getStats causas-elegibles-update: ${error.message}`);
		res.status(500).json({ success: false, message: 'Error al obtener stats', error: error.message });
	}
};

/**
 * GET /api/causas-elegibles-update?fuero=CIV&page=1&limit=20&search=...&onlyAvailable=false
 *
 * fuero: CIV | COM | CSS | CNT (requerido)
 * onlyAvailable: si true, excluye causas con lock activo o en cooldown
 */
exports.getList = async (req, res) => {
	try {
		const { fuero, page = 1, limit = 20, search, onlyAvailable = 'false' } = req.query;

		if (!fuero || !FUERO_MODELS[fuero]) {
			return res.status(400).json({
				success: false,
				message: `fuero inválido. Usar uno de: ${ALL_FUEROS.join(', ')}`,
			});
		}

		const Model = FUERO_MODELS[fuero];
		const now = new Date();
		const query = { ...BASE_QUERY };

		if (onlyAvailable === 'true') {
			query.$and = [
				{ $or: [{ processingLock: { $exists: false } }, { processingLock: null }, { 'processingLock.expiresAt': { $lt: now } }] },
				{ $or: [{ 'scrapingProgress.skipUntil': { $exists: false } }, { 'scrapingProgress.skipUntil': null }, { 'scrapingProgress.skipUntil': { $lt: now } }] },
			];
		}

		if (search && search.trim()) {
			const num = parseInt(search.trim(), 10);
			if (!Number.isNaN(num)) {
				// Búsqueda por número de expediente
				query.number = num;
			} else {
				// Búsqueda por carátula
				query.caratula = { $regex: search.trim(), $options: 'i' };
			}
		}

		const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

		const [docs, total] = await Promise.all([
			Model.find(query)
				.select(
					'number year fuero caratula objeto juzgado verified isValid update lastUpdate movimientosCount processingLock scrapingProgress folderIds userCausaIds userUpdatesEnabled source saij createdAt updatedAt',
				)
				.sort({ lastUpdate: 1 })
				.skip(skip)
				.limit(parseInt(limit, 10))
				.lean(),
			Model.countDocuments(query),
		]);

		// Enriquecer cada doc con flags computados (más fácil de renderizar en UI)
		const enriched = docs.map((d) => {
			const isProcessing = !!(d.processingLock?.expiresAt && new Date(d.processingLock.expiresAt) > now);
			const isInCooldown = !!(d.scrapingProgress?.skipUntil && new Date(d.scrapingProgress.skipUntil) > now);
			const enabledUsers = (d.userUpdatesEnabled || []).filter((u) => u.enabled).length;
			return {
				_id: d._id,
				number: d.number,
				year: d.year,
				fuero: d.fuero || fuero,
				caratula: d.caratula || null,
				objeto: d.objeto || null,
				juzgado: d.juzgado || null,
				verified: d.verified,
				isValid: d.isValid,
				update: d.update,
				lastUpdate: d.lastUpdate || null,
				movimientosCount: d.movimientosCount || 0,
				foldersLinked: (d.folderIds || []).length,
				usersLinked: (d.userCausaIds || []).length,
				usersWithUpdatesEnabled: enabledUsers,
				isProcessing,
				processingLock: isProcessing
					? {
							workerId: d.processingLock.workerId,
							lockedAt: d.processingLock.lockedAt,
							expiresAt: d.processingLock.expiresAt,
						}
					: null,
				isInCooldown,
				cooldownUntil: isInCooldown ? d.scrapingProgress.skipUntil : null,
				source: d.source,
				// Origen SAIJ: distingue quién creó/tocó el documento. createdViaSaij
				// no es confiable en datos viejos (lo pisaba markCausaAsSaij), así
				// que la UI infiere "creada por SAIJ" con source+verified.
				saij: d.saij?.isFromSaij
					? {
							isFromSaij: true,
							createdViaSaij: !!d.saij.createdViaSaij,
							fallosVinculados: (d.saij.saijSentenciaIds || []).length,
							linkedAt: d.saij.linkedAt || null,
						}
					: null,
				createdAt: d.createdAt,
				updatedAt: d.updatedAt,
			};
		});

		res.json({
			success: true,
			data: enriched,
			pagination: {
				page: parseInt(page, 10),
				limit: parseInt(limit, 10),
				total,
				pages: Math.ceil(total / parseInt(limit, 10)),
			},
		});
	} catch (error) {
		logger.error(`Error en getList causas-elegibles-update: ${error.message}`);
		res.status(500).json({ success: false, message: 'Error al obtener listado', error: error.message });
	}
};


/**
 * PATCH /api/causas-elegibles-update/:fuero/:id/update-flag
 * Body: { update: boolean, reason: string }
 *
 * Apaga (o enciende) el seguimiento de una causa desde la vista, dejando la
 * transición firmada en updateHistory: quién, cuándo y por qué. Es el camino
 * manual para retirar del circuito una causa que el worker no puede procesar
 * (expediente reservado, solo incidentes, shell sin datos verificables).
 *
 * Nota de instancia: los modelos van sobre la conexión default — la UI llama
 * vía cache-api (rs0), que es donde vive el caché del worker.
 */
exports.setUpdateFlag = async (req, res) => {
	try {
		const { fuero, id } = req.params;
		const { update, reason } = req.body || {};

		if (!FUERO_MODELS[fuero]) {
			return res.status(400).json({ success: false, message: `fuero inválido: ${fuero}` });
		}
		if (typeof update !== 'boolean' || !reason || !String(reason).trim()) {
			return res.status(400).json({ success: false, message: 'update (boolean) y reason (texto) son obligatorios' });
		}

		const Model = FUERO_MODELS[fuero];
		const doc = await Model.findById(id).select('update movimientosCount number year').lean();
		if (!doc) return res.status(404).json({ success: false, message: 'Causa no encontrada' });
		if (doc.update === update) {
			return res.json({ success: true, data: { unchanged: true, update } });
		}

		const u = req.user || {};
		const entry = updateFlagAudit.buildUpdateFlagEntry({
			previous: doc.update,
			next: update,
			reason: String(reason).trim(),
			actor: `${u.email || u.id || 'desconocido'} (admin)`,
			source: 'admin_manual',
			movimientosTotal: doc.movimientosCount || 0,
		});

		await Model.updateOne({ _id: id }, { $set: { update }, $push: { updateHistory: entry } });
		logger.info(`[elegibles-update] ${entry.details.actor} puso update=${update} en ${fuero} ${doc.number}/${doc.year}: ${reason}`);

		res.json({ success: true, data: { update, entry } });
	} catch (error) {
		logger.error(`Error en setUpdateFlag causas-elegibles-update: ${error.message}`);
		res.status(500).json({ success: false, message: error.message });
	}
};
