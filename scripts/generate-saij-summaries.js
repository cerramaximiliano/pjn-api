/**
 * Genera resúmenes IA (aiSummary) para sentencias SAIJ sin resumen.
 *
 * Alimenta la sección pública de jurisprudencia (lawanalytics.app/jurisprudencia):
 * el endpoint público del hub solo muestra docs SAIJ con aiSummary.content.
 *
 * Criterio de selección:
 *   - source.origin='saij' AND sin aiSummary.content AND publicationStatus != 'skipped'
 *   - con texto de fallo utilizable (processingResult.pdfText — NUNCA se usan
 *     los sumarios oficiales de SAIJ que vienen concatenados en .text)
 *   - más recientes primero (movimientoFecha desc)
 *
 * Reusa el prompt/modelo configurables de configuracion-sentencias-collector
 * (mismo mecanismo que POST /api/sentencias-capturadas/:id/summary).
 *
 * Uso (desde /var/www/pjn-api o el repo local con .env):
 *   node scripts/generate-saij-summaries.js --limit 20            # genera 20
 *   node scripts/generate-saij-summaries.js --limit 20 --dry-run  # solo lista candidatas
 *   node scripts/generate-saij-summaries.js --fuero CNT --limit 10
 *   node scripts/generate-saij-summaries.js --since 2026-01-01 --limit 500
 *   node scripts/generate-saij-summaries.js --limit 10000 --concurrency 5  # batch masivo
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const OpenAI = require('openai').default;

const URLDB = process.env.URLDB;
if (!URLDB) { console.error('URLDB no definida'); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY no definida'); process.exit(1); }

// --- args ---
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}
const LIMIT = parseInt(argValue('limit') || '10', 10);
const DRY_RUN = args.includes('--dry-run');
const FUERO = argValue('fuero');
const SINCE = argValue('since') ? new Date(argValue('since')) : null;
const CONCURRENCY = Math.min(Math.max(parseInt(argValue('concurrency') || '1', 10), 1), 10);

// Mismo prompt default que sentenciasCaptuadasController (fallback si no hay
// override en configuracion-sentencias-collector).
const SUMMARY_SYSTEM_PROMPT = `Eres un asistente jurídico especializado en derecho argentino. Tu tarea es analizar fallos judiciales y producir un resumen estructurado orientado a la divulgación jurídica.

El resumen debe tener EXACTAMENTE las siguientes tres secciones en formato Markdown:

## Resumen del fallo
Descripción clara y concisa de qué decidió el tribunal, las normas aplicadas y los fundamentos centrales del fallo. Máximo 3 párrafos.

## Pormenores
Contexto del caso: hechos relevantes, historial procesal, argumentos de las partes y aspectos destacados del razonamiento judicial. Máximo 4 párrafos.

## Resultado
Disposición final: quién ganó, qué se ordenó, montos o condenas si los hay, costas y cualquier otro punto resolutivo relevante. Máximo 2 párrafos.

Usa lenguaje claro y preciso, apto para abogados y público interesado en derecho. No inventes información que no esté en el texto. Si el texto está incompleto o ilegible en alguna parte, indícalo.`;

const MAX_TEXT_CHARS = 18000;
const MIN_TEXT_CHARS = 500;
const SUMARIO_SEPARATOR = '\n\n--- SUMARIO ---\n\n';

const FUERO_LABELS = {
  CIV: 'Civil', CSS: 'Seguridad Social', CNT: 'Trabajo', COM: 'Comercial',
  CCC: 'Criminal y Correccional', CSJ: 'Corte Suprema', CNE: 'Electoral',
  CAF: 'Contencioso Administrativo Federal', CCF: 'Civil y Comercial Federal',
  CPE: 'Penal Económico', CFP: 'Criminal y Correccional Federal',
};

async function main() {
  console.log('Conectando a MongoDB Atlas...');
  await mongoose.connect(URLDB);
  const db = mongoose.connection.db;
  const col = db.collection('sentencias-capturadas');

  // Prompt/modelo desde config (mismo doc que usa el endpoint del admin)
  const cfg = await db.collection('configuracion-sentencias-collector')
    .findOne({ name: 'sentencias-collector' }, { projection: { aiSummary: 1 } });
  const systemPrompt = cfg?.aiSummary?.systemPrompt || SUMMARY_SYSTEM_PROMPT;
  const aiModel = cfg?.aiSummary?.model || 'gpt-4o-mini';
  console.log(`Modelo: ${aiModel} | Prompt: ${cfg?.aiSummary?.systemPrompt ? 'config' : 'default'}`);

  const match = {
    'source.origin': 'saij',
    'aiSummary.content': { $exists: false },
    publicationStatus: { $ne: 'skipped' },
    'processingResult.charCount': { $gte: MIN_TEXT_CHARS },
  };
  if (FUERO) match.fuero = FUERO.toUpperCase();
  if (SINCE && !isNaN(SINCE)) match.movimientoFecha = { $gte: SINCE };

  const pendientes = await col.countDocuments(match);
  console.log(`Candidatas sin resumen: ${pendientes} | procesando hasta ${LIMIT}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Solo metadata liviana acá — los textos (pdfText/text pueden pesar cientos
  // de KB c/u) se buscan doc por doc en processDoc para no reventar memoria/red.
  const docs = await col.find(match, {
    projection: { caratula: 1, fuero: 1, sentenciaTipo: 1, movimientoFecha: 1 },
  }).sort({ movimientoFecha: -1, _id: -1 }).limit(LIMIT).toArray();

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let ok = 0, skipped = 0, failed = 0, processed = 0;

  async function processDoc(doc) {
    const label = `${doc._id} [${doc.fuero}] ${String(doc.caratula || '').slice(0, 60)}`;

    const conTexto = await col.findOne(
      { _id: doc._id },
      { projection: { 'processingResult.pdfText': 1, 'processingResult.text': 1 } }
    );

    // Texto del fallo: SOLO pdfText o el tramo previo al primer sumario SAIJ.
    let texto = conTexto?.processingResult?.pdfText || '';
    if (!texto && conTexto?.processingResult?.text) {
      texto = conTexto.processingResult.text.split(SUMARIO_SEPARATOR)[0] || '';
    }
    if (texto.length < MIN_TEXT_CHARS) {
      console.log(`  SKIP (texto de fallo insuficiente: ${texto.length} chars) ${label}`);
      skipped++;
      return;
    }

    if (DRY_RUN) {
      console.log(`  DRY ${label} (${texto.length} chars)`);
      return;
    }

    const truncated = texto.slice(0, MAX_TEXT_CHARS);
    const userMessage = [
      `**Expediente:** ${doc.caratula || 'Sin carátula'}`,
      `**Fuero:** ${FUERO_LABELS[doc.fuero] || doc.fuero || 'N/D'}`,
      doc.movimientoFecha ? `**Fecha:** ${new Date(doc.movimientoFecha).toLocaleDateString('es-AR')}` : null,
      '',
      '**Texto del fallo:**',
      truncated,
    ].filter(Boolean).join('\n');

    try {
      const completion = await openai.chat.completions.create({
        model: aiModel,
        max_tokens: 1500,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });
      const content = completion.choices[0]?.message?.content || '';
      if (content.length < 100) throw new Error(`respuesta demasiado corta (${content.length} chars)`);

      await col.updateOne(
        { _id: doc._id },
        { $set: { aiSummary: { content, status: 'draft', generatedAt: new Date(), model: completion.model } } }
      );
      ok++;
      console.log(`  OK  ${label} (${content.length} chars)`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${label}: ${err.message}`);
    }
  }

  // Pool simple de CONCURRENCY workers sobre la lista de docs.
  let cursor = 0;
  async function worker() {
    while (cursor < docs.length) {
      const doc = docs[cursor++];
      await processDoc(doc);
      processed++;
      if (processed % 100 === 0) console.log(`--- progreso: ${processed}/${docs.length} (ok=${ok} skip=${skipped} fail=${failed}) ---`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\nResultado: ${ok} generados, ${skipped} skipped, ${failed} fallidos. Restan ~${pendientes - ok - skipped} sin resumen.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
