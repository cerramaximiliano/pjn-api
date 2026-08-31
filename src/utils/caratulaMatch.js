'use strict';

/**
 * caratulaMatch
 *
 * Comparador de carátulas entre un fallo SAIJ y una causa PJN.
 *
 * Existe porque el apareo se hacía sólo por (fuero, número, año) y eso alcanza
 * para colgar un fallo de la causa equivocada: el número de expediente se
 * repite entre fueros y el parser del PDF a veces toma el expediente de una
 * cita. La auditoría de 2026-08-31 encontró 159 apareos sospechosos sobre
 * 10.798, de los cuales 130 tenían nombres completos en ambos lados y cero
 * palabras en común.
 *
 * Dos particularidades del dominio que el comparador tiene que respetar:
 *
 *   1. Muchos fallos SAIJ vienen anonimizados ("M. A. J. c/ T. S y otro s/
 *      beneficio de litigar sin gastos"). Contra esos no se pueden comparar
 *      nombres — pero sí el objeto procesal, lo que va después de "s/".
 *   2. Muchas causas tienen carátula placeholder: "N/A" (expediente reservado
 *      en el portal), "ERROR: Scraping fallido", "Pendiente de verificación".
 *      Comparar contra eso no dice nada en ningún sentido.
 *
 * Copia sincronizada de saij-workers/src/utils/caratulaMatch.js. Está
 * duplicada porque los dos repos no comparten librería y el criterio tiene que
 * ser idéntico en los dos lados: el linker decide con él en el momento del
 * apareo, y el escaneo de conciliación reevalúa lo ya apareado con el mismo
 * criterio. Si divergen, la vista de conciliación marcaría como sospechoso
 * algo que el linker acaba de aceptar.
 *
 * Al tocar uno, tocar el otro.
 */

// Conectores procesales, formas societarias y muletillas de carátula: aparecen
// en casi todas y sólo agregan coincidencias espurias.
const STOP = new Set([
	'c', 's', 'y', 'o', 'de', 'del', 'la', 'el', 'los', 'las', 'en', 'por', 'su', 'sus',
	'un', 'una', 'al', 'con', 'para', 'otros', 'otro', 'otra', 'otras',
	'sa', 'srl', 'sas', 'sh', 'sca', 'saic', 'sacifi', 'ltda', 'sociedad', 'anonima',
	'responsabilidad', 'limitada', 'cia', 'compania', 'nacion', 'nacional', 'estado',
	'sobre', 'contra', 'expte', 'expediente', 'incidente', 'inc',
	'ordinario', 'sumarisimo', 'sumario', 'recurso', 'queja', 'vs', 'art',
]);

