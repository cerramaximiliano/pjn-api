'use strict';

const mongoose = require('mongoose');
const { logger } = require('../config/pino');
const { compararCaratulas, esPlaceholder, esAnonimizado } = require('../utils/caratulaMatch');

/**
 * saijConciliacionService
 *
 * Operaciones de apareo entre fallos SAIJ y causas PJN, completas y
 * reversibles.
 *
 * Antes esto vivía repartido en dos lugares que hacían la mitad cada uno:
 *
 *   - `saij-workers/src/tasks/desvincular-causas-cruzadas.js` sacaba el
 *     movimiento de la causa y el id de `saij.saijSentenciaIds`, pero sobre la
 *     SentenciaCapturada sólo ponía `causaId: null` — la carátula heredada de
 *     la causa equivocada quedaba viva en el corpus y en la metadata de
 *     Pinecone.
 *   - `saijSentenciasController.vincularCausa` hacía todavía menos: al
 *     desvincular dejaba el movimiento 'SENTENCIA SAIJ' dentro de la causa
 *     para siempre, y al re-vincular no lo movía a la causa nueva.
 *
 * Acá el apareo se trata como lo que es: una relación con cuatro puntas
 * (causa.movimiento[], causa.saij.saijSentenciaIds, SaijSentencia.causaRefs y
 * SentenciaCapturada) que hay que armar y desarmar entera.
 *
 * Todo lo que se desarma queda respaldado en `saij-desvinculacion-backup`,
 * misma colección que usaba el script, para no partir el rastro histórico.
 */

const MOVIMIENTO_TIPO_SAIJ = 'SENTENCIA SAIJ';

const COLECCION_POR_FUERO = {
	CIV: 'causas-civil', COM: 'causas-comercial',
	CNT: 'causas-trabajo', CSS: 'causas-segsocial',
};
const coleccionDe = (fuero) =>
	COLECCION_POR_FUERO[String(fuero || '').toUpperCase()] || `causas_${String(fuero || '').toLowerCase()}`;

// Colecciones SIEMPRE sobre la conexión del corpus (rs0), nunca la default:
// en el hub la default es Atlas y una desvinculación ahí tocaría las copias
// equivocadas de las causas.
const { getSentenciasDb } = require('../config/sentenciasConnection');
const col = async (nombre) => (await getSentenciasDb()).collection(nombre);

/**
 * Texto comparable de un fallo SAIJ: el título, o actor/demandado/sobre.
 * Espeja `buildDetalle` de saij-workers — es lo que termina como `detalle` del
 * movimiento, así que comparar contra esto es comparar contra lo que la causa
 * realmente tiene adentro.
 */
function textoDelFallo(fallo) {
	if (!fallo) return '';
	if (fallo.titulo && String(fallo.titulo).trim()) return String(fallo.titulo).trim();
	const actor = (fallo.actor || '').trim();
	const demandado = (fallo.demandado || '').trim();
	const sobre = (fallo.sobre || '').trim();
	if (actor && demandado && sobre) return `${actor} c/ ${demandado} s/ ${sobre}`;
	if (actor && demandado) return `${actor} c/ ${demandado}`;
	if (actor || demandado) return `${actor || demandado}${sobre ? ` s/ ${sobre}` : ''}`;
	if (fallo.numeroFallo) return `Fallo N° ${fallo.numeroFallo}`;
	return '';
}

const RE_INSTANCIA = /recurso de queja|\/rh\d?|\bqueja\b|\/cs\b|per saltum/i;

/**
 * Evalúa un par (causa, fallo) y devuelve el veredicto más las banderas que
 * explican por qué. Es la misma lógica que corre el linker al aparear, más los
 * chequeos de coherencia de expediente que sólo tienen sentido a posteriori
 * (el fallo pudo re-parsearse después del apareo).
 */
