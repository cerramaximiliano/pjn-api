const OpenAI = require('openai').default;
const { Pinecone } = require('@pinecone-database/pinecone');
const AWS = require('aws-sdk');
const SentenciaCapturada = require('../models/SentenciaCapturada');
const { logger } = require('../config/pino');
const { getHydeEmbedding } = require('./hydeCache');

const EMBEDDING_MODEL_SMALL = 'text-embedding-3-small';
const EMBEDDING_MODEL_LARGE = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1024;
const MAX_INPUT_CHARS = 20000;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const DEFAULT_MIN_SCORE = 0.55;
const PINECONE_MULTIPLIER = 4; // pedir topK*4 a Pinecone para asegurar diversidad antes de deduplicar

// ── Hybrid scoring weights ────────────────────────────────────────────────────
// α × vector_score + (1-α) × bm25_normalized
const HYBRID_VECTOR_WEIGHT = 0.65;
const HYBRID_BM25_WEIGHT   = 0.35;

// BM25 tuning parameters (standard values)
const BM25_K1 = 1.5;
const BM25_B  = 0.75;
const BM25_AVG_DOC_LEN = 280; // tokens aprox por chunk de sentencia (calibrado al corpus)

let _openai = null;
let _pinecone = null;

function getOpenAI() {
	if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	return _openai;
}

function getPineconeClient() {
	if (!_pinecone) {
		// PINECONE_API_KEY es el nombre canónico (igual al que usa pjn-rag-shared).
		// PINECONE_KEY se mantiene como fallback por compatibilidad con envs viejos.
		const apiKey = process.env.PINECONE_API_KEY || process.env.PINECONE_KEY;
		if (!apiKey) throw new Error('PINECONE_API_KEY no configurada');
		_pinecone = new Pinecone({ apiKey });
	}
	return _pinecone;
}

const NAMESPACE_SMALL = process.env.PINECONE_SENTENCIAS_NAMESPACE || 'sentencias-corpus';
const NAMESPACE_LARGE = 'sentencias-large-test';

function getSentenciasIndex(namespaceOverride) {
	const client = getPineconeClient();
	const indexName = process.env.PINECONE_SENTENCIAS_INDEX || 'pjn-style-corpus-v2';
	const namespace = namespaceOverride || NAMESPACE_SMALL;
	return client.index(indexName).namespace(namespace);
}

function getS3() {
	return new AWS.S3({
		accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
		region: process.env.AWS_S3_REGION || 'us-east-1',
	});
}

function getS3BucketName() {
	return process.env.AWS_S3_BUCKET_NAME || 'pjn-rag-documents';
}

// ── BM25 híbrido ─────────────────────────────────────────────────────────────

/**
 * Stopwords del español legal. Se excluyen de la tokenización para que BM25
 * se enfoque en términos con contenido semántico real.
 */
const STOPWORDS_ES = new Set([
	'de','la','el','en','y','a','que','del','los','las','por','con','se','su','es','al',
	'un','una','para','no','lo','le','ha','si','me','te','más','pero','este','esta',
	'estos','estas','ese','esa','esos','esas','aquel','aquella','como','cuando','donde',
	'cual','cuales','quien','quienes','que','cuyo','cuya','cuyos','cuyas','ante','bajo',
	'contra','desde','hasta','hacia','sin','sobre','tras','entre','durante','mediante',
	'según','sino','aunque','porque','pues','ya','también','tampoco','ni','o','u','e',
	'así','bien','muy','tan','tanto','tanto','cuanto','todo','toda','todos','todas',
	'cada','otro','otra','otros','otras','mismo','misma','dicho','dicha','citado',
	'autos','causa','expediente','fs','fjs','fojas','ley','art','inc','decreto',
	'resolución','resoluciones','acuerdo','acuerdos','caso','casos',
]);

