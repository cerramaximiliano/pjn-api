/**
 * monitoringService — métricas de infraestructura para la UI ADMIN.
 *
 * Arquitectura dual de pjn-api:
 *   - Instancia LOCAL (worker_01, NODE_ENV=local): ve Qdrant (localhost) + Mongo local
 *     (conexión primaria) + Atlas (URLDB) + host. RECOLECTA un snapshot completo y lo
 *     escribe a Atlas (colección `infra-monitoring-snapshots`) cada COLLECT_INTERVAL.
 *   - Instancia CLOUD (hub, NODE_ENV=production): conexión primaria = Atlas. SIRVE los
 *     snapshots (último + histórico) a la UI ADMIN leyendo de Atlas.
 *
 * Así el admin (que pega a la instancia pública) obtiene una vista integral sin que la
 * instancia cloud tenga que alcanzar Qdrant/Mongo-local (que no son públicos).
 */
const os = require('os');
const { promises: fsp } = require('fs');
const { exec } = require('child_process');
const mongoose = require('mongoose');

const SNAP_COLLECTION   = 'infra-monitoring-snapshots';
const isLocalInstance   = () => (process.env.NODE_ENV === 'local');

// Config leída en TIEMPO DE LLAMADA (este módulo se carga vía routes ANTES de
// dotenv.config() en server.js, por eso no se puede capturar en constantes a module-load).
function qcfg() {
  return {
    url:     process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    key:     process.env.QDRANT_API_KEY || '',
    storage: process.env.QDRANT_STORAGE_PATH || '/home/worker_01/qdrant/storage',
  };
}
const COLLECT_INTERVAL  = () => parseInt(process.env.MONITORING_INTERVAL_MS || '600000', 10); // 10 min
const SNAPSHOT_TTL_DAYS = () => parseInt(process.env.MONITORING_TTL_DAYS || '90', 10);

// ── Conexión Atlas (para leer/escribir snapshots) ──────────────────────────────
// En cloud, la conexión primaria YA es Atlas. En local, abrimos una secundaria a URLDB
// y esperamos a que esté lista (asPromise) antes de usar conn.db.
let _atlasConn = null;
async function getAtlasConn() {
  if (!isLocalInstance()) return mongoose.connection;            // cloud: primaria = Atlas
  if (_atlasConn) return _atlasConn;
  if (!process.env.URLDB) throw new Error('URLDB (Atlas) no configurada en instancia local');
  _atlasConn = await mongoose.createConnection(process.env.URLDB).asPromise();
  return _atlasConn;
}

function execP(cmd, timeoutMs = 15000) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

// ── Recolectores por dominio (cada uno fail-safe) ──────────────────────────────

