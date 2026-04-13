/**
 * Script de evaluación de búsqueda semántica de sentencias.
 * Lee el .env de producción, conecta a MongoDB y llama directamente al servicio.
 * Uso: node eval-search.js
 */
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');

const QUERIES = [
  // Búsquedas cortas (se expanden automáticamente)
  { q: 'accidente de tránsito' },
  { q: 'daño moral' },
  { q: 'despido sin causa' },
  { q: 'caducidad de instancia' },

  // Búsquedas medias
  { q: 'indemnización por accidente laboral con incapacidad permanente' },
  { q: 'reajuste de haberes previsionales jubilación' },
  { q: 'medida cautelar embargo preventivo' },
  { q: 'usucapión prescripción adquisitiva inmueble' },

  // Búsquedas largas / semánticas profundas
  { q: 'responsabilidad civil del conductor por lesiones a peatón en zona urbana' },
  { q: 'nulidad de despido por embarazo y reinstalación en el puesto de trabajo' },
  { q: 'determinación del quantum indemnizatorio en daño psicológico permanente' },
  { q: 'prescripción de la acción por daños derivados de accidente de tránsito' },
  { q: 'solidaridad del empleador principal por deudas laborales del subcontratista' },
  { q: 'inconstitucionalidad del tope indemnizatorio por accidente de trabajo ley 24557' },
  { q: 'derecho del trabajador a percibir horas extras no registradas en negro' },
  { q: 'actualización monetaria de condenas dinerarias por inflación en Argentina' },

  // Con filtros por fuero
  { q: 'accidente de tránsito daño moral', filters: { fuero: 'CIV' } },
  { q: 'despido injustificado indemnización agravada', filters: { fuero: 'CNT' } },
  { q: 'reajuste haber jubilatorio movilidad', filters: { fuero: 'CSS' } },
];

async function run() {
  const URLDB = process.env.URLDB;
  if (!URLDB) { console.error('URLDB no definida'); process.exit(1); }

  console.log('Conectando a MongoDB...');
  await mongoose.connect(URLDB);
  console.log('Conectado.\n');

  // Importar DESPUÉS de conectar para que el modelo use la conexión activa
  const { searchByQuery } = require('./src/services/sentenciasSearchService');

  const resultados = [];
  let ok = 0, sinResultados = 0, errores = 0;

  for (const { q, filters } of QUERIES) {
    try {
      const t0 = Date.now();
      const res = await searchByQuery(q, { topK: 3, minScore: 0.55, filters: filters || {} });
      const ms = Date.now() - t0;

      const row = {
        query: q,
        filters: filters || null,
        total: res.total,
        latencyMs: ms,
        resultados: res.results.map(r => ({
          score: r.score,
          fuero: r.sentencia.fuero,
          year: r.sentencia.year,
          caratula: (r.sentencia.caratula || '').slice(0, 70),
          sentenciaTipo: r.sentencia.sentenciaTipo,
          chunksCoincidentes: r.matchedChunks.length,
        })),
      };
      resultados.push(row);

      if (res.total > 0) ok++;
      else sinResultados++;

      const label = res.total > 0 ? '✓' : '✗';
      console.log(`${label} [${res.total} result${res.total !== 1 ? 's' : ''}] [${ms}ms] "${q}"${filters ? ' ' + JSON.stringify(filters) : ''}`);
      if (res.total > 0) {
        res.results.slice(0, 2).forEach(r => {
          console.log(`    score:${r.score} ${r.sentencia.fuero} ${r.sentencia.year} | ${(r.sentencia.caratula || '').slice(0, 65)}`);
        });
      }
    } catch (e) {
      errores++;
      console.error(`  ERROR "${q}": ${e.message}`);
      resultados.push({ query: q, error: e.message });
    }
  }

  console.log(`\n── Resumen ──────────────────────────────`);
  console.log(`Total queries: ${QUERIES.length}`);
  console.log(`Con resultados: ${ok}`);
  console.log(`Sin resultados: ${sinResultados}`);
  console.log(`Errores:        ${errores}`);
  console.log(`────────────────────────────────────────`);

  // Guardar JSON con resultados completos
  const fs = require('fs');
  const outFile = `eval-results/eval-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  fs.mkdirSync('eval-results', { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(resultados, null, 2));
  console.log(`\nResultados completos guardados en: ${outFile}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
