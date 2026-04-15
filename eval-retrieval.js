/**
 * eval-retrieval.js — Prueba 1: Recuperación de documento conocido
 *
 * Para cada sentencia del corpus large (5k docs):
 *   1. Descarga sus chunks de S3
 *   2. Extrae el fragmento más representativo del texto (evita boilerplate)
 *   3. Embeda el fragmento DIRECTAMENTE (sin augmentQueryWithSynonyms) con cada modelo
 *   4. Verifica si el modelo recupera la sentencia original en top-1, top-3, top-5, top-10
 *
 * Métricas reportadas:
 *   - Recall@1, Recall@3, Recall@5, Recall@10 para cada modelo
 *   - Score promedio cuando el doc es encontrado vs. cuando no
 *   - Distribución de ranks cuando el doc es recuperado
 *
 * Nota: usamos embedding crudo (sin sinónimos) porque queremos medir la calidad
 * del modelo vectorial, no el impacto de la augmentación de queries.
 *
 * Uso:
 *   node eval-retrieval.js             # muestra de 100 sentencias
 *   node eval-retrieval.js --sample 50
 *   node eval-retrieval.js --sample 200
 */
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const AWS = require('aws-sdk');
const OpenAI = require('openai').default;
const { Pinecone } = require('@pinecone-database/pinecone');

const SAMPLE = parseInt(process.argv.find((a, i) => process.argv[i-1] === '--sample') || '100');
const NAMESPACE_SMALL = 'sentencias-corpus';
const NAMESPACE_LARGE = 'sentencias-large-test';
const TOP_K = 20; // buscar en top-20 para medir recall@1/3/5/10
const EMBEDDING_DIMS = 1024;
const PINECONE_MULTIPLIER = 6; // pedir topK*6 chunks para deduplicar bien
const MIN_FRAGMENT_LENGTH = 150;
const FRAGMENT_LENGTH = 350;

// ── Selección de fragmento ────────────────────────────────────────────────────
// Criterios en orden de prioridad:
// 1. Sección 'considerando' o 'resolucion' con >300 chars
// 2. El chunk más largo de cualquier sección
// Dentro del chunk elegido, toma 350 chars desde el 30% del texto
// (evita encabezados genéricos al inicio, y cortes al final)

function extractQueryFragment(chunks) {
  const preferredSections = ['considerando', 'resolucion', 'antecedentes', 'visto'];

  // Primero: buscar sección preferida con contenido sustancial
  for (const section of preferredSections) {
    const candidates = chunks
      .filter(c => c.sectionType === section && (c.text || '').length >= MIN_FRAGMENT_LENGTH + 50)
      .sort((a, b) => b.text.length - a.text.length); // el más largo primero
    if (candidates.length > 0) {
      const text = candidates[0].text;
      const start = Math.floor(text.length * 0.30);
      return text.slice(start, start + FRAGMENT_LENGTH).trim();
    }
  }

  // Fallback: el chunk más largo de cualquier tipo
  const longest = chunks
    .filter(c => (c.text || '').length >= MIN_FRAGMENT_LENGTH)
    .sort((a, b) => b.text.length - a.text.length)[0];

  if (longest) {
    const start = Math.floor(longest.text.length * 0.20);
    return longest.text.slice(start, start + FRAGMENT_LENGTH).trim();
  }

  return null;
}

// ── S3 ────────────────────────────────────────────────────────────────────────

async function downloadChunks(causaId, sentenciaId) {
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
    region: process.env.AWS_S3_REGION || 'us-east-1',
  });
  const bucket = process.env.AWS_S3_BUCKET_NAME || 'pjn-rag-documents';
  const key = `sentencias/${causaId}/chunks/${sentenciaId}.json`;
  try {
    const result = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    return JSON.parse(result.Body.toString('utf-8'));
  } catch (e) {
    return null;
  }
}

// ── Embedding directo (sin augmentation) ─────────────────────────────────────

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

async function embedRaw(text, model) {
  const res = await getOpenAI().embeddings.create({
    model,
    input: text.slice(0, 20000),
    dimensions: EMBEDDING_DIMS,
  });
  return res.data[0].embedding;
}

// ── Pinecone query ────────────────────────────────────────────────────────────

let _pinecone = null;
function getPinecone() {
  if (!_pinecone) {
    const apiKey = process.env.PINECONE_API_KEY || process.env.PINECONE_KEY;
    _pinecone = new Pinecone({ apiKey });
  }
  return _pinecone;
}

