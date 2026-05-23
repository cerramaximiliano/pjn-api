/**
 * Wrapper de control PM2 para el sistema pjn-liquidacion-worker.
 *
 * Usa `pm2 jlist` (JSON output) + `pm2 {start,stop,restart} <name>` vía
 * execFile (sin shell, sin riesgo de inyección). Whitelist HARDCODED
 * de procesos — cualquier nombre fuera de la lista se rechaza.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PM2_BIN = process.env.PM2_BIN || '/home/worker_01/.npm-global/bin/pm2';
const TIMEOUT_LIST_MS = 10_000;
const TIMEOUT_ACTION_MS = 30_000;

// Whitelist absoluta — el endpoint REST nunca acepta otros nombres.
const ALLOWED_PROCESSES = ['pjn-liq-manager', 'pjn-liq-url-extractor', 'pjn-liq-pdf-processor'];

// Mapeo de claves cortas (camelCase / kebab) → nombre PM2 real.
// La UI manda 'manager' | 'url-extractor' | 'pdf-processor'.
const KEY_TO_NAME = {
  manager: 'pjn-liq-manager',
  'url-extractor': 'pjn-liq-url-extractor',
  urlExtractor: 'pjn-liq-url-extractor',
  'pdf-processor': 'pjn-liq-pdf-processor',
  pdfProcessor: 'pjn-liq-pdf-processor'
};

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

/**
 * Lista los 3 procesos con estado, uptime, restarts, cpu, memoria.
 * @returns {Promise<Array>}
 */
async function listFiltered() {
  const { stdout } = await execFileAsync(PM2_BIN, ['jlist'], { timeout: TIMEOUT_LIST_MS });
  let all;
  try {
    all = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`pm2 jlist no devolvió JSON: ${err.message}`);
  }
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

/**
 * Resuelve claves de la UI a nombres reales y los valida contra la whitelist.
 */
function resolveTargets(workers) {
  if (!workers || (Array.isArray(workers) && workers.length === 0)) {
    return ALLOWED_PROCESSES.slice(); // todos
  }
  if (!Array.isArray(workers)) throw new Error('workers debe ser array');
  const resolved = workers.map((k) => KEY_TO_NAME[k] || k).filter((n, i, arr) => arr.indexOf(n) === i);
  const invalid = resolved.filter((n) => !ALLOWED_PROCESSES.includes(n));
  if (invalid.length > 0) throw new Error(`workers inválidos: ${invalid.join(', ')}`);
  return resolved;
}

/**
 * Ejecuta start | stop | restart sobre la lista de procesos.
 * @returns {Promise<Array<{name, ok, error?, action}>>}
 */
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
  // pm2 save para persistir el nuevo estado en el dump (sobrevive reboot)
  try {
    await execFileAsync(PM2_BIN, ['save'], { timeout: TIMEOUT_ACTION_MS });
  } catch (_) {
    // no-fatal — si pm2 save falla, los procesos quedan en el estado deseado igual
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
