'use strict';

const mongoose = require('mongoose');
const { logger } = require('../config/pino');
// Todos los accesos crudos van por la conexión del corpus (rs0): pjn-api es
// dual y en el hub la conexión default es Atlas, donde nada de esto existe.
const { getSentenciasDb } = require('../config/sentenciasConnection');
const SaijConciliacion = require('../models/saijConciliacion');
const svc = require('../services/saijConciliacionService');

/**
 * saijConciliacionController
 *
 * Vista de conciliación de apareos SAIJ ↔ causas PJN.
 *
 * El escaneo reevalúa todo lo ya apareado con el mismo comparador que usa el
 * linker y deja una cola de revisión; los endpoints de resolución arman o
 * desarman el apareo entero a través de `saijConciliacionService`.
 */

const FUEROS_APAREABLES = ['CIV', 'COM', 'CSS', 'CNT'];

/** Quién está operando, para dejarlo en el historial de la causa. */
const actorDe = (req) => {
	const u = req.user || {};
	return `${u.email || u.id || 'desconocido'} (admin)`;
};

const saijConciliacionController = {
	/**
	 * GET /saij/conciliacion
	 * Filtros: estado, fuero, sospechoso, veredicto, flag, q (nº de expediente
	 * o texto de carátula). Orden por defecto: peor similitud primero, que es
	 * el orden en que conviene revisarlos.
	 */
	async list(req, res) {
		try {
			const {
				estado = 'pendiente',
				fuero,
				sospechoso,
				veredicto,
				flag,
				q,
				incluirShells = 'false',
				page = 1,
				limit = 25,
				sort = 'jaccard',
			} = req.query;

			const filtro = {};
			if (estado && estado !== 'todos') filtro.estado = estado;
			if (fuero) filtro.fuero = String(fuero).toUpperCase();
			if (veredicto) filtro.veredicto = veredicto;
			if (flag) filtro.flags = flag;
			if (sospechoso !== undefined && sospechoso !== 'todos') filtro.sospechoso = sospechoso === 'true';
			// Las shells tienen carátula derivada del propio fallo: coinciden por
			// construcción y sólo ensucian la cola.
			if (incluirShells !== 'true') filtro.esShell = { $ne: true };
			if (q) {
				const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
				filtro.$or = [{ caratulaCausa: rx }, { caratulaFallo: rx }, { number: String(q) }];
			}

			const orden = sort === 'reciente' ? { detectadoAt: -1 } : { jaccard: 1, detectadoAt: -1 };
			const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

			const [items, total] = await Promise.all([
				SaijConciliacion.find(filtro).sort(orden).skip(skip).limit(Number(limit)).lean(),
				SaijConciliacion.countDocuments(filtro),
			]);

			res.json({
				success: true,
				data: items,
				pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
			});
		} catch (error) {
			logger.error(`[conciliacion] list: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/** GET /saij/conciliacion/resumen — contadores para el encabezado de la vista. */
	async resumen(req, res) {
		try {
			const [porEstado, porFuero, porFlag, ultimoEscaneo] = await Promise.all([
				SaijConciliacion.aggregate([{ $group: { _id: '$estado', n: { $sum: 1 } } }]),
				SaijConciliacion.aggregate([
					{ $match: { estado: 'pendiente', sospechoso: true, esShell: { $ne: true } } },
					{ $group: { _id: '$fuero', n: { $sum: 1 } } },
					{ $sort: { n: -1 } },
				]),
				SaijConciliacion.aggregate([
					{ $match: { estado: 'pendiente', esShell: { $ne: true } } },
					{ $unwind: '$flags' },
					{ $group: { _id: '$flags', n: { $sum: 1 } } },
					{ $sort: { n: -1 } },
				]),
				SaijConciliacion.findOne({}).sort({ detectadoAt: -1 }).select('detectadoAt escaneoId').lean(),
			]);

			const aObj = (arr) => arr.reduce((a, x) => ({ ...a, [x._id || 'sin-dato']: x.n }), {});

			res.json({
				success: true,
				data: {
					porEstado: aObj(porEstado),
					porFuero: aObj(porFuero),
					porFlag: aObj(porFlag),
					pendientesSospechosos: await SaijConciliacion.countDocuments({
						estado: 'pendiente', sospechoso: true, esShell: { $ne: true },
					}),
					ultimoEscaneo: ultimoEscaneo?.detectadoAt || null,
					escaneoId: ultimoEscaneo?.escaneoId || null,
				},
			});
		} catch (error) {
			logger.error(`[conciliacion] resumen: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/**
	 * GET /saij/conciliacion/:id
	 * Devuelve el candidato con las dos puntas completas, que es lo que hace
	 * falta para decidir a mano: la causa con sus movimientos SAIJ y el fallo
	 * con su expediente parseado.
	 */
	async detalle(req, res) {
		try {
			const item = await SaijConciliacion.findById(req.params.id).lean();
			if (!item) return res.status(404).json({ success: false, message: 'Candidato no encontrado' });

			const db = await getSentenciasDb();
			const causa = await db.collection(item.causaCollection).findOne(
				{ _id: item.causaId },
				{ projection: { number: 1, year: 1, caratula: 1, fuero: 1, juzgado: 1, secretaria: 1, objeto: 1, source: 1, verified: 1, isValid: 1, update: 1, movimientosCount: 1, saij: 1, movimiento: 1 } }
			);
			const fallo = await db.collection('saij-sentencias').findOne(
				{ _id: item.saijDocId },
				{ projection: { titulo: 1, actor: 1, demandado: 1, sobre: 1, fecha: 1, tribunal: 1, url: 1, pdfUrl: 1, expediente: 1, fuero: 1, causaRefs: 1, apareoMotivo: 1, pipelineStatus: 1 } }
			);
			const sentenciasCapturadas = await db.collection('sentencias-capturadas').find(
				{ 'source.saijDocId': item.saijDocId },
				{ projection: { causaId: 1, caratula: 1, number: 1, year: 1, fuero: 1, embeddingStatus: 1, embeddingChunksCount: 1, url: 1 } }
			).toArray();

			res.json({
				success: true,
				data: {
					candidato: item,
					causa: causa
						? { ...causa, movimiento: (causa.movimiento || []).filter((m) => m.tipo === svc.MOVIMIENTO_TIPO_SAIJ) }
						: null,
					fallo,
					sentenciasCapturadas,
				},
			});
		} catch (error) {
			logger.error(`[conciliacion] detalle: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/**
	 * POST /saij/conciliacion/escanear
	 * Reevalúa los apareos existentes y actualiza la cola. Idempotente: el par
	 * (causa, fallo) es único, así que re-escanear refresca métricas sin
	 * duplicar ni pisar lo ya resuelto a mano.
	 *
	 * Body: { fueros?: ['CIV'], soloSospechosos?: true }
	 */
	async escanear(req, res) {
		try {
			const fueros = (req.body?.fueros?.length ? req.body.fueros : FUEROS_APAREABLES).map((f) => String(f).toUpperCase());
			const soloSospechosos = req.body?.soloSospechosos !== false;
			const escaneoId = `scan-${Date.now()}`;
			const db = await getSentenciasDb();
			const saijCol = db.collection('saij-sentencias');

			let revisados = 0;
			let registrados = 0;
			const porVeredicto = { coincide: 0, no_coincide: 0, indeterminado: 0 };

			for (const fuero of fueros) {
				const nombreCol = svc.coleccionDe(fuero);
				const cursor = db.collection(nombreCol).find(
					{ 'saij.isFromSaij': true },
					{ projection: { number: 1, year: 1, fuero: 1, caratula: 1, source: 1, verified: 1, movimiento: 1, saij: 1 } }
				);

				for await (const causa of cursor) {
					const ids = (causa.saij?.saijSentenciaIds || []).map((x) => new mongoose.Types.ObjectId(String(x)));
					if (!ids.length) continue;
					const fallos = await saijCol.find(
						{ _id: { $in: ids } },
						{ projection: { titulo: 1, actor: 1, demandado: 1, sobre: 1, url: 1, expediente: 1 } }
					).toArray();

					const movsSaij = (causa.movimiento || []).filter((m) => m.tipo === svc.MOVIMIENTO_TIPO_SAIJ);
					const esShell = causa.source === 'cache' && (causa.movimiento || []).length === movsSaij.length;

					for (const fallo of fallos) {
						revisados++;
						// Se evalúa el par contra el movimiento de ese fallo, no
						// contra todos: si no, un fallo correcto tapa a uno malo
						// pegado a la misma causa.
						const movDelFallo = movsSaij.filter((m) => m.url === fallo.url);
						const ev = svc.evaluarPar({ ...causa, fuero: causa.fuero || fuero }, fallo, movDelFallo);
						porVeredicto[ev.veredicto] = (porVeredicto[ev.veredicto] || 0) + 1;

						if (soloSospechosos && !ev.sospechoso) continue;

						await SaijConciliacion.updateOne(
							{ causaId: causa._id, saijDocId: fallo._id },
							{
								// Sólo se refresca el diagnóstico. `estado`, `resueltoPor`
								// y demás quedan como estaban: un re-escaneo no puede
								// reabrir lo que una persona ya resolvió.
								$set: {
									causaCollection: nombreCol,
									fuero: causa.fuero || fuero,
									number: causa.number,
									year: causa.year,
									caratulaCausa: causa.caratula,
									causaSource: causa.source,
									causaVerified: causa.verified,
									esShell,
									caratulaFallo: svc.textoDelFallo(fallo),
									saijUrl: fallo.url,
									expedienteFallo: fallo.expediente || {},
									veredicto: ev.veredicto,
									jaccard: ev.jaccard,
									containment: ev.containment,
									objetoJaccard: ev.objetoJaccard,
									flags: ev.flags,
									sospechoso: ev.sospechoso,
									escaneoId,
								},
								$setOnInsert: { estado: 'pendiente', detectadoAt: new Date() },
							},
							{ upsert: true }
						);
						registrados++;
					}
				}
			}

			logger.info(`[conciliacion] escaneo ${escaneoId}: ${revisados} pares revisados, ${registrados} en cola`);
			res.json({ success: true, data: { escaneoId, revisados, registrados, porVeredicto } });
		} catch (error) {
			logger.error(`[conciliacion] escanear: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/**
	 * POST /saij/conciliacion/desvincular-lote
	 *
	 * Desvincula en masa los casos "claros" de la cola y reintenta el apareo
	 * con los gates nuevos. Un caso es claro cuando la carátula falló con
	 * nombres completos en ambos lados: sin la excusa de la anonimización ni
	 * de la carátula placeholder, dos carátulas sin relación son un apareo
	 * equivocado, no una duda.
	 *
	 * "Reintroducir al pipeline" acá es literal: tras desvincular se reintenta
	 * el apareo contra la causa que declara el expediente ACTUAL del fallo
	 * (que pudo haberse re-parseado bien después del apareo original), y solo
	 * se re-vincula si el comparador da 'coincide'. El resto queda publicado
	 * sin causa — mejor sin causa que con la causa equivocada.
	 *
	 * Body:
	 *   dryRun      - true (default): solo cuenta y muestra una muestra
	 *   jaccardMax  - opcional, achica el lote (ej. 0 = solo cero coincidencia)
	 *   reintentarApareo - default true
	 *   limit       - tope de casos por corrida (default 1000)
	 *   notas       - se guarda en cada caso resuelto
	 */
	async desvincularLote(req, res) {
		try {
			const {
				dryRun = true,
				jaccardMax,
				reintentarApareo = true,
				limit = 1000,
				notas = '',
			} = req.body || {};
			const actor = `${actorDe(req)} [lote]`;

			const filtro = {
				estado: 'pendiente',
				sospechoso: true,
				esShell: { $ne: true },
				flags: { $all: ['CARATULA'], $nin: ['FALLO_ANONIMIZADO', 'CARATULA_PLACEHOLDER'] },
				...(jaccardMax !== undefined ? { jaccard: { $lte: Number(jaccardMax) } } : {}),
			};

			if (dryRun) {
				const [total, muestra] = await Promise.all([
					SaijConciliacion.countDocuments(filtro),
					SaijConciliacion.find(filtro).sort({ jaccard: 1 }).limit(8)
						.select('fuero number year caratulaCausa caratulaFallo jaccard flags').lean(),
				]);
				return res.json({ success: true, data: { dryRun: true, total, muestra } });
			}

			const casos = await SaijConciliacion.find(filtro).sort({ jaccard: 1 }).limit(Number(limit));
			const db = await getSentenciasDb();
			const saijCol = db.collection('saij-sentencias');

			let desvinculados = 0;
			let reapareados = 0;
			const errores = [];

			for (const item of casos) {
				try {
					const resultado = await svc.desvincular({
						saijDocId: item.saijDocId,
						causaId: item.causaId,
						fuero: item.fuero,
						actor,
						motivo: notas || 'lote: carátulas sin relación con nombres completos en ambos lados',
						reencolarEmbedding: true,
					});

					let estadoFinal = 'desvinculado';
					let resultadoFinal = resultado;

					// Reintento con los gates nuevos, solo si el expediente actual
					// del fallo apunta a OTRA causa que la recién desvinculada (si
					// apunta a la misma, volvería a fallar por carátula).
					if (reintentarApareo) {
						const fallo = await saijCol.findOne(
							{ _id: item.saijDocId },
							{ projection: { titulo: 1, actor: 1, demandado: 1, sobre: 1, expediente: 1 } }
						);
						const exp = fallo?.expediente;
						const apuntaAOtra = exp?.numero != null && exp?.año != null && exp?.fuero &&
							!(String(exp.fuero).toUpperCase() === String(item.fuero).toUpperCase() &&
							  parseInt(item.number, 10) === parseInt(exp.numero, 10) &&
							  parseInt(item.year, 10) === parseInt(exp.año, 10));

						if (apuntaAOtra) {
							const causaTarget = await db.collection(svc.coleccionDe(exp.fuero)).findOne(
								{ number: String(exp.numero), year: String(exp.año), incidente: null },
								{ projection: { caratula: 1 } }
							);
							if (causaTarget) {
								const ev = svc.evaluarPar(
									{ caratula: causaTarget.caratula, fuero: exp.fuero, number: String(exp.numero), year: String(exp.año) },
									fallo, []
								);
								if (ev.veredicto === 'coincide') {
									const r = await svc.vincular({
										saijDocId: item.saijDocId,
										fuero: exp.fuero, number: exp.numero, year: exp.año,
										actor,
									});
									estadoFinal = 'reapareado';
									resultadoFinal = { ...resultado, causaNueva: r.causa.causaId };
								}
							}
						}
					}

					item.estado = estadoFinal;
					item.resueltoPor = actor;
					item.resueltoAt = new Date();
					item.notas = notas || 'lote automático de claros';
					item.resultado = {
						movimientoQuitado: resultadoFinal.movimientoQuitado,
						sentenciasCapturadasTocadas: resultadoFinal.sentenciasCapturadasTocadas,
						embeddingReencolado: resultadoFinal.embeddingReencolado,
						...(resultadoFinal.causaNueva ? { causaNueva: resultadoFinal.causaNueva } : {}),
						backupId: resultadoFinal.backupId,
					};
					await item.save();

					if (estadoFinal === 'reapareado') reapareados++;
					else desvinculados++;
				} catch (err) {
					errores.push({ id: String(item._id), expte: `${item.fuero} ${item.number}/${item.year}`, error: err.message });
					logger.error(`[conciliacion] lote, caso ${item._id}: ${err.message}`);
				}
			}

			logger.info(`[conciliacion] lote de ${actor}: ${desvinculados} desvinculados, ${reapareados} reapareados, ${errores.length} errores`);
			res.json({
				success: true,
				data: { dryRun: false, procesados: casos.length, desvinculados, reapareados, errores: errores.slice(0, 20) },
			});
		} catch (error) {
			logger.error(`[conciliacion] desvincularLote: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/**
	 * POST /saij/conciliacion/:id/confirmar
	 * El apareo estaba bien. No toca datos: sólo saca el caso de la cola para
	 * que un re-escaneo no lo vuelva a proponer.
	 */
	async confirmar(req, res) {
		try {
			const item = await SaijConciliacion.findByIdAndUpdate(
				req.params.id,
				{ $set: { estado: 'confirmado', resueltoPor: actorDe(req), resueltoAt: new Date(), notas: req.body?.notas || '' } },
				{ new: true }
			).lean();
			if (!item) return res.status(404).json({ success: false, message: 'Candidato no encontrado' });
			res.json({ success: true, data: item });
		} catch (error) {
			logger.error(`[conciliacion] confirmar: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/** POST /saij/conciliacion/:id/desvincular */
	async desvincular(req, res) {
		try {
			const item = await SaijConciliacion.findById(req.params.id);
			if (!item) return res.status(404).json({ success: false, message: 'Candidato no encontrado' });

			const resultado = await svc.desvincular({
				saijDocId: item.saijDocId,
				causaId: item.causaId,
				fuero: item.fuero,
				actor: actorDe(req),
				motivo: req.body?.notas || 'apareo incorrecto (conciliación manual)',
				reencolarEmbedding: req.body?.reencolarEmbedding !== false,
			});

			item.estado = 'desvinculado';
			item.resueltoPor = actorDe(req);
			item.resueltoAt = new Date();
			item.notas = req.body?.notas || '';
			item.resultado = resultado;
			await item.save();

			res.json({ success: true, data: { candidato: item, resultado } });
		} catch (error) {
			logger.error(`[conciliacion] desvincular: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/**
	 * POST /saij/conciliacion/:id/reaparear
	 * Body: { fuero, number, year, forzar? }
	 * Mueve el fallo a la causa correcta: lo saca de la actual (con respaldo) y
	 * lo cuelga de la nueva, movimiento incluido.
	 */
	async reaparear(req, res) {
		try {
			const item = await SaijConciliacion.findById(req.params.id);
			if (!item) return res.status(404).json({ success: false, message: 'Candidato no encontrado' });

			const { fuero, number, year, forzar } = req.body || {};
			if (!fuero || !number || !year) {
				return res.status(400).json({ success: false, message: 'fuero, number y year son obligatorios' });
			}

			const resultado = await svc.vincular({
				saijDocId: item.saijDocId,
				fuero, number, year,
				actor: actorDe(req),
				forzar: !!forzar,
			});

			item.estado = 'reapareado';
			item.resueltoPor = actorDe(req);
			item.resueltoAt = new Date();
			item.notas = req.body?.notas || '';
			item.resultado = {
				movimientoQuitado: !!resultado.desvinculacionPrevia?.movimientoQuitado,
				sentenciasCapturadasTocadas: resultado.sentenciasCapturadasTocadas,
				embeddingReencolado: resultado.embeddingReencolado,
				causaNueva: resultado.causa.causaId,
				backupId: resultado.desvinculacionPrevia?.backupId,
			};
			await item.save();

			res.json({ success: true, data: { candidato: item, resultado } });
		} catch (error) {
			if (error.code === 'CARATULA_NO_COINCIDE') {
				return res.status(409).json({ success: false, message: error.message, veredicto: error.veredicto });
			}
			logger.error(`[conciliacion] reaparear: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/** POST /saij/conciliacion/:id/ignorar — no lo quiero ver más, sin tocar datos. */
	async ignorar(req, res) {
		try {
			const item = await SaijConciliacion.findByIdAndUpdate(
				req.params.id,
				{ $set: { estado: 'ignorado', resueltoPor: actorDe(req), resueltoAt: new Date(), notas: req.body?.notas || '' } },
				{ new: true }
			).lean();
			if (!item) return res.status(404).json({ success: false, message: 'Candidato no encontrado' });
			res.json({ success: true, data: item });
		} catch (error) {
			logger.error(`[conciliacion] ignorar: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},

	/**
	 * GET /saij/conciliacion/buscar-causa?fuero=CIV&number=1807&year=2024
	 * Para el re-apareo: resuelve el expediente y muestra la carátula candidata
	 * con el veredicto del comparador, así la persona ve de antemano si el
	 * apareo va a pasar el gate o hay que forzarlo.
	 */
	async buscarCausa(req, res) {
		try {
			const { fuero, number, year, saijDocId } = req.query;
			if (!fuero || !number || !year) {
				return res.status(400).json({ success: false, message: 'fuero, number y year son obligatorios' });
			}
			const db = await getSentenciasDb();
			const causa = await db.collection(svc.coleccionDe(fuero)).findOne(
				{ number: String(number), year: String(year), incidente: null },
				{ projection: { number: 1, year: 1, caratula: 1, juzgado: 1, secretaria: 1, objeto: 1, source: 1, verified: 1, movimientosCount: 1 } }
			);
			if (!causa) {
				return res.status(404).json({ success: false, message: `No existe ${String(fuero).toUpperCase()} ${number}/${year}` });
			}

			let veredicto = null;
			if (saijDocId) {
				const fallo = await db.collection('saij-sentencias').findOne(
					{ _id: new mongoose.Types.ObjectId(String(saijDocId)) },
					{ projection: { titulo: 1, actor: 1, demandado: 1, sobre: 1, numeroFallo: 1 } }
				);
				if (fallo) veredicto = svc.evaluarPar({ ...causa, fuero: String(fuero).toUpperCase() }, fallo, []);
			}

			res.json({ success: true, data: { causa, veredicto } });
		} catch (error) {
			logger.error(`[conciliacion] buscarCausa: ${error.message}`);
			res.status(500).json({ success: false, message: error.message });
		}
	},
};

module.exports = saijConciliacionController;
