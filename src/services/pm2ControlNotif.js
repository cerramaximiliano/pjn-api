/**
 * Wrapper de control PM2 para el sistema pjn-notificaciones-laborales-worker.
 *
 * Espejo de pm2Control.js (liquidacion) pero con whitelist de los 3 procesos
 * del worker de notificaciones laborales. Igual disciplina: execFile sin shell,
 * whitelist hardcoded, mapeo de claves cortas a nombres reales.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PM2_BIN = process.env.PM2_BIN || '/home/worker_01/.npm-global/bin/pm2';
const TIMEOUT_LIST_MS = 10_000;
const TIMEOUT_ACTION_MS = 30_000;

const ALLOWED_PROCESSES = ['pjn-notif-manager', 'pjn-notif-url-extractor', 'pjn-notif-pdf-processor'];

const KEY_TO_NAME = {
  manager: 'pjn-notif-manager',
  'url-extractor': 'pjn-notif-url-extractor',
  urlExtractor: 'pjn-notif-url-extractor',
  'pdf-processor': 'pjn-notif-pdf-processor',
  pdfProcessor: 'pjn-notif-pdf-processor'
};

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

async function listFiltered() {
  const { stdout } = await execFileAsync(PM2_BIN, ['jlist'], { timeout: TIMEOUT_LIST_MS });
  let all;
  try { all = JSON.parse(stdout); }
  catch (err) { throw new Error(`pm2 jlist no devolvió JSON: ${err.message}`); }
  if (!Array.isArray(all)) throw new Error('pm2 jlist devolvió formato inesperado');

  const byName = new Map(all.map((p) => [p.name, p]));
  return ALLOWED_PROCESSES.map((name) => {
    const p = byName.get(name);
    if (!p) {
      return { name, status: 'not_found', pid: null, uptime: null, restarts: 0, cpu: 0, memory: 0 };
    }
    return {
      name,
      pmId: p.pm_id,
      status: p.pm2_env?.status || 'unknown',
      pid: p.pid || null,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
      restarts: p.pm2_env?.restart_time || 0,
      cpu: p.monit?.cpu ?? 0,
      memory: p.monit?.memory ?? 0,
      execMode: p.pm2_env?.exec_mode || 'fork'
    };
  });
}

function resolveTargets(workers) {
  if (!workers || (Array.isArray(workers) && workers.length === 0)) {
    return ALLOWED_PROCESSES.slice();
  }
  if (!Array.isArray(workers)) throw new Error('workers debe ser array');
  const resolved = workers.map((k) => KEY_TO_NAME[k] || k).filter((n, i, arr) => arr.indexOf(n) === i);
  const invalid = resolved.filter((n) => !ALLOWED_PROCESSES.includes(n));
  if (invalid.length > 0) throw new Error(`workers inválidos: ${invalid.join(', ')}`);
  return resolved;
}

async function executeAction(action, workers) {
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`action inválida: ${action}`);
  const targets = resolveTargets(workers);
  const results = [];
  for (const name of targets) {
    try {
      await execFileAsync(PM2_BIN, [action, name], { timeout: TIMEOUT_ACTION_MS });
      results.push({ name, action, ok: true });
    } catch (err) {
      const msg = (err.stderr || err.message || '').toString().split('\n')[0].slice(0, 300);
      results.push({ name, action, ok: false, error: msg });
    }
  }
  try {
    await execFileAsync(PM2_BIN, ['save'], { timeout: TIMEOUT_ACTION_MS });
  } catch (_) {
    // no-fatal
  }
  return results;
}

module.exports = {
  listFiltered,
  executeAction,
  resolveTargets,
  ALLOWED_PROCESSES,
  ALLOWED_ACTIONS: Array.from(ALLOWED_ACTIONS),
  KEY_TO_NAME
};
