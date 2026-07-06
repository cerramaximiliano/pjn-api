'use strict';
/**
 * citations.js — normalización de citas legales para la capa léxica de búsqueda.
 *
 * Espejo de la normalización usada al indexar (pjn-workers-scraping/src/utils/
 * citations.js): los lexicalTerms que produce el query planner ("132 bis",
 * "art 80", "ley 27.742") se normalizan al MISMO formato que el payload
 * `citations` de Qdrant (["132bis","80","27742",...]) para poder filtrar por
 * cita exacta. Mantener sincronizado con el extractor del worker.
 */
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "132 bis" -> "132bis"; "art. 80" -> "80"; "ley 27.742"/"27742" -> "27742"; "LCT" -> null */
function normalizeCitationTerm(term) {
	const N = norm(term);
	const law = N.match(/\b(\d{1,2})\.?(\d{3})\b/); // 4-5 dígitos (ley)
	if (law) return law[1] + law[2];
	const art = N.match(/\b(\d{1,4})\s*(bis|ter|quater|quinquies)?\b/);
	if (art) return art[1] + (art[2] || '');
	return null;
}

/** Lista de lexicalTerms -> tokens válidos y únicos. */
function normalizeTerms(terms) {
	if (!Array.isArray(terms)) return [];
	const out = new Set();
	for (const t of terms) {
		const n = normalizeCitationTerm(t);
		if (n) out.add(n);
	}
	return [...out];
}

module.exports = { normalizeCitationTerm, normalizeTerms };