function evaluarPar(causa, fallo, movimientosSaij = []) {
	const textos = [textoDelFallo(fallo), ...movimientosSaij.map((m) => m.detalle)].filter(Boolean);

	let mejor = { veredicto: 'indeterminado', jaccard: null, containment: null, objetoJaccard: null, motivo: 'sin texto comparable' };
	for (const t of textos) {
		const v = compararCaratulas(causa.caratula, t);
		if (v.veredicto === 'coincide') { mejor = v; break; }
		// Entre dos no-coincidencias nos quedamos con la de mayor similitud:
		// es la que mejor defiende el apareo, y aun así no alcanzó.
		if ((v.jaccard ?? -1) > (mejor.jaccard ?? -1)) mejor = v;
	}

	const flags = [];
	const exp = fallo?.expediente || {};
	if (exp.fuero && String(exp.fuero).toUpperCase() !== String(causa.fuero || '').toUpperCase()) flags.push('FUERO');
	if (exp.numero != null && parseInt(causa.number, 10) !== parseInt(exp.numero, 10)) flags.push('NUMERO');
	if (exp.año != null && parseInt(causa.year, 10) !== parseInt(exp.año, 10)) flags.push('ANIO');
	if (RE_INSTANCIA.test(causa.caratula || '') || textos.some((t) => RE_INSTANCIA.test(t))) flags.push('INSTANCIA');
	if (esPlaceholder(causa.caratula)) flags.push('CARATULA_PLACEHOLDER');
	if (textos.some((t) => esAnonimizado(t))) flags.push('FALLO_ANONIMIZADO');
	if (mejor.veredicto === 'no_coincide') flags.push('CARATULA');
	if (!textos.length) flags.push('SIN_COMPARABLE');

	// INSTANCIA sola no condena: un "recurso de queja" apareado a su principal
	// puede ser correcto. Lo que condena es carátula distinta o expediente
	// incoherente.
	const sospechoso = flags.some((f) => ['CARATULA', 'FUERO', 'NUMERO', 'ANIO'].includes(f));

	return { ...mejor, flags, sospechoso };
}

/**
 * Desvincula un fallo de una causa, deshaciendo las cuatro puntas de la
 * relación y dejando respaldo.
 *
 * La SentenciaCapturada NO se borra: el fallo sigue publicado. Lo que se hace
 * es despegarle la identidad heredada de la causa equivocada — carátula,
 * número, año y fuero vuelven a salir del propio fallo — y re-encolar el
 * embedding para que el vector se reindexe con la metadata correcta. Sin ese
 * último paso la carátula equivocada sobrevive en Pinecone aunque Mongo ya
 * esté limpio.
 *
 * @param {object} opts
 * @param {string} opts.saijDocId
 * @param {string} opts.causaId
 * @param {string} opts.fuero
 * @param {string} opts.actor  - quién lo pidió ("<email> (admin)")
 * @param {string} opts.motivo
 * @param {boolean} [opts.reencolarEmbedding=true]
 */