/**
 * Tokeniza texto para BM25. Extrae términos en minúsculas, elimina puntuación
 * y stopwords, normaliza números de artículos legales como tokens especiales.
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeBM25(text) {
	if (!text) return [];
	return text
		.toLowerCase()
		// Normalizar artículos: "art. 245", "artículo 178" → token "art245", "art178"
		.replace(/art[íi]culo\.?\s*(\d+)/gi, 'art$1')
		.replace(/art\.\s*(\d+)/gi, 'art$1')
		// Normalizar leyes: "ley 24557" → "ley24557"
		.replace(/ley\s*(\d+)/gi, 'ley$1')
		// Quitar puntuación conservando letras con tilde y ñ
		.replace(/[^\wáéíóúüñ\s]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 3 && !STOPWORDS_ES.has(t));
}

/**
 * Calcula el score BM25 de un documento respecto a los query terms.
 * Como no tenemos estadísticas de corpus, usamos IDF simplificado (log(2))
 * que prioriza TF y longitud del documento sin sesgo por frecuencia de términos.
 *
 * @param {string[]} queryTerms - Términos tokenizados de la query
 * @param {string}   docText    - Texto del chunk/documento
 * @returns {number}            - Score BM25 (no normalizado, ≥ 0)
 */
function bm25Score(queryTerms, docText) {
	if (!queryTerms.length || !docText) return 0;

	const tokens = tokenizeBM25(docText);
	const docLen = tokens.length || 1;

	// Frecuencia de términos en el documento
	const tf = {};
	for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

	let score = 0;
	const idf = Math.log(2); // IDF fijo (corpus no disponible en query-time)

	for (const term of queryTerms) {
		const f = tf[term] || 0;
		if (f === 0) continue;
		const numerator   = f * (BM25_K1 + 1);
		const denominator = f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / BM25_AVG_DOC_LEN));
		score += idf * (numerator / denominator);
	}
	return score;
}

/**
 * Combina el vector score de Pinecone con un score BM25 calculado sobre
 * los chunks ya recuperados. Reordena los resultados por score híbrido.
 *
 * Flujo:
 *   1. Tokenizar la query original (sin augmentation, para matching de términos exactos)
 *   2. Para cada resultado, calcular BM25 sobre el texto de sus matchedChunks
 *   3. Normalizar scores BM25 al rango [0, 1] (min-max sobre el batch)
 *   4. hybrid = HYBRID_VECTOR_WEIGHT × vector + HYBRID_BM25_WEIGHT × bm25_norm
 *   5. Reordenar y exponer el score híbrido como score final
 *
 * @param {string}   originalQuery - Query tal como la ingresó el usuario
 * @param {Array}    results       - Array de resultados enriquecidos
 * @returns {Array}                - Resultados reordenados por score híbrido
 */
function hybridRerank(originalQuery, results) {
	if (results.length <= 1) return results;

	const queryTerms = tokenizeBM25(originalQuery);
	if (queryTerms.length === 0) return results; // query sin términos útiles → sin reranking

	// Calcular BM25 para cada resultado usando el texto de sus matched chunks
	const bm25Scores = results.map(r => {
		const docText = r.matchedChunks.map(c => c.text).join(' ');
		return bm25Score(queryTerms, docText);
	});

	// Normalizar BM25 a [0, 1] (min-max)
	const maxBm25 = Math.max(...bm25Scores);
	const minBm25 = Math.min(...bm25Scores);
	const rangeBm25 = maxBm25 - minBm25 || 1;

	const reranked = results.map((r, i) => {
		const bm25Norm = (bm25Scores[i] - minBm25) / rangeBm25;
		const hybridScore = HYBRID_VECTOR_WEIGHT * r.score + HYBRID_BM25_WEIGHT * bm25Norm;
		return { ...r, score: Math.round(hybridScore * 10000) / 10000 };
	});

	return reranked.sort((a, b) => b.score - a.score);
}

/**
 * Mapa de sinónimos jurídicos argentinos para query augmentation.
 * Amplía el vocabulario de la query antes de embeber, mejorando la cobertura
 * semántica sin necesidad de llamadas a GPT (sin latencia adicional).
 */
