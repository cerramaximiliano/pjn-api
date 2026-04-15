/**
 * Script de evaluación de búsqueda semántica de sentencias.
 *
 * Uso:
 *   node eval-search.js                        # namespace default (sentencias-corpus, small)
 *   node eval-search.js --namespace large      # namespace sentencias-large-test
 *   node eval-search.js --compare              # corre ambos (small en corpus completo vs large)
 *   node eval-search.js --compare --fair       # compara ambos SOLO sobre los docs indexados en large (comparación justa)
 */
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');

const USE_LARGE   = process.argv.includes('--namespace') && process.argv[process.argv.indexOf('--namespace') + 1] === 'large';
const COMPARE     = process.argv.includes('--compare');
const FAIR        = process.argv.includes('--fair'); // restringir small al mismo corpus que large
const NAMESPACE_SMALL = 'sentencias-corpus';
const NAMESPACE_LARGE = 'sentencias-large-test';

const QUERIES = [
  { q: 'accidente de tránsito' },
  { q: 'daño moral' },
  { q: 'despido sin causa' },
  { q: 'caducidad de instancia' },
  { q: 'indemnización por accidente laboral con incapacidad permanente' },
  { q: 'reajuste de haberes previsionales jubilación' },
  { q: 'medida cautelar embargo preventivo' },
  { q: 'usucapión prescripción adquisitiva inmueble' },
  { q: 'responsabilidad civil del conductor por lesiones a peatón en zona urbana' },
  { q: 'nulidad de despido por embarazo y reinstalación en el puesto de trabajo' },
  { q: 'determinación del quantum indemnizatorio en daño psicológico permanente' },
  { q: 'prescripción de la acción por daños derivados de accidente de tránsito' },
  { q: 'solidaridad del empleador principal por deudas laborales del subcontratista' },
  { q: 'inconstitucionalidad del tope indemnizatorio por accidente de trabajo ley 24557' },
  { q: 'derecho del trabajador a percibir horas extras no registradas en negro' },
  { q: 'actualización monetaria de condenas dinerarias por inflación en Argentina' },
  { q: 'accidente de tránsito daño moral', filters: { fuero: 'CIV' } },
  { q: 'despido injustificado indemnización agravada', filters: { fuero: 'CNT' } },
  { q: 'reajuste haber jubilatorio movilidad', filters: { fuero: 'CSS' } },
];

// Carga el set de IDs indexados en large (para comparación justa)
async function getLargeIndexedIds() {
  const db = mongoose.connection.db;
  const docs = await db.collection('sentencias-capturadas')
    .find({ embeddingLargeStatus: 'done' }, { projection: { _id: 1 } })
    .toArray();
  return new Set(docs.map(d => d._id.toString()));
}

async function runNamespace(searchByQuery, namespace, largeIds = null) {
  const resultados = [];
  let ok = 0, sinResultados = 0, errores = 0;
  let totalScore = 0, scoreCount = 0;

  for (const { q, filters } of QUERIES) {
    try {
      const t0 = Date.now();
      const res = await searchByQuery(q, { topK: 5, minScore: 0.40, filters: filters || {}, namespace });
      const ms = Date.now() - t0;

      // Si es comparación justa: filtrar resultados del small al corpus del large
      let results = res.results;
      if (largeIds && namespace === NAMESPACE_SMALL) {
        results = results.filter(r => largeIds.has(r.sentencia._id.toString()));
      }

      const row = {
        query: q,
        filters: filters || null,
        total: results.length,
        latencyMs: ms,
        resultados: results.slice(0, 3).map(r => ({
          score: r.score,
          fuero: r.sentencia.fuero,
          year: r.sentencia.year,
          caratula: (r.sentencia.caratula || '').slice(0, 70),
          sentenciaId: r.sentencia._id.toString(),
        })),
      };
      resultados.push(row);

      if (results.length > 0) {
        ok++;
        totalScore += results[0].score;
        scoreCount++;
      } else {
        sinResultados++;
      }

    } catch (e) {
      errores++;
      resultados.push({ query: q, error: e.message });
    }
  }

  return { resultados, ok, sinResultados, errores, avgTopScore: scoreCount > 0 ? (totalScore / scoreCount).toFixed(4) : 'N/A' };
}

function printResults(resultados, namespace, label = '') {
  console.log(`\n── Resultados [${namespace}${label}] ────────────────────────`);
  for (const row of resultados) {
    if (row.error) { console.log(`  ✗ ERROR "${row.query}": ${row.error}`); continue; }
    const label2 = row.total > 0 ? '✓' : '✗';
    const filterStr = row.filters ? ' ' + JSON.stringify(row.filters) : '';
    console.log(`${label2} [${row.total}] [${row.latencyMs}ms] "${row.query}"${filterStr}`);
    row.resultados.slice(0, 2).forEach(r => {
      console.log(`    score:${r.score} ${r.fuero} ${r.year} | ${r.caratula}`);
    });
  }
}