async function desvincular({ saijDocId, causaId, fuero, actor, motivo, reencolarEmbedding = true }) {
	const saijCol = await col('saij-sentencias');
	const scCol = await col('sentencias-capturadas');
	const backupCol = await col('saij-desvinculacion-backup');
	const causasCol = await col(coleccionDe(fuero));

	const saijOid = new mongoose.Types.ObjectId(String(saijDocId));
	const causaOid = new mongoose.Types.ObjectId(String(causaId));

	const fallo = await saijCol.findOne({ _id: saijOid });
	if (!fallo) throw new Error(`Fallo SAIJ ${saijDocId} no encontrado`);
	const causa = await causasCol.findOne({ _id: causaOid });
	if (!causa) throw new Error(`Causa ${fuero} ${causaId} no encontrada en ${coleccionDe(fuero)}`);

	const movimiento = (causa.movimiento || []).find(
		(m) => m.tipo === MOVIMIENTO_TIPO_SAIJ && m.url === fallo.url
	);

	// Respaldo primero: si algo falla después, esto alcanza para reconstruir.
	const backup = await backupCol.insertOne({
		saijDocId: saijOid,
		saijUrl: fallo.url,
		titulo: fallo.titulo,
		causaCollection: coleccionDe(fuero),
		causaId: causaOid,
		causaCaratula: causa.caratula,
		causaRefs: fallo.causaRefs,
		movimiento: movimiento || null,
		// Identidad que la SC tenía heredada, para poder deshacer la limpieza.
		sentenciasCapturadas: await scCol
			.find({ 'source.saijDocId': saijOid }, { projection: { caratula: 1, number: 1, year: 1, fuero: 1, causaId: 1, embeddingStatus: 1 } })
			.toArray(),
		desvinculadoAt: new Date(),
		desvinculadoPor: actor,
		motivo: motivo || 'desvinculado desde la vista de conciliación',
	});

	// 1. Sacar el movimiento de la causa.
	if (movimiento) {
		await causasCol.updateOne(
			{ _id: causaOid },
			{ $pull: { movimiento: { tipo: MOVIMIENTO_TIPO_SAIJ, url: fallo.url } }, $inc: { movimientosCount: -1 } }
		);
	}

	// 2. Sacar el fallo del sub-doc saij de la causa. Si era el último, el
	//    vínculo con SAIJ deja de existir y se limpia el flag entero.
	await causasCol.updateOne({ _id: causaOid }, { $pull: { 'saij.saijSentenciaIds': saijOid } });
	const causaPost = await causasCol.findOne({ _id: causaOid }, { projection: { 'saij.saijSentenciaIds': 1, movimientosCount: 1 } });
	if (!(causaPost?.saij?.saijSentenciaIds || []).length) {
		await causasCol.updateOne({ _id: causaOid }, { $set: { 'saij.isFromSaij': false } });
	}

	// 3. Registrar la desvinculación en el historial de la causa.
	await causasCol.updateOne({ _id: causaOid }, {
		$push: {
			updateHistory: {
				timestamp: new Date(),
				source: 'conciliacion_saij',
				updateType: 'saij_unlink',
				success: true,
				movimientosAdded: 0,
				movimientosTotal: Math.max((causaPost?.movimientosCount ?? causa.movimientosCount ?? 1) , 0),
				details: {
					actor,
					reason: motivo || 'apareo SAIJ incorrecto, desvinculado desde conciliación',
					saijDocId: String(saijDocId),
					message: `Fallo SAIJ desvinculado: ${String(fallo.titulo || '').slice(0, 120)}`,
				},
			},
		},
	});

	// 4. Limpiar el fallo.
	await saijCol.updateOne({ _id: saijOid }, {
		$set: {
			causaRefs: [],
			pipelineStatus: 'skipped',
			pipelineUpdatedAt: new Date(),
			pipelineError: `desvinculado en conciliación por ${actor}: ${motivo || 'apareo incorrecto'}`,
			apareoMotivo: 'desvinculado-manualmente',
		},
	});

	// 5. Despegar la SentenciaCapturada de la identidad de la causa. La
	//    carátula vuelve a salir del fallo, no del expediente equivocado.
	const caratulaPropia = textoDelFallo(fallo);
	const setSc = {
		causaId: null,
		...(caratulaPropia ? { caratula: caratulaPropia } : {}),
		...(fallo.expediente?.numero != null ? { number: fallo.expediente.numero } : {}),
		...(fallo.expediente?.año != null ? { year: fallo.expediente.año } : {}),
		...(fallo.expediente?.fuero ? { fuero: fallo.expediente.fuero } : {}),
	};
	// Reindexar: el vector viejo lleva la carátula ajena en su metadata.
	if (reencolarEmbedding) {
		setSc.embeddingStatus = 'pending';
		setSc.embeddingLargeStatus = 'pending';
	}
	const r = await scCol.updateMany({ 'source.saijDocId': saijOid }, { $set: setSc });

	logger.info(
		`[conciliacion] ${actor} desvinculó fallo ${saijDocId} de ${fuero} ${causa.number}/${causa.year} — ` +
		`movimiento ${movimiento ? 'quitado' : 'no estaba'}, ${r.modifiedCount} SC despegada(s)`
	);

	return {
		movimientoQuitado: !!movimiento,
		sentenciasCapturadasTocadas: r.modifiedCount,
		embeddingReencolado: reencolarEmbedding ? r.modifiedCount : 0,
		backupId: backup.insertedId,
	};
}

/**
 * Vincula un fallo a una causa, armando las cuatro puntas.
 *
 * Si el fallo ya estaba colgado de otra causa, primero se desvincula de
 * aquélla: dejarlo en las dos es lo que producía los duplicados silenciosos.
 *
 * @param {object} opts
 * @param {string} opts.saijDocId
 * @param {string} opts.fuero
 * @param {string|number} opts.number
 * @param {string|number} opts.year
 * @param {string} opts.actor
 * @param {boolean} [opts.forzar=false] - vincular aunque las carátulas no coincidan
 */