async function queryNamespace(vector, namespace) {
  const indexName = process.env.PINECONE_SENTENCIAS_INDEX || 'pjn-style-corpus-v2';
  const index = getPinecone().index(indexName).namespace(namespace);
  const res = await index.query({
    vector,
    topK: TOP_K * PINECONE_MULTIPLIER,
    includeMetadata: true,
  });
  return res.matches || [];
}

// ── Deduplicar por sentenciaId y calcular rank ────────────────────────────────

function deduplicateMatches(matches) {
  // Agrupa por sentenciaId, toma el score máximo
  const map = new Map();
  for (const m of matches) {
    const id = m.metadata?.sentenciaId;
    if (!id) continue;
    if (!map.has(id) || m.score > map.get(id).score) {
      map.set(id, { id, score: m.score });
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function rankOf(deduped, targetId) {
  const idx = deduped.findIndex(r => r.id === targetId);
  return idx === -1 ? null : idx + 1; // 1-based
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const URLDB = process.env.URLDB;
  if (!URLDB) { console.error('URLDB no definida'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY no definida'); process.exit(1); }
  if (!process.env.PINECONE_API_KEY && !process.env.PINECONE_KEY) { console.error('PINECONE_API_KEY no definida'); process.exit(1); }

  console.log('Conectando a MongoDB...');
  await mongoose.connect(URLDB);

  const db = mongoose.connection.db;

  // Seleccionar muestra aleatoria del corpus large
  console.log(`Seleccionando muestra de ${SAMPLE} sentencias del corpus large...`);
  const docs = await db.collection('sentencias-capturadas').aggregate([
    { $match: { embeddingLargeStatus: 'done', embeddingChunksCount: { $gt: 3 } } },
    { $sample: { size: SAMPLE } },
    { $project: { _id: 1, causaId: 1, caratula: 1, fuero: 1, year: 1 } },
  ]).toArray();

  console.log(`Muestra obtenida: ${docs.length} sentencias`);
  console.log(`Método: embedding crudo (sin augmentQueryWithSynonyms), topK=${TOP_K}\n`);
  console.log(`${'#'.padStart(4)} ${'Fuero'.padEnd(5)} ${'Rk Small'.padStart(9)} ${'Rk Large'.padStart(9)} ${'Score S'.padStart(8)} ${'Score L'.padStart(8)} ${'Sección'.padEnd(13)} Carátula`);
  console.log('─'.repeat(120));

  const stats = {
    small: { found1: 0, found3: 0, found5: 0, found10: 0, scores: [], ranksWhenFound: [] },
    large: { found1: 0, found3: 0, found5: 0, found10: 0, scores: [], ranksWhenFound: [] },
    bothFound: 0, neitherFound: 0, onlySmall: 0, onlyLarge: 0,
    total: 0, skipped: 0,
    skipReasons: { noCausaId: 0, noChunks: 0, shortFragment: 0 },
  };

  const details = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const docId = doc._id.toString();
    const causaId = doc.causaId?.toString();

    if (!causaId) { stats.skipped++; stats.skipReasons.noCausaId++; continue; }

    const chunks = await downloadChunks(causaId, docId);
    if (!chunks || chunks.length === 0) { stats.skipped++; stats.skipReasons.noChunks++; continue; }

    const fragment = extractQueryFragment(chunks);
    if (!fragment || fragment.length < MIN_FRAGMENT_LENGTH) { stats.skipped++; stats.skipReasons.shortFragment++; continue; }

    // Detectar qué sección se usó
    const usedSection = chunks.find(c =>
      fragment.includes(c.text?.slice(Math.floor(c.text.length * 0.30), Math.floor(c.text.length * 0.30) + 50))
    )?.sectionType || '?';

    stats.total++;

    // Embeder con ambos modelos en paralelo
    const [vecSmall, vecLarge] = await Promise.all([
      embedRaw(fragment, 'text-embedding-3-small'),
      embedRaw(fragment, 'text-embedding-3-large'),
    ]);

    // Consultar Pinecone en paralelo
    const [matchesSmall, matchesLarge] = await Promise.all([
      queryNamespace(vecSmall, NAMESPACE_SMALL),
      queryNamespace(vecLarge, NAMESPACE_LARGE),
    ]);

    const dedupSmall = deduplicateMatches(matchesSmall);
    const dedupLarge = deduplicateMatches(matchesLarge);

    const rankSmall = rankOf(dedupSmall, docId);
    const rankLarge = rankOf(dedupLarge, docId);
    const scoreSmall = rankSmall ? dedupSmall[rankSmall - 1].score : null;
    const scoreLarge = rankLarge ? dedupLarge[rankLarge - 1].score : null;

    // Métricas small
    if (rankSmall !== null) {
      if (rankSmall <= 1)  stats.small.found1++;
      if (rankSmall <= 3)  stats.small.found3++;
      if (rankSmall <= 5)  stats.small.found5++;
      if (rankSmall <= 10) stats.small.found10++;
      stats.small.scores.push(scoreSmall);
      stats.small.ranksWhenFound.push(rankSmall);
    }

    // Métricas large
    if (rankLarge !== null) {
      if (rankLarge <= 1)  stats.large.found1++;
      if (rankLarge <= 3)  stats.large.found3++;
      if (rankLarge <= 5)  stats.large.found5++;
      if (rankLarge <= 10) stats.large.found10++;
      stats.large.scores.push(scoreLarge);
      stats.large.ranksWhenFound.push(rankLarge);
    }

    if (rankSmall !== null && rankLarge !== null) stats.bothFound++;
    else if (rankSmall === null && rankLarge === null) stats.neitherFound++;
    else if (rankSmall !== null) stats.onlySmall++;
    else stats.onlyLarge++;

    const sRankStr = rankSmall ? `#${rankSmall}`.padStart(9) : '    —'.padStart(9);
    const lRankStr = rankLarge ? `#${rankLarge}`.padStart(9) : '    —'.padStart(9);
    const sScoreStr = scoreSmall ? scoreSmall.toFixed(4).padStart(8) : '    —'.padStart(8);
    const lScoreStr = scoreLarge ? scoreLarge.toFixed(4).padStart(8) : '    —'.padStart(8);
    const caratula = (doc.caratula || '').slice(0, 40);

    console.log(`${(i+1).toString().padStart(4)} ${(doc.fuero||'').padEnd(5)}${sRankStr}${lRankStr}${sScoreStr}${lScoreStr} ${usedSection.padEnd(13)} ${caratula}`);

    details.push({ docId, fuero: doc.fuero, year: doc.year, caratula: doc.caratula, rankSmall, rankLarge, scoreSmall, scoreLarge, usedSection, fragment: fragment.slice(0, 100) });
  }

  // Resumen
  const n = stats.total;
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4) : 'N/A';
  const pct = (x) => n > 0 ? ((x/n)*100).toFixed(1) + '%' : 'N/A';

  console.log('\n══ RESULTADOS ═══════════════════════════════════════════════════════════');
  console.log(`Sentencias evaluadas: ${n} (omitidas: ${stats.skipped})`);
  if (stats.skipped > 0) {
    console.log(`  Sin causaId: ${stats.skipReasons.noCausaId} | Sin chunks S3: ${stats.skipReasons.noChunks} | Fragmento corto: ${stats.skipReasons.shortFragment}`);
  }
  console.log();
  console.log(`${'Métrica'.padEnd(35)} ${'Small'.padStart(10)} ${'Large'.padStart(10)}`);
  console.log('─'.repeat(57));
  console.log(`${'Recall@1'.padEnd(35)} ${pct(stats.small.found1).padStart(10)} ${pct(stats.large.found1).padStart(10)}`);
  console.log(`${'Recall@3'.padEnd(35)} ${pct(stats.small.found3).padStart(10)} ${pct(stats.large.found3).padStart(10)}`);
  console.log(`${'Recall@5'.padEnd(35)} ${pct(stats.small.found5).padStart(10)} ${pct(stats.large.found5).padStart(10)}`);
  console.log(`${'Recall@10'.padEnd(35)} ${pct(stats.small.found10).padStart(10)} ${pct(stats.large.found10).padStart(10)}`);
  console.log(`${'Score prom. (cuando encuentra)'.padEnd(35)} ${avg(stats.small.scores).padStart(10)} ${avg(stats.large.scores).padStart(10)}`);
  console.log(`${'Rank prom. (cuando encuentra)'.padEnd(35)} ${avg(stats.small.ranksWhenFound).padStart(10)} ${avg(stats.large.ranksWhenFound).padStart(10)}`);
  console.log('─'.repeat(57));
  console.log(`${'Ambos encuentran'.padEnd(35)} ${stats.bothFound.toString().padStart(10)}`);
  console.log(`${'Solo small'.padEnd(35)} ${stats.onlySmall.toString().padStart(10)}`);
  console.log(`${'Solo large'.padEnd(35)} ${stats.onlyLarge.toString().padStart(10)}`);
  console.log(`${'Ninguno'.padEnd(35)} ${stats.neitherFound.toString().padStart(10)}`);
  console.log('═════════════════════════════════════════════════════════════════════════');

  const fs = require('fs');
  const outFile = `eval-results/eval-retrieval-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  fs.mkdirSync('eval-results', { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ stats, details }, null, 2));
  console.log(`\nResultados guardados en: ${outFile}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