const LEGAL_SYNONYMS = {
	// Responsabilidad civil / accidentes
	'accidente de tránsito':      'accidente de tránsito siniestro vial colisión vehicular choque responsabilidad civil daños y perjuicios',
	'accidente':                  'accidente siniestro colisión choque responsabilidad civil',
	'atropellamiento':            'atropellamiento accidente peatón responsabilidad civil daños',
	'daño moral':                 'daño moral daño extrapatrimonial daño psicológico padecimiento reparación resarcimiento',
	'daño extrapatrimonial':      'daño extrapatrimonial daño moral padecimiento sufrimiento reparación',
	'daño psicológico':           'daño psicológico daño psíquico incapacidad psicológica secuelas daño moral',
	'mala praxis':                'mala praxis negligencia médica responsabilidad profesional médico',

	// Laboral
	'despido sin causa':          'despido sin causa despido injustificado ruptura contrato laboral indemnización artículo 245 LCT',
	'despido':                    'despido sin causa rescisión contrato laboral indemnización LCT',
	'despido por embarazo':       'despido por embarazo nulidad despido maternidad reinstalación protección maternidad artículo 178 LCT',
	'horas extras':               'horas extras horas suplementarias tiempo extra jornada adicional trabajo fuera horario',
	'accidente laboral':          'accidente laboral accidente de trabajo infortunio laboral incapacidad ART ley 24557',
	'accidente de trabajo':       'accidente de trabajo infortunio laboral incapacidad permanente ART ley 24557 riesgos trabajo',
	'solidaridad laboral':        'solidaridad laboral empleador principal contratista subcontratista artículo 30 LCT',

	// Previsional / Seguridad social
	'jubilación':                 'jubilación haber previsional beneficio jubilatorio ANSES retiro',
	'reajuste jubilación':        'reajuste haber jubilatorio movilidad previsional actualización jubilación ANSES',
	'movilidad jubilatoria':      'movilidad jubilatoria reajuste haber previsional actualización jubilación ANSES',
	'haber previsional':          'haber previsional jubilación beneficio ANSES movilidad reajuste',

	// Procesal
	'caducidad de instancia':     'caducidad de instancia perención abandono proceso inactividad procesal',
	'perención':                  'perención caducidad instancia abandono proceso inactividad',
	'medida cautelar':            'medida cautelar embargo preventivo inhibición general bienes prohibición innovar',
	'embargo':                    'embargo preventivo embargo ejecutivo medida cautelar traba embargo',
	'prescripción':               'prescripción liberatoria prescripción acción plazo prescriptivo caducidad derecho',

	// Civil / Contratos
	'usucapión':                  'usucapión prescripción adquisitiva posesión veinteañal inmueble dominio',
	'nulidad':                    'nulidad acto jurídico invalidez nulidad contrato vicio consentimiento',
	'daños y perjuicios':         'daños y perjuicios responsabilidad civil reparación indemnización resarcimiento',
	'indemnización':              'indemnización resarcimiento reparación daños y perjuicios compensación',

	// Ejecuciones / Honorarios
	'honorarios':                 'honorarios regulación honorarios aranceles profesionales retribución',
	'ejecución hipotecaria':      'ejecución hipotecaria subasta inmueble remate judicial hipoteca',
};

/**
 * Query augmentation con sinónimos jurídicos.
 * Expande la query con vocabulario equivalente del dominio legal argentino,
 * mejorando la cobertura semántica sin llamadas a APIs externas.
 */
function augmentQueryWithSynonyms(query) {
	const q = query.toLowerCase().trim();
	const augmentations = [];

	for (const [term, expansion] of Object.entries(LEGAL_SYNONYMS)) {
		if (q.includes(term)) {
			augmentations.push(expansion);
		}
	}

	if (augmentations.length === 0) {
		// Sin sinónimos específicos: agregar contexto jurídico genérico para queries cortas
		const words = q.split(/\s+/);
		if (words.length <= 5) {
			return `Sentencia judicial argentina: ${query}. Considerando: ${query}.`;
		}
		return query;
	}

	// Combinar la query original con las expansiones (sin duplicar)
	const allTerms = [query, ...augmentations];
	return [...new Set(allTerms)].join(' | ');
}

async function embedQuery(text, model) {
	const start = Date.now();
	const openai = getOpenAI();
	const response = await openai.embeddings.create({
		model: model || EMBEDDING_MODEL_SMALL,
		input: text.slice(0, MAX_INPUT_CHARS),
		dimensions: EMBEDDING_DIMENSIONS,
	});
	return {
		embedding: response.data[0].embedding,
		latencyMs: Date.now() - start,
	};
}

