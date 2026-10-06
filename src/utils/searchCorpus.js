'use strict';

/**
 * "Grifo" de corpus de jurisprudencia (`configuracion-semantic-worker.searchCorpus`).
 *
 * Un valor por consumidor:
 *   - app    → vista in-app /herramientas/jurisprudencia (lo enfuerza pjn-rag-api)
 *   - mcp    → tool search_sentencias de la-mcp-server (lo enfuerza pjn-rag-api)
 *   - public → vista pública /jurisprudencia (lo enfuerza law-analytics-server)
 *
 * Valores: 'saij' (corpus curado público) | 'all' (todo el corpus embebido).
 */

const SEARCH_CORPUS_CONSUMERS = ['app', 'mcp', 'public'];
const SEARCH_CORPUS_VALUES = ['saij', 'all'];

class SearchCorpusError extends Error {}

/**
 * Traduce el `searchCorpus` que manda el admin a un $set por subcampo
 * (`searchCorpus.app`, `searchCorpus.mcp`, `searchCorpus.public`).
 *
 * Por qué no `$set: { searchCorpus: {...} }`: reemplaza el subdocumento
 * entero, así que un cliente que solo conoce app/mcp (UI vieja, script)
 * borraría `public` al guardar. Con dot-notation cada consumidor se toca solo
 * si viene en el body.
 *
 * @param {unknown} input - req.body.searchCorpus
 * @returns {Record<string, 'saij'|'all'>} campos para el $set
 * @throws {SearchCorpusError} ante forma o valores inválidos
 */
function buildSearchCorpusSet(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new SearchCorpusError('searchCorpus debe ser un objeto { app?, mcp?, public? }');
	}
	const set = {};
	for (const [key, value] of Object.entries(input)) {
		if (!SEARCH_CORPUS_CONSUMERS.includes(key)) {
			throw new SearchCorpusError(
				`searchCorpus.${key} no es un consumidor válido (válidos: ${SEARCH_CORPUS_CONSUMERS.join(', ')})`
			);
		}
		if (value === undefined) continue;
		if (!SEARCH_CORPUS_VALUES.includes(value)) {
			throw new SearchCorpusError(
				`searchCorpus.${key} debe ser ${SEARCH_CORPUS_VALUES.map((v) => `'${v}'`).join(' o ')}`
			);
		}
		set[`searchCorpus.${key}`] = value;
	}
	if (Object.keys(set).length === 0) {
		throw new SearchCorpusError('searchCorpus no trae ningún consumidor para actualizar');
	}
	return set;
}

module.exports = {
	SEARCH_CORPUS_CONSUMERS,
	SEARCH_CORPUS_VALUES,
	SearchCorpusError,
	buildSearchCorpusSet,
};