async function collectQdrant() {
  try {
    const { url, key, storage } = qcfg();
    const h = { 'api-key': key };
    const listR = await fetch(`${url}/collections`, { headers: h });
    if (!listR.ok) throw new Error(`list ${listR.status}`);
    const names = (await listR.json()).result.collections.map(c => c.name);
    const collections = [];
    let totalVectors = 0;
    for (const name of names) {
      const r = await fetch(`${url}/collections/${name}`, { headers: h });
      if (!r.ok) continue;
      const d = (await r.json()).result;
      const vectorsCfg = d.config?.params?.vectors || {};
      const quant = d.config?.quantization_config ? Object.keys(d.config.quantization_config)[0] : null;
      let diskBytes = null;
      const du = await execP(`du -sb ${storage}/collections/${name} 2>/dev/null`);
      if (du) diskBytes = parseInt(du.split(/\s+/)[0], 10) || null;
      totalVectors += d.points_count || 0;
      collections.push({
        name,
        points: d.points_count || 0,
        indexed: d.indexed_vectors_count || 0,
        segments: d.segments_count || 0,
        status: d.status,
        dim: vectorsCfg.size || null,
        distance: vectorsCfg.distance || null,
        onDisk: !!vectorsCfg.on_disk,
        quantization: quant,
        diskBytes,
      });
    }
    return { healthy: true, totalVectors, collectionsCount: collections.length, collections };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

async function collectMongo(conn, label) {
  try {
    const db = conn.db;
    const stats = await db.stats();
    const cols = await db.listCollections().toArray();
    const perCol = [];
    for (const c of cols) {
      try {
        const cs = await db.command({ collStats: c.name });
        perCol.push({ name: c.name, count: cs.count || 0, sizeBytes: cs.size || 0, storageBytes: cs.storageSize || 0, indexBytes: cs.totalIndexSize || 0 });
      } catch { /* skip view/inaccesible */ }
    }
    perCol.sort((a, b) => b.storageBytes - a.storageBytes);
    return {
      label,
      dbName: db.databaseName,
      dataSize: stats.dataSize,
      storageSize: stats.storageSize,
      indexSize: stats.indexSize,
      totalSize: (stats.dataSize || 0) + (stats.indexSize || 0),
      objects: stats.objects,
      collectionsCount: cols.length,
      topCollections: perCol.slice(0, 25),
    };
  } catch (e) {
    return { label, error: e.message };
  }
}

async function collectHost() {
  const host = {
    hostname: os.hostname(),
    loadavg: os.loadavg().map(n => Math.round(n * 100) / 100),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptimeSec: Math.round(os.uptime()),
  };
  try {
    const storage = qcfg().storage;
    const fsst = await fsp.statfs(storage);
    host.disk = {
      path: storage,
      totalBytes: fsst.blocks * fsst.bsize,
      freeBytes: fsst.bavail * fsst.bsize,
      usedBytes: (fsst.blocks - fsst.bavail) * fsst.bsize,
      usedPct: Math.round(((fsst.blocks - fsst.bavail) / fsst.blocks) * 1000) / 10,
    };
  } catch (e) { host.diskError = e.message; }
  return host;
}

// ── Snapshot completo (corre en la instancia LOCAL) ────────────────────────────
async function collectSnapshot() {
  const atlas = await getAtlasConn();
  const [qdrant, mongoLocal, mongoCloud, host] = await Promise.all([
    collectQdrant(),
    collectMongo(mongoose.connection, 'local'),   // primaria = Mongo local en worker_01
    collectMongo(atlas, 'cloud'),                  // Atlas
    collectHost(),
  ]);
  return { source: os.hostname(), createdAt: new Date(), qdrant, mongoLocal, mongoCloud, host };
}

async function writeSnapshot(snap) {
  const col = (await getAtlasConn()).collection(SNAP_COLLECTION);
  try { await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: SNAPSHOT_TTL_DAYS() * 86400 }); } catch { /* ya existe */ }
  await col.insertOne(snap);
}

async function getLatestSnapshot() {
  const col = (await getAtlasConn()).collection(SNAP_COLLECTION);
  return col.find({}).sort({ createdAt: -1 }).limit(1).next();
}

async function getHistory({ hours = 168, limit = 500 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const col = (await getAtlasConn()).collection(SNAP_COLLECTION);
  // Proyección liviana para tendencia (evita traer topCollections completos)
  return col.find({ createdAt: { $gte: since } })
    .project({ createdAt: 1, 'qdrant.totalVectors': 1, 'qdrant.collections.name': 1, 'qdrant.collections.points': 1,
               'host.disk.usedBytes': 1, 'host.disk.freeBytes': 1, 'mongoCloud.totalSize': 1, 'mongoLocal.totalSize': 1 })
    .sort({ createdAt: 1 }).limit(limit).toArray();
}

// ── Collector periódico (solo instancia LOCAL) ─────────────────────────────────
let _timer = null;
function startCollector(logger) {
  if (!isLocalInstance()) { logger?.info?.('[monitoring] no es instancia local → no se recolecta (solo sirve)'); return; }
  if (_timer) return;
  const run = async () => {
    try { const s = await collectSnapshot(); await writeSnapshot(s);
      logger?.info?.(`[monitoring] snapshot escrito | vectores=${s.qdrant?.totalVectors} | disk_used%=${s.host?.disk?.usedPct}`);
    } catch (e) { logger?.error?.(`[monitoring] snapshot falló: ${e.message}`); }
  };
  run(); // inmediato al arrancar
  _timer = setInterval(run, COLLECT_INTERVAL());
  logger?.info?.(`[monitoring] collector activo cada ${COLLECT_INTERVAL()}ms`);
}

module.exports = {
  collectSnapshot, writeSnapshot, getLatestSnapshot, getHistory, startCollector,
  isLocalInstance, SNAP_COLLECTION,
};