function buildPineconeFilter(filters = {}) {
	const filter = {};

	if (filters.fuero) filter.fuero = { $eq: filters.fuero };
	if (filters.year) filter.year = { $eq: Number(filters.year) };
	if (filters.sentenciaTipo) filter.sentenciaTipo = { $eq: filters.sentenciaTipo };
	if (filters.category) filter.category = { $eq: filters.category };

	if (filters.dateFrom || filters.dateTo) {
		filter.movimientoFecha = {};
		if (filters.dateFrom) filter.movimientoFecha.$gte = new Date(filters.dateFrom).toISOString();
		if (filters.dateTo) filter.movimientoFecha.$lte = new Date(filters.dateTo).toISOString();
	}

	// Para búsqueda por similitud: excluir la sentencia fuente
	if (filters.excludeSentenciaId) {
		filter.sentenciaId = { $ne: filters.excludeSentenciaId };
	}

	return Object.keys(filter).length > 0 ? filter : undefined;
}

async function queryPinecone(embedding, { topK, filter, namespace }) {
	const start = Date.now();
	const index = getSentenciasIndex(namespace);

	const queryParams = { vector: embedding, topK, includeMetadata: true };
	if (filter) queryParams.filter = filter;

	const result = await index.query(queryParams);
	const matches = result.matches || [];
	return {
		matches,
		latencyMs: Date.now() - start,
	};
}

function groupMatchesBySentencia(matches, topK, minScore) {
	const groups = new Map();

	for (const match of matches) {
		const meta = match.metadata || {};
		const sentenciaId = meta.sentenciaId;
		if (!sentenciaId || match.score < minScore) continue;

		if (!groups.has(sentenciaId)) {
			groups.set(sentenciaId, {
				sentenciaId,
				score: match.score,
				matchedChunksByIndex: new Map(),
				pineconeMetadata: meta,
			});
		}

		const group = groups.get(sentenciaId);
		if (match.score > group.score) group.score = match.score;

		const chunkIndex = meta.chunkIndex;
		if (chunkIndex !== undefined && !group.matchedChunksByIndex.has(chunkIndex)) {
			group.matchedChunksByIndex.set(chunkIndex, { score: match.score, vectorId: match.id });
		}
	}

	return Array.from(groups.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);
}

async function downloadChunksFromS3(causaId, sentenciaId) {
	const s3 = getS3();
	const key = `sentencias/${causaId}/chunks/${sentenciaId}.json`;
	try {
		const result = await s3.getObject({ Bucket: getS3BucketName(), Key: key }).promise();
		return JSON.parse(result.Body.toString('utf-8'));
	} catch (err) {
		if (err.code === 'NoSuchKey') return null;
		throw err;
	}
}

async function enrichGroup(group, includeFullText) {
	const { sentenciaId, score, matchedChunksByIndex } = group;

	// Usar el driver nativo para evitar problemas de inicialización del modelo Mongoose
	// en entornos donde dotenv carga después del require() de los modelos (ej: PM2).
	const mongoose = require('mongoose');
	const { ObjectId } = require('mongoose').Types;
	const doc = await mongoose.connection.db.collection('sentencias-capturadas').findOne(
		{ _id: new ObjectId(sentenciaId) },
		{ projection: { causaId: 1, number: 1, year: 1, fuero: 1, caratula: 1, juzgado: 1, sala: 1, organizacionTextoCompleto: 1, movimientoFecha: 1, movimientoTipo: 1, movimientoDetalle: 1, sentenciaTipo: 1, category: 1, aiSummary: 1, embeddingChunksCount: 1, embeddedAt: 1 } }
	);

	if (!doc) return null;

	let allChunks = null;
	try {
		allChunks = await downloadChunksFromS3(doc.causaId.toString(), sentenciaId);
	} catch (err) {
		logger.warn({ err: err.message, sentenciaId }, '[SentenciasSearch] Error descargando chunks de S3');
	}

	// Reconstruir matchedChunks con el texto real de S3 y el score de Pinecone
	const matchedChunks = [];
	if (allChunks) {
		for (const chunk of allChunks) {
			const matchInfo = matchedChunksByIndex.get(chunk.index);
			if (matchInfo) {
				matchedChunks.push({
					index: chunk.index,
					sectionType: chunk.sectionType,
					text: chunk.text,
					score: matchInfo.score,
				});
			}
		}
		matchedChunks.sort((a, b) => b.score - a.score);
	}

	const result = {
		sentencia: {
			_id: doc._id,
			causaId: doc.causaId,
			number: doc.number,
			year: doc.year,
			fuero: doc.fuero,
			caratula: doc.caratula,
			juzgado: doc.juzgado,
			sala: doc.sala,
			organizacion: doc.organizacionTextoCompleto,
			movimientoFecha: doc.movimientoFecha,
			movimientoTipo: doc.movimientoTipo,
			sentenciaTipo: doc.sentenciaTipo,
			category: doc.category,
			embeddedAt: doc.embeddedAt,
			...(doc.aiSummary?.status === 'approved' ? { aiSummary: doc.aiSummary } : {}),
		},
		score: Math.round(score * 10000) / 10000,
		matchedChunks,
	};

	if (includeFullText && allChunks) {
		const matchedIndexes = new Set(matchedChunksByIndex.keys());
		result.fullChunks = allChunks
			.sort((a, b) => a.index - b.index)
			.map(chunk => {
				const matchInfo = matchedChunksByIndex.get(chunk.index);
				return {
					index: chunk.index,
					sectionType: chunk.sectionType,
					text: chunk.text,
					matched: matchedIndexes.has(chunk.index),
					...(matchInfo ? { score: Math.round(matchInfo.score * 10000) / 10000 } : {}),
				};
			});
	}

	return result;
}

