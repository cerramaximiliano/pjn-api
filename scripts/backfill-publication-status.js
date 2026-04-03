/**
 * Backfill publicationStatus='pending' en sentencias-capturadas
 *
 * Criterio:
 *   - category='novelty' AND embeddingStatus='completed' AND publicationStatus no existe
 *   → setear publicationStatus='pending'
 *
 * Ejecutar: node scripts/backfill-publication-status.js
 * (desde /var/www/pjn-api con el .env cargado)
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const URLDB = process.env.URLDB;
if (!URLDB) { console.error('URLDB no definida'); process.exit(1); }

async function main() {
  console.log('Conectando a MongoDB Atlas...');
  await mongoose.connect(URLDB);
  console.log('Conectado');

  const col = mongoose.connection.db.collection('sentencias-capturadas');

  // 1. Contar cuántas hay para informar
  const total = await col.countDocuments({
    category: 'novelty',
    embeddingStatus: 'completed',
    publicationStatus: { $exists: false },
  });
  console.log(`Sentencias novelty embedded sin publicationStatus: ${total}`);

  if (total === 0) {
    console.log('Nada que actualizar.');
    await mongoose.disconnect();
    return;
  }

  // 2. Actualizar
  const result = await col.updateMany(
    {
      category: 'novelty',
      embeddingStatus: 'completed',
      publicationStatus: { $exists: false },
    },
    { $set: { publicationStatus: 'pending' } }
  );

  console.log(`✅ Actualizadas: ${result.modifiedCount} sentencias → publicationStatus='pending'`);

  // 3. Breakdown por fuero
  const byFuero = await col.aggregate([
    { $match: { category: 'novelty', embeddingStatus: 'completed', publicationStatus: 'pending' } },
    { $group: { _id: '$fuero', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  console.log('\nDistribución por fuero:');
  byFuero.forEach(r => console.log(`  ${r._id}: ${r.count}`));

  // 4. Breakdown por tipo de sentencia
  const byTipo = await col.aggregate([
    { $match: { category: 'novelty', embeddingStatus: 'completed', publicationStatus: 'pending' } },
    { $group: { _id: '$sentenciaTipo', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  console.log('\nDistribución por tipo:');
  byTipo.forEach(r => console.log(`  ${r._id}: ${r.count}`));

  await mongoose.disconnect();
  console.log('\nListo.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