async function vincular({ saijDocId, fuero, number, year, actor, forzar = false }) {
	const saijCol = await col('saij-sentencias');
	const scCol = await col('sentencias-capturadas');
	const fueroUp = String(fuero || '').toUpperCase();
	const causasCol = await col(coleccionDe(fueroUp));

	const saijOid = new mongoose.Types.ObjectId(String(saijDocId));
	const fallo = await saijCol.findOne({ _id: saijOid });
	if (!fallo) throw new Error(`Fallo SAIJ ${saijDocId} no encontrado`);

	const causa = await causasCol.findOne({ number: String(number), year: String(year), incidente: null });
	if (!causa) throw new Error(`No existe la causa principal ${fueroUp} ${number}/${year} en ${coleccionDe(fueroUp)}`);

	// Chequeo de carátula también en el apareo manual: la persona puede
	// equivocarse de expediente igual que el parser. Con `forzar` se salta,
	// pero queda dicho en el historial que se forzó.
	const veredicto = compararCaratulas(causa.caratula, textoDelFallo(fallo));
	if (veredicto.veredicto === 'no_coincide' && !forzar) {
		const err = new Error(
			`Las carátulas no coinciden (${veredicto.motivo}). ` +
			`Causa: "${String(causa.caratula).slice(0, 80)}" | Fallo: "${textoDelFallo(fallo).slice(0, 80)}". ` +
			'Reenviar con forzar:true si el apareo es correcto igual.'
		);
		err.code = 'CARATULA_NO_COINCIDE';
		err.veredicto = veredicto;
		throw err;
	}

	// Desvincular del apareo previo, si lo había y es otro.
	const refPrevia = (fallo.causaRefs || [])[0];
	let desvinculacionPrevia = null;
	if (refPrevia?.causaId && String(refPrevia.causaId) !== String(causa._id)) {
		desvinculacionPrevia = await desvincular({
			saijDocId,
			causaId: refPrevia.causaId,
			fuero: refPrevia.fuero,
			actor,
			motivo: `re-apareado a ${fueroUp} ${number}/${year}`,
			// No re-encolar acá: el embedding se re-encola una sola vez al final,
			// ya con la identidad definitiva.
			reencolarEmbedding: false,
		});
	}

	const ref = { causaId: causa._id, caratula: causa.caratula, fuero: fueroUp, source: 'app' };

	await saijCol.updateOne({ _id: saijOid }, {
		$set: {
			causaRefs: [ref],
			fuero: fueroUp,
			'expediente.numero': Number(number),
			'expediente.año': Number(year),
			'expediente.fuero': fueroUp,
			'expediente.source': 'manual',
			'expediente.confidence': 'high',
			pipelineStatus: 'linked',
			pipelineUpdatedAt: new Date(),
			pipelineError: null,
			apareoMotivo: forzar ? 'apareado-a-mano-forzado' : 'apareado-a-mano',
		},
	});

	// Movimiento en la causa nueva, si no lo tiene ya.
	const yaTiene = (causa.movimiento || []).some((m) => m.tipo === MOVIMIENTO_TIPO_SAIJ && m.url === fallo.url);
	let movimientoAgregado = false;
	if (!yaTiene && fallo.url) {
		const fecha = fallo.fecha || new Date();
		const nuevo = { fecha, tipo: MOVIMIENTO_TIPO_SAIJ, detalle: textoDelFallo(fallo), url: fallo.url };
		// Los movimientos van en orden descendente por fecha: se busca la
		// posición en vez de empujar al frente, que dejaría el array desordenado.
		const movs = causa.movimiento || [];
		let idx = movs.length;
		for (let i = 0; i < movs.length; i++) {
			if (new Date(fecha) > new Date(movs[i].fecha)) { idx = i; break; }
		}
		movs.splice(idx, 0, nuevo);
		await causasCol.updateOne(
			{ _id: causa._id },
			{ $set: { movimiento: movs, movimientosCount: movs.length } }
		);
		movimientoAgregado = true;
	}

	await causasCol.updateOne({ _id: causa._id }, {
		$addToSet: { 'saij.saijSentenciaIds': saijOid },
		$set: {
			'saij.isFromSaij': true,
			'saij.linkedAt': new Date(),
			'saij.saijJurisdiccion': fallo.scrapeJurisdiccion || 'NACIONAL',
		},
		$push: {
			updateHistory: {
				timestamp: new Date(),
				source: 'conciliacion_saij',
				updateType: 'saij_link',
				success: true,
				movimientosAdded: movimientoAgregado ? 1 : 0,
				movimientosTotal: (causa.movimiento || []).length + (movimientoAgregado ? 1 : 0),
				details: {
					actor,
					reason: forzar
						? `apareo manual forzado pese a ${veredicto.motivo}`
						: `apareo manual confirmado (${veredicto.motivo})`,
					saijDocId: String(saijDocId),
					message: `Fallo SAIJ vinculado: ${String(fallo.titulo || '').slice(0, 120)}`,
				},
			},
		},
	});

	// La SC hereda la identidad de la causa nueva y se reindexa.
	const r = await scCol.updateMany({ 'source.saijDocId': saijOid }, {
		$set: {
			causaId: causa._id,
			fuero: fueroUp,
			number: Number(number),
			year: Number(year),
			caratula: causa.caratula,
			embeddingStatus: 'pending',
			embeddingLargeStatus: 'pending',
		},
	});

	logger.info(`[conciliacion] ${actor} vinculó fallo ${saijDocId} → ${fueroUp} ${number}/${year} (${causa._id}); ${r.modifiedCount} SC actualizada(s)`);

	return {
		causa: ref,
		movimientoAgregado,
		sentenciasCapturadasTocadas: r.modifiedCount,
		embeddingReencolado: r.modifiedCount,
		desvinculacionPrevia,
		veredicto,
	};
}

module.exports = {
	desvincular,
	vincular,
	evaluarPar,
	textoDelFallo,
	coleccionDe,
	MOVIMIENTO_TIPO_SAIJ,
};