function printComparison(smallResults, largeResults, fairMode) {
  const modeLabel = fairMode ? ' (corpus igualado a 5k docs)' : '';
  console.log(`\n── Comparación por query${modeLabel} ─────────────────────────────`);
  console.log(`${'Query'.padEnd(55)} ${'Small'.padStart(8)} ${'Large'.padStart(8)} ${'Δ'.padStart(8)}`);
  console.log('─'.repeat(84));

  let smallWins = 0, largeWins = 0, ties = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i].q.slice(0, 53);
    const s = smallResults.resultados[i];
    const l = largeResults.resultados[i];
    const sScore = s?.resultados?.[0]?.score ?? null;
    const lScore = l?.resultados?.[0]?.score ?? null;

    let winner = '';
    if (sScore !== null && lScore !== null) {
      const delta = lScore - sScore;
      const deltaStr = (delta > 0 ? '+' : '') + delta.toFixed(4);
      if (delta > 0.005) { winner = ' ◀ LARGE'; largeWins++; }
      else if (delta < -0.005) { winner = ' ◀ SMALL'; smallWins++; }
      else { winner = ' ≈'; ties++; }
      console.log(`${q.padEnd(55)} ${(sScore).toString().padStart(8)} ${(lScore).toString().padStart(8)} ${deltaStr.padStart(8)}${winner}`);
    } else {
      console.log(`${q.padEnd(55)} ${(sScore ?? '—').toString().padStart(8)} ${(lScore ?? '—').toString().padStart(8)} ${'N/A'.padStart(8)}`);
    }

    // Mostrar si encontraron los mismos documentos
    const sIds = new Set((s?.resultados || []).map(r => r.sentenciaId));
    const lIds = new Set((l?.resultados || []).map(r => r.sentenciaId));
    const overlap = [...sIds].filter(id => lIds.has(id)).length;
    const total = Math.max(sIds.size, lIds.size);
    if (total > 0) console.log(`${''.padEnd(55)} ${'overlap:'.padStart(8)} ${overlap}/${total}`);
  }

  console.log('─'.repeat(84));
  console.log(`Small gana: ${smallWins} | Large gana: ${largeWins} | Empate: ${ties}`);
}

async function run() {
  const URLDB = process.env.URLDB;
  if (!URLDB) { console.error('URLDB no definida'); process.exit(1); }

  console.log('Conectando a MongoDB...');
  await mongoose.connect(URLDB);
  console.log('Conectado.\n');

  const { searchByQuery } = require('./src/services/sentenciasSearchService');
  const fs = require('fs');

  if (COMPARE) {
    let largeIds = null;
    if (FAIR) {
      process.stdout.write('Cargando IDs indexados en large... ');
      largeIds = await getLargeIndexedIds();
      console.log(`${largeIds.size} documentos.`);
    }

    const mode = FAIR ? ' (FAIR — mismo corpus)' : '';
    console.log(`Modo comparación${mode}: corriendo ambos namespaces...\n`);

    console.log(`[1/2] Namespace: ${NAMESPACE_SMALL}${FAIR ? ' (filtrado a corpus large)' : ''}`);
    const smallRes = await runNamespace(searchByQuery, NAMESPACE_SMALL, largeIds);
    printResults(smallRes.resultados, NAMESPACE_SMALL, FAIR ? ' filtrado' : '');

    console.log(`\n[2/2] Namespace: ${NAMESPACE_LARGE}`);
    const largeRes = await runNamespace(searchByQuery, NAMESPACE_LARGE);
    printResults(largeRes.resultados, NAMESPACE_LARGE);

    printComparison(smallRes, largeRes, FAIR);

    console.log('\n── Resumen ──────────────────────────────────────────');
    console.log(`${'Métrica'.padEnd(25)} ${'Small'.padStart(10)} ${'Large'.padStart(10)}`);
    console.log('─'.repeat(47));
    console.log(`${'Con resultados'.padEnd(25)} ${smallRes.ok.toString().padStart(10)} ${largeRes.ok.toString().padStart(10)}`);
    console.log(`${'Sin resultados'.padEnd(25)} ${smallRes.sinResultados.toString().padStart(10)} ${largeRes.sinResultados.toString().padStart(10)}`);
    console.log(`${'Avg top-1 score'.padEnd(25)} ${smallRes.avgTopScore.toString().padStart(10)} ${largeRes.avgTopScore.toString().padStart(10)}`);
    console.log('─────────────────────────────────────────────────────');

    const outFile = `eval-results/eval-compare${FAIR ? '-fair' : ''}-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
    fs.mkdirSync('eval-results', { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ small: smallRes.resultados, large: largeRes.resultados }, null, 2));
    console.log(`\nResultados guardados en: ${outFile}`);

  } else {
    const namespace = USE_LARGE ? NAMESPACE_LARGE : NAMESPACE_SMALL;
    console.log(`Namespace: ${namespace}\n`);
    const res = await runNamespace(searchByQuery, namespace);
    printResults(res.resultados, namespace);

    console.log(`\n── Resumen ──────────────────────────────`);
    console.log(`Total queries:   ${QUERIES.length}`);
    console.log(`Con resultados:  ${res.ok}`);
    console.log(`Sin resultados:  ${res.sinResultados}`);
    console.log(`Avg top-1 score: ${res.avgTopScore}`);
    console.log(`────────────────────────────────────────`);

    const outFile = `eval-results/eval-${namespace}-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
    fs.mkdirSync('eval-results', { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(res.resultados, null, 2));
    console.log(`\nResultados guardados en: ${outFile}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