/**
 * Búsqueda semántica de sentencias por texto libre.
 * @param {string} query - Texto de búsqueda en lenguaje natural
 * @param {Object} opts
 * @param {Object} opts.filters - Filtros opcionales: fuero, year, sentenciaTipo, category, dateFrom, dateTo
 * @param {number} opts.topK - Cantidad máxima de resultados (default 5, max 20)
 * @param {number} opts.minScore - Score mínimo de relevancia (default 0.70)
 * @param {boolean} opts.includeFullText - Incluir todos los chunks del fallo con flags matched (default false)
 * @param {string} opts.namespace - Namespace de Pinecone ('sentencias-corpus' | 'sentencias-large-test')
 */
async function searchByQuery(query, { filters = {}, topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE, includeFullText = false, namespace } = {}) {
	topK = Math.min(topK, MAX_TOP_K);
	const pineconeTopK = topK * PINECONE_MULTIPLIER;

	// Determinar modelo de embedding según namespace
	const isLargeNamespace = namespace === NAMESPACE_LARGE;
	const embeddingModel = isLargeNamespace ? EMBEDDING_MODEL_LARGE : EMBEDDING_MODEL_SMALL;

	// 1. Intentar embedding HyDE desde caché Redis (0ms si hit, null si miss)
	//    HyDE solo aplica al namespace estándar (small) — el large usa embedding directo
	//    ya que el corpus large fue indexado sin HyDE.
	const hydeEmbedding = !isLargeNamespace ? await getHydeEmbedding(query, filters) : null;

	// 2. Si no hay HyDE cacheado: embedding directo del query (sin augmentQueryWithSynonyms).
	//    La augmentación de sinónimos perjudica la recuperación en búsquedas de jurisprudencia
	//    porque desplaza el embedding lejos del texto exacto indexado en Pinecone.
	const { embedding, latencyMs: embeddingLatencyMs } = hydeEmbedding
		? { embedding: hydeEmbedding, latencyMs: 0 }
		: await embedQuery(query, embeddingModel);

	const filter = buildPineconeFilter(filters);
	const { matches, latencyMs: pineconeLatencyMs } = await queryPinecone(embedding, {
		topK: pineconeTopK,
		filter,
		namespace,
	});

	const groups = groupMatchesBySentencia(matches, topK, minScore);

	const enrichStart = Date.now();
	const enriched = await Promise.all(groups.map(g => enrichGroup(g, includeFullText)));
	const enrichmentLatencyMs = Date.now() - enrichStart;

	const deduped  = deduplicateResults(enriched.filter(Boolean));
	const results  = hybridRerank(query, deduped);

	return {
		results,
		total: results.length,
		namespace: namespace || NAMESPACE_SMALL,
		latencyMs: {
			embedding: embeddingLatencyMs,
			pinecone: pineconeLatencyMs,
			enrichment: enrichmentLatencyMs,
			total: embeddingLatencyMs + pineconeLatencyMs + enrichmentLatencyMs,
		},
	};
}

/**
 * Elimina resultados duplicados (misma sentencia indexada dos veces en Pinecone
 * con distinto _id). La clave de dedup es caratula+fuero+year; gana el de mayor score.
 */
