'use strict';
/**
 * hydeCache.js
 *
 * HyDE (Hypothetical Document Embeddings) con caché Redis.
 *
 * HyDE genera un fragmento hipotético de sentencia que "respondería" a la
 * query del usuario, y usa ese fragmento como vector de búsqueda en lugar
 * de la query cruda. Los embeddings de documentos y documentos hipotéticos
 * están en el mismo espacio vectorial → mejor recall semántico.
 *
 * El problema: generar el fragmento requiere una llamada a GPT (3-13s desde
 * este servidor). Solución: cache en Redis con TTL 7 días.
 *
 * Flujo:
 *   1. Normalizar query → cache key
 *   2. Cache HIT  → devolver embedding cacheado (0ms extra)
 *   3. Cache MISS → devolver null (caller usa augmentation), lanzar generación en background
 *   4. Background → GPT genera fragmento → embed → guardar en Redis
 *
 * En el próximo request con la misma query: cache hit, usa HyDE.
 */

const crypto  = require('crypto');
const OpenAI  = require('openai').default;
const { logger } = require('../config/pino');

const HYDE_MODEL      = 'gpt-4o-mini';
const HYDE_MAX_TOKENS = 250;
const HYDE_TTL_SEC    = 60 * 60 * 24 * 7;   // 7 días
const HYDE_CACHE_PREFIX = 'hyde:v1:';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS  = 1024;

// ── Redis ─────────────────────────────────────────────────────────────────────

let _redis = null;
let _redisAvailable = false;

function getRedis() {
	if (_redis) return _redis;
	try {
		const Redis = require('ioredis');
		_redis = new Redis({
			host:           process.env.REDIS_HOST     || '127.0.0.1',
			port:           parseInt(process.env.REDIS_PORT || '6379'),
			password:       process.env.REDIS_PASSWORD || undefined,
			db:             parseInt(process.env.REDIS_DB_HYDE || '1'),
			connectTimeout: 2000,
			lazyConnect:    true,
			maxRetriesPerRequest: 1,
		});
		_redis.on('ready',  () => { _redisAvailable = true;  logger.info('[HyDE] Redis conectado'); });
		_redis.on('error',  (e) => { _redisAvailable = false; logger.warn({ err: e.message }, '[HyDE] Redis error'); });
		_redis.on('close',  () => { _redisAvailable = false; });
		_redis.connect().catch(() => {}); // no lanzar si Redis no está disponible
		return _redis;
	} catch (e) {
		logger.warn('[HyDE] ioredis no disponible, caché deshabilitado');
		return null;
	}
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

let _openai = null;
function getOpenAI() {
	if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	return _openai;
}

// ── Cache key ─────────────────────────────────────────────────────────────────

/**
 * Genera una clave de caché determinista para una query + filtros.
 * La query se normaliza (lowercase, trim, colapsar espacios) para maximizar
 * cache hits aunque el usuario cambie mayúsculas o espaciado.
 */
function buildCacheKey(query, filters = {}) {
	const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');
	const filterStr = Object.keys(filters).sort().map(k => `${k}:${filters[k]}`).join('|');
	const raw = `${normalizedQuery}||${filterStr}`;
	const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
	return `${HYDE_CACHE_PREFIX}${hash}`;
}

// ── HyDE generation ───────────────────────────────────────────────────────────

/**
 * Prompt para generar un fragmento hipotético de sentencia argentina.
 * El fragmento imita el lenguaje jurídico del corpus indexado, maximizando
 * la similitud vectorial con documentos reales sobre el mismo tema.
 */
function buildHydePrompt(query) {
	return `Eres un juez federal argentino. Redacta el fragmento del "CONSIDERANDO" de una sentencia judicial argentina que resuelve la siguiente cuestión jurídica. Usa terminología legal argentina formal. Máximo 200 palabras. Solo el texto del considerando, sin encabezado.

Cuestión: ${query}

CONSIDERANDO:`;
}

/**
 * Genera el texto hipotético de sentencia usando GPT.
 * @param {string} query
 * @returns {Promise<string|null>}
 */
async function generateHydeText(query) {
	const openai = getOpenAI();
	const t0 = Date.now();
	try {
		const response = await openai.chat.completions.create({
			model:       HYDE_MODEL,
			messages:    [{ role: 'user', content: buildHydePrompt(query) }],
			max_tokens:  HYDE_MAX_TOKENS,
			temperature: 0.3,
		});
		const text = response.choices[0]?.message?.content?.trim() || null;
		logger.debug({ ms: Date.now() - t0, chars: text?.length }, '[HyDE] texto generado');
		return text;
	} catch (e) {
		logger.warn({ err: e.message, ms: Date.now() - t0 }, '[HyDE] error generando texto');
		return null;
	}
}

/**
 * Genera el embedding de un texto usando text-embedding-3-small.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embedText(text) {
	const openai = getOpenAI();
	try {
		const response = await openai.embeddings.create({
			model:      EMBEDDING_MODEL,
			input:      text.slice(0, 20000),
			dimensions: EMBEDDING_DIMS,
		});
		return response.data[0].embedding;
	} catch (e) {
		logger.warn({ err: e.message }, '[HyDE] error generando embedding');
		return null;
	}
}

// ── Interfaz pública ──────────────────────────────────────────────────────────

/**
 * Intenta obtener el embedding HyDE desde caché.
 * Si no existe, dispara la generación en background (fire-and-forget).
 *
 * @param {string} query    - Query original del usuario
 * @param {Object} filters  - Filtros de búsqueda (para la cache key)
 * @returns {Promise<number[]|null>} - Embedding cacheado, o null si no hay caché aún
 */
async function getHydeEmbedding(query, filters = {}) {
	if (!process.env.HYDE_ENABLED || process.env.HYDE_ENABLED !== 'true') return null;

	const redis = getRedis();
	if (!redis || !_redisAvailable) return null;

	const key = buildCacheKey(query, filters);

	try {
		const cached = await redis.get(key);
		if (cached) {
			const { embedding } = JSON.parse(cached);
			logger.debug({ key }, '[HyDE] cache hit');
			return embedding;
		}
	} catch (e) {
		logger.warn({ err: e.message }, '[HyDE] error leyendo caché');
		return null;
	}

	// Cache miss: disparar generación en background sin bloquear la respuesta
	logger.debug({ key }, '[HyDE] cache miss — generando en background');
	setImmediate(() => generateAndCache(query, filters, key, redis));

	return null; // el caller usa augmentation esta vez
}

/**
 * Genera el texto HyDE + embedding y lo guarda en Redis.
 * Se llama en background (no bloquea el request).
 */
async function generateAndCache(query, filters, key, redis) {
	try {
		const hydeText = await generateHydeText(query);
		if (!hydeText) return;

		const embedding = await embedText(hydeText);
		if (!embedding) return;

		const payload = JSON.stringify({ embedding, hydeText, query, filters, createdAt: Date.now() });
		await redis.set(key, payload, 'EX', HYDE_TTL_SEC);
		logger.info({ key, chars: hydeText.length }, '[HyDE] embedding cacheado');
	} catch (e) {
		logger.warn({ err: e.message }, '[HyDE] error en background generation');
	}
}

/**
 * Inicializa la conexión Redis al arrancar la API.
 * Llamar desde server.js o al primer uso del servicio.
 */
function initHydeCache() {
	if (process.env.HYDE_ENABLED === 'true') {
		getRedis(); // establece la conexión lazy
		logger.info('[HyDE] caché habilitado (HYDE_ENABLED=true)');
	}
}

module.exports = { getHydeEmbedding, initHydeCache };