const RE_PLACEHOLDER = /^\s*(n\/?a|error:|pendiente de verificaci|sin car|desconocid)/i;
// Partes reducidas a iniciales: "M. A. J. c/ T. S".
const RE_ANONIMO = /(^|[\s,(])[A-ZÁÉÍÓÚÑ]\.(\s|,|$)/;

function normalizar(texto) {
	return String(texto || '')
		.normalize('NFD').replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function tokenizar(texto) {
	return new Set(normalizar(texto).split(' ').filter(t => t.length > 2 && !STOP.has(t)));
}

/** Objeto procesal: lo que va después del último "s/" de la carátula. */
function objetoProcesal(texto) {
	const partes = String(texto || '').split(/\bs\/\s*/i);
	return partes.length > 1 ? partes[partes.length - 1] : '';
}

/**
 * Jaccard + containment entre dos textos. `null` si alguno queda sin tokens
 * útiles (carátula vacía, puras iniciales, sólo stopwords).
 */
function similitud(a, b) {
	const A = tokenizar(a);
	const B = tokenizar(b);
	if (!A.size || !B.size) return { jaccard: null, containment: null };
	let inter = 0;
	for (const t of A) if (B.has(t)) inter++;
	return {
		jaccard: inter / (A.size + B.size - inter),
		containment: inter / Math.min(A.size, B.size),
	};
}

function esPlaceholder(caratula) {
	const s = String(caratula || '').trim();
	return !s || RE_PLACEHOLDER.test(s);
}

function esAnonimizado(texto) {
	return RE_ANONIMO.test(String(texto || ''));
}

/**
 * Decide si la carátula de un fallo y la de una causa describen el mismo
 * pleito.
 *
 * Devuelve un veredicto de tres valores en lugar de un booleano porque
 * "no puedo saberlo" es un desenlace legítimo y frecuente (carátula
 * placeholder, fallo anonimizado sin objeto comparable) que amerita una
 * política distinta de "no coinciden".
 *
 * @param {string} caratulaCausa
 * @param {string} caratulaFallo
 * @param {object} [opts]
 * @param {number} [opts.minJaccard=0.35]
 * @param {number} [opts.minContainment=0.5] - salva los casos en que una
 *        carátula es mucho más larga que la otra pero la contiene.
 * @param {number} [opts.minObjeto=0.35]     - umbral sobre el objeto procesal
 *        cuando el fallo está anonimizado.
 * @returns {{ veredicto: 'coincide'|'no_coincide'|'indeterminado',
 *             jaccard: number|null, containment: number|null,
 *             objetoJaccard: number|null, motivo: string }}
 */
function compararCaratulas(caratulaCausa, caratulaFallo, opts = {}) {
	const { minJaccard = 0.35, minContainment = 0.5, minObjeto = 0.35 } = opts;

	if (esPlaceholder(caratulaCausa)) {
		return {
			veredicto: 'indeterminado', jaccard: null, containment: null, objetoJaccard: null,
			motivo: 'la causa no tiene carátula utilizable (reservada, stub o scraping fallido)',
		};
	}

	const { jaccard, containment } = similitud(caratulaCausa, caratulaFallo);
	const obj = similitud(objetoProcesal(caratulaCausa), objetoProcesal(caratulaFallo));
	const objetoJaccard = obj.jaccard;

	if (jaccard === null) {
		return {
			veredicto: 'indeterminado', jaccard: null, containment: null, objetoJaccard,
			motivo: 'el fallo no aporta texto comparable',
		};
	}

	if (jaccard >= minJaccard || containment >= minContainment) {
		return {
			veredicto: 'coincide', jaccard, containment, objetoJaccard,
			motivo: `carátulas compatibles (jaccard ${jaccard.toFixed(2)}, containment ${containment.toFixed(2)})`,
		};
	}

	// Fallo anonimizado: los nombres no pueden coincidir aunque el apareo sea
	// correcto. El objeto procesal es lo único que queda para desempatar.
	if (esAnonimizado(caratulaFallo)) {
		if (objetoJaccard === null) {
			return {
				veredicto: 'indeterminado', jaccard, containment, objetoJaccard,
				motivo: 'fallo anonimizado y sin objeto procesal comparable',
			};
		}
		if (objetoJaccard >= minObjeto) {
			return {
				veredicto: 'coincide', jaccard, containment, objetoJaccard,
				motivo: `fallo anonimizado pero el objeto procesal coincide (${objetoJaccard.toFixed(2)})`,
			};
		}
		return {
			veredicto: 'no_coincide', jaccard, containment, objetoJaccard,
			motivo: `fallo anonimizado y objeto procesal distinto (${objetoJaccard.toFixed(2)})`,
		};
	}

	return {
		veredicto: 'no_coincide', jaccard, containment, objetoJaccard,
		motivo: `carátulas sin relación (jaccard ${jaccard.toFixed(2)}, containment ${containment.toFixed(2)})`,
	};
}

module.exports = {
	compararCaratulas,
	similitud,
	normalizar,
	tokenizar,
	objetoProcesal,
	esPlaceholder,
	esAnonimizado,
};
