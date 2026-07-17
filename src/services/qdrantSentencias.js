/**
 * Adaptador Qdrant para la búsqueda de sentencias (pjn-api).
 *
 * pjn-api no depende de pjn-rag-shared, así que replica acá la parte mínima
 * necesaria: query contra la colección 'sentencias' de Qdrant, con traducción
 * de filtros estilo Pinecone y devolución en la misma forma ({ matches: [...] }).
 *
 * Los ids string originales viven en payload._origId y se devuelven como `id`,
 * de modo que groupMatchesBySentencia/enrichGroup siguen funcionando igual.
 *
 * Activación: VECTOR_BACKEND=qdrant. Requiere QDRANT_URL + QDRANT_API_KEY.
 */
// La config se lee en tiempo de EJECUCIÓN (no al cargar el módulo): server.js
// requiere las rutas —y por ende este módulo— ANTES de correr dotenv.config()
// (los secrets se bajan de AWS async en initializeServer). Si se leyera acá al
// tope, QDRANT_URL/API_KEY quedarían en sus defaults y la búsqueda pegaría al
// Qdrant equivocado (o Pinecone).
function qdrantConfig() {
  return {
    url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    apiKey: process.env.QDRANT_API_KEY || '',
    collection: process.env.QDRANT_SENTENCIAS_COLLECTION || 'sentencias',
    oversampling: parseFloat(process.env.QDRANT_SENTENCIAS_OVERSAMPLING || '2.0'),
    hnswEf: parseInt(process.env.QDRANT_SENTENCIAS_HNSW_EF || '256', 10),
  };
}

function translateFilter(f) {
  if (!f || typeof f !== 'object') return undefined;
  const must = [], must_not = [];
  for (const [key, cond] of Object.entries(f)) {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$eq'  in cond) must.push({ key, match: { value: cond.$eq } });
      if ('$ne'  in cond) must_not.push({ key, match: { value: cond.$ne } });
      if ('$in'  in cond) must.push({ key, match: { any: cond.$in } });
      if ('$nin' in cond) must_not.push({ key, match: { any: cond.$nin } });
      const range = {};
      if ('$gt'  in cond) range.gt  = cond.$gt;
      if ('$gte' in cond) range.gte = cond.$gte;
      if ('$lt'  in cond) range.lt  = cond.$lt;
      if ('$lte' in cond) range.lte = cond.$lte;
      if (Object.keys(range).length) must.push({ key, range });
    } else {
      must.push({ key, match: { value: cond } });
    }
  }
  const out = {};
  if (must.length) out.must = must;
  if (must_not.length) out.must_not = must_not;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Query semántica a Qdrant. Devuelve { matches: [{ id, score, metadata }] }
 * con la misma forma que Pinecone.
 */
async function queryQdrant(vector, { topK = 20, filter } = {}) {
  const cfg = qdrantConfig();
  const body = {
    vector,
    limit: topK,
    with_payload: true,
    with_vector: false,
    params: { hnsw_ef: cfg.hnswEf, quantization: { rescore: true, oversampling: cfg.oversampling } },
  };
  const qf = translateFilter(filter);
  if (qf) body.filter = qf;
  const res = await fetch(`${cfg.url}/collections/${cfg.collection}/points/search`, {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Qdrant search → ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = await res.json();
  const matches = (j.result || []).map(m => {
    const meta = m.payload || {};
    return {
      id: meta._origId !== undefined ? meta._origId : m.id,
      score: m.score,
      metadata: meta,
    };
  });
  return { matches };
}

module.exports = { queryQdrant, translateFilter };
