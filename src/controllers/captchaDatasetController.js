/**
 * Captcha Dataset Controller
 *
 * Expone las imágenes de captcha capturadas por los scraping workers (cuando
 * tienen captureDataset.enabled=true) para visualizarlas desde la admin UI.
 *
 * El dataset vive en el filesystem del mismo host que pjn-api (worker_01):
 *   /var/www/pjn-workers-scraping/captcha-dataset/
 *     ├── manifest.jsonl         (una línea JSON por imagen)
 *     ├── verified/              (PJN aceptó el token — label es ground truth)
 *     └── unverified/            (PJN rechazó — label es OCR pero NO ground truth)
 *
 * Endpoints:
 *   GET /api/captcha-dataset                  → lista paginada con filtros
 *   GET /api/captcha-dataset/stats            → conteos + uso de disco
 *   GET /api/captcha-dataset/image/:subdir/:filename → sirve PNG
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { logger } = require('../config/pino');

const DATASET_ROOT = process.env.CAPTCHA_DATASET_PATH
	|| '/var/www/pjn-workers-scraping/captcha-dataset';
const MANIFEST_PATH = path.join(DATASET_ROOT, 'manifest.jsonl');
// 'hard' son los que el modelo derivó por baja confianza; los que además
// el proveedor falló quedan sin etiqueta y se etiquetan a mano desde la admin.
const VALID_SUBDIRS = new Set(['verified', 'unverified', 'hard']);
// Filename seguro: alfanuméricos + _ - . — ningún path traversal posible.
const SAFE_FILENAME = /^[A-Za-z0-9_.\-]+\.png$/;

// Lee manifest.jsonl como stream y aplica filtros + paginación.
// Para datasets de hasta cientos de miles de líneas esto es suficiente.
async function readManifestFiltered({ verified, workerId, fuero, search, skip, limit, needsLabel }) {
	if (!fs.existsSync(MANIFEST_PATH)) {
		return { entries: [], total: 0 };
	}

	// El manifest es append-only: las correcciones (etiquetado manual y
	// pre-etiquetado) se agregan al final con el mismo `file`. Hay que quedarse
	// con la ÚLTIMA entrada de cada archivo, si no las originales sin etiqueta
	// siguen apareciendo como pendientes y se repiten una y otra vez.
	const ultimaPorArchivo = new Map();
	const stream = fs.createReadStream(MANIFEST_PATH, { encoding: 'utf8' });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	for await (const line of rl) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch (err) {
			continue; // saltear líneas corruptas
		}
		if (!entry.file) continue;
		// Se conserva el orden de primera aparición: Map mantiene el orden de
		// inserción y set() sobre una clave existente no lo altera.
		ultimaPorArchivo.set(entry.file, entry);
	}

	const entries = [];
	for (const entry of ultimaPorArchivo.values()) {
		// Descartadas: no son captchas (desafío expirado, render roto). Salen del
		// dataset y de la cola de etiquetado.
		if (entry.discarded === true) continue;
		if (verified !== undefined && entry.verified !== verified) continue;
		// Pendientes de etiquetado manual: ni el modelo ni el proveedor los
		// resolvieron, así que no hay etiqueta automática posible.
		if (needsLabel === true && entry.needsLabel !== true) continue;
		if (needsLabel === false && entry.needsLabel === true) continue;
		if (workerId && entry.worker_id !== workerId) continue;
		if (fuero && entry.fuero !== fuero) continue;
		if (search) {
			const s = String(search).toLowerCase();
			const hay = `${entry.label || ''} ${entry.expediente || ''}`.toLowerCase();
			if (!hay.includes(s)) continue;
		}
		entries.push(entry);
	}

	// Newest-first: el manifest se appendea cronológicamente, así que el final
	// del archivo son los más nuevos. Invertimos y aplicamos paginación.
	entries.reverse();
	const sliced = entries.slice(skip, skip + limit);
	return { entries: sliced, total: entries.length };
}

const captchaDatasetController = {
	async list(req, res) {
		try {
			const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
			const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));

			let verified;
			let needsLabel;
			if (req.query.needsLabel === 'true') needsLabel = true;
			else if (req.query.needsLabel === 'false') needsLabel = false;
			if (req.query.verified === 'true') verified = true;
			else if (req.query.verified === 'false') verified = false;

			const workerId = req.query.worker_id ? String(req.query.worker_id) : undefined;
			const fuero = req.query.fuero ? String(req.query.fuero) : undefined;
			const search = req.query.search ? String(req.query.search) : undefined;

			const { entries, total } = await readManifestFiltered({
				verified, workerId, fuero, search, skip, limit, needsLabel,
			});

			res.json({
				success: true,
				count: entries.length,
				total,
				skip,
				limit,
				data: entries,
			});
		} catch (err) {
			logger.error(`Error listando captcha dataset: ${err.message}`);
			res.status(500).json({ success: false, message: 'Error leyendo dataset', error: err.message });
		}
	},

	async stats(req, res) {
		try {
			let total = 0, verified = 0, unverified = 0, descartadas = 0;
			const byWorker = {};
			const byFuero = {};
			let diskBytes = 0;

			if (fs.existsSync(MANIFEST_PATH)) {
				const stream = fs.createReadStream(MANIFEST_PATH, { encoding: 'utf8' });
				const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
				// Igual que en el listado: el manifest es append-only y las
				// correcciones repiten el `file`. Contar línea por línea inflaba
				// los totales y dejaba como "sin verificar" a los ya corregidos.
				const ultimaPorArchivo = new Map();
				for await (const line of rl) {
					if (!line.trim()) continue;
					try {
						const e = JSON.parse(line);
						if (e.file) ultimaPorArchivo.set(e.file, e);
					} catch (_) { /* skip */ }
				}
				for (const e of ultimaPorArchivo.values()) {
					if (e.discarded === true) { descartadas++; continue; }
					total++;
					if (e.verified) verified++; else unverified++;
					if (e.worker_id) byWorker[e.worker_id] = (byWorker[e.worker_id] || 0) + 1;
					if (e.fuero) byFuero[e.fuero] = (byFuero[e.fuero] || 0) + 1;
				}
			}

			// Calcular tamaño aproximado en disco (sumando las dos subcarpetas)
			for (const sub of VALID_SUBDIRS) {
				const dir = path.join(DATASET_ROOT, sub);
				try {
					const files = await fsp.readdir(dir);
					await Promise.all(files.map(async f => {
						try {
							const st = await fsp.stat(path.join(dir, f));
							diskBytes += st.size;
						} catch (_) { /* skip */ }
					}));
				} catch (_) { /* dir no existe, skip */ }
			}

			res.json({
				success: true,
				data: {
					total,
					verified,
					unverified,
					byWorker,
					byFuero,
					diskBytes,
					diskMB: Math.round(diskBytes / (1024 * 1024) * 100) / 100,
					datasetRoot: DATASET_ROOT,
				},
			});
		} catch (err) {
			logger.error(`Error obteniendo stats: ${err.message}`);
			res.status(500).json({ success: false, message: 'Error obteniendo stats', error: err.message });
		}
	},

	/**
	 * Etiqueta manualmente un captcha que quedó sin etiqueta automática.
	 *
	 * No se reescribe el manifest (es append-only y lo leen varios procesos):
	 * se appendea una corrección con la etiqueta y el mismo `file`. Los lectores
	 * se quedan con la última entrada de cada archivo, así que la corrección
	 * pisa a la original sin tocar lo ya escrito.
	 */
	async label(req, res) {
		try {
			const { subdir, filename } = req.params;
			const label = String(req.body?.label ?? '').trim();

			if (!VALID_SUBDIRS.has(subdir) || !SAFE_FILENAME.test(filename)) {
				return res.status(400).json({ success: false, message: 'Ruta de imagen inválida' });
			}
			if (!/^\d{4}$/.test(label)) {
				return res.status(400).json({ success: false, message: 'La etiqueta debe ser exactamente 4 dígitos' });
			}
			const filePath = path.join(DATASET_ROOT, subdir, filename);
			if (!fs.existsSync(filePath)) {
				return res.status(404).json({ success: false, message: 'La imagen no existe' });
			}

			await fsp.appendFile(
				MANIFEST_PATH,
				JSON.stringify({
					ts: new Date().toISOString(),
					file: path.join(subdir, filename),
					label,
					verified: true,
					needsLabel: false,
					hard: true,
					labeledBy: req.user?.email || req.user?.id || 'admin',
					manualLabel: true,
				}) + '\n'
			);

			logger.info(`[captcha-dataset] etiquetado manual ${subdir}/${filename} -> ${label}`);
			return res.json({ success: true, data: { file: path.join(subdir, filename), label } });
		} catch (error) {
			logger.error(`[captcha-dataset] label: ${error.message}`);
			return res.status(500).json({ success: false, message: error.message });
		}
	},
	/**
	 * Descarta una imagen que no es un captcha (desafío expirado, render roto).
	 * Igual que el etiquetado, se appendea al manifest en vez de reescribirlo.
	 */
	async discard(req, res) {
		try {
			const { subdir, filename } = req.params;
			if (!VALID_SUBDIRS.has(subdir) || !SAFE_FILENAME.test(filename)) {
				return res.status(400).json({ success: false, message: 'Ruta de imagen inválida' });
			}
			await fsp.appendFile(
				MANIFEST_PATH,
				JSON.stringify({
					ts: new Date().toISOString(),
					file: path.join(subdir, filename),
					label: null,
					verified: false,
					needsLabel: false,
					discarded: true,
					discardReason: String(req.body?.reason || 'no es un captcha'),
					discardedBy: req.user?.email || req.user?.id || 'admin',
				}) + '\n'
			);
			logger.info(`[captcha-dataset] descartada ${subdir}/${filename}`);
			return res.json({ success: true, data: { file: path.join(subdir, filename) } });
		} catch (error) {
			logger.error(`[captcha-dataset] discard: ${error.message}`);
			return res.status(500).json({ success: false, message: error.message });
		}
	},

	async image(req, res) {
		try {
			const { subdir, filename } = req.params;
			if (!VALID_SUBDIRS.has(subdir)) {
				return res.status(400).json({ success: false, message: 'Subdir inválido' });
			}
			if (!SAFE_FILENAME.test(filename)) {
				return res.status(400).json({ success: false, message: 'Filename inválido' });
			}
			const filePath = path.join(DATASET_ROOT, subdir, filename);
			// Resolver y comprobar que no salió del root (defense in depth)
			const resolved = path.resolve(filePath);
			if (!resolved.startsWith(path.resolve(DATASET_ROOT) + path.sep)) {
				return res.status(400).json({ success: false, message: 'Path inválido' });
			}
			if (!fs.existsSync(resolved)) {
				return res.status(404).json({ success: false, message: 'Imagen no encontrada' });
			}
			res.setHeader('Cache-Control', 'public, max-age=86400');
			res.setHeader('Content-Type', 'image/png');
			fs.createReadStream(resolved).pipe(res);
		} catch (err) {
			logger.error(`Error sirviendo imagen: ${err.message}`);
			res.status(500).json({ success: false, message: 'Error sirviendo imagen', error: err.message });
		}
	},
};

module.exports = captchaDatasetController;