function deduplicateResults(results) {
	const seen = new Map();
	for (const r of results) {
		const key = `${(r.sentencia.caratula || '').trim().toLowerCase()}|${r.sentencia.fuero}|${r.sentencia.year}`;
		const existing = seen.get(key);
		if (!existing || r.score > existing.score) {
			seen.set(key, r);
		}
	}
	return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}

/**
 * Búsqueda de sentencias similares a una dada.
 * @param {string} sentenciaId - _id de la sentencia fuente
 * @param {Object} opts
 * @param {number} opts.topK - Cantidad máxima de resultados (default 5, max 20)
 * @param {number} opts.minScore - Score mínimo de relevancia (default 0.70)
 * @param {boolean} opts.includeFullText - Incluir todos los chunks (default false)
 */
async function searchBySimilarity(sentenciaId, { topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE, includeFullText = false } = {}) {
	topK = Math.min(topK, MAX_TOP_K);

	const mongoose = require('mongoose');
	const { ObjectId } = require('mongoose').Types;
	const sourceSentencia = await mongoose.connection.db.collection('sentencias-capturadas').findOne(
		{ _id: new ObjectId(sentenciaId) },
		{ projection: { causaId: 1, fuero: 1, sentenciaTipo: 1, embeddingStatus: 1 } }
	);

	if (!sourceSentencia) throw new Error('Sentencia no encontrada');
	if (sourceSentencia.embeddingStatus !== 'completed') {
		throw new Error('La sentencia no tiene embeddings indexados');
	}

	const chunks = await downloadChunksFromS3(sourceSentencia.causaId.toString(), sentenciaId);
	if (!chunks || chunks.length === 0) {
		throw new Error('No se encontraron chunks en S3 para esta sentencia');
	}

	// Usar secciones más semánticamente ricas como query
	const prioritySections = ['considerando', 'resolucion', 'voto'];
	const queryChunks = chunks.filter(c => prioritySections.includes(c.sectionType)).slice(0, 3);
	const queryText = (queryChunks.length > 0 ? queryChunks : chunks.slice(0, 3))
		.map(c => c.text)
		.join('\n\n');

	const { embedding, latencyMs: embeddingLatencyMs } = await embedQuery(queryText);

	const filter = buildPineconeFilter({ excludeSentenciaId: sentenciaId });
	const pineconeTopK = topK * PINECONE_MULTIPLIER;

	const { matches, latencyMs: pineconeLatencyMs } = await queryPinecone(embedding, {
		topK: pineconeTopK,
		filter,
	});

	const groups = groupMatchesBySentencia(matches, topK, minScore);

	const enrichStart = Date.now();
	const enriched = await Promise.all(groups.map(g => enrichGroup(g, includeFullText)));
	const enrichmentLatencyMs = Date.now() - enrichStart;

	const deduped  = deduplicateResults(enriched.filter(Boolean));
	// Para búsqueda por similitud usamos queryText como query de BM25
	const results  = hybridRerank(queryText.slice(0, 500), deduped);

	return {
		results,
		total: results.length,
		sourceSentenciaId: sentenciaId,
		latencyMs: {
			embedding: embeddingLatencyMs,
			pinecone: pineconeLatencyMs,
			enrichment: enrichmentLatencyMs,
			total: embeddingLatencyMs + pineconeLatencyMs + enrichmentLatencyMs,
		},
	};
}

/**
 * Devuelve todos los chunks de una sentencia desde S3.
 * @param {string} sentenciaId - _id de la sentencia
 */
async function getChunks(sentenciaId) {
	const mongoose = require('mongoose');
	const { ObjectId } = require('mongoose').Types;
	const doc = await mongoose.connection.db.collection('sentencias-capturadas').findOne(
		{ _id: new ObjectId(sentenciaId) },
		{ projection: { causaId: 1, embeddingStatus: 1 } }
	);

	if (!doc) throw new Error('Sentencia no encontrada');
	if (doc.embeddingStatus !== 'completed') throw new Error('La sentencia no tiene chunks indexados');

	const chunks = await downloadChunksFromS3(doc.causaId.toString(), sentenciaId);
	if (!chunks || chunks.length === 0) throw new Error('No se encontraron chunks en S3 para esta sentencia');

	return chunks.sort((a, b) => a.index - b.index);
}

module.exports = { searchByQuery, searchBySimilarity, getChunks };
