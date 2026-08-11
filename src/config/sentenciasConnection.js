'use strict';
/**
 * sentenciasConnection — conexión Mongo ÚNICA y compartida para las colecciones
 * del corpus de sentencias (`sentencias-capturadas` y `saij-sentencias`, más la
 * config `configuracion-semantic-worker` que vive en la misma DB).
 *
 * Contexto (arquitectura dual de pjn-api):
 *   - hub (NODE_ENV=production): conexión default = URLDB (Atlas).
 *   - worker_01 (NODE_ENV=local): conexión default = URLDB_LOCAL (Mongo local),
 *     que NO tiene el corpus real de sentencias.
 *
 * La URI del corpus se gobierna con `SENTENCIAS_MONGO_URI || URLDB`: hoy Atlas,
 * post-migración el replica set propio — sin tocar código, solo la env var.
 *
 * Anti-duplicación de pools: si la URI resuelta coincide con la de la conexión
 * default de mongoose (espejo del cálculo de src/server.js) y la default está
 * conectada/conectando, se REUTILIZA esa conexión en vez de abrir un pool nuevo
 * (antes sentenciasSearchService abría un segundo pool a Atlas en el hub).
 *
 * Lazy a propósito: server.js requiere rutas/modelos ANTES de dotenv.config()
 * (los secrets llegan async desde AWS), así que la URI no existe a module-load.
 * Nada de este módulo debe resolver la URI hasta la primera llamada real.
 */
const mongoose = require('mongoose');
const { logger } = require('./pino');

let _conn = null; // Connection cacheada (puede ser la default reutilizada)

function resolvedUri() {
	return process.env.SENTENCIAS_MONGO_URI || process.env.URLDB;
}

// Espejo de src/server.js: URI que usa la conexión default según ambiente.
function defaultUri() {
	return process.env.NODE_ENV === 'local' ? process.env.URLDB_LOCAL : process.env.URLDB;
}

/**
 * Devuelve la Connection de sentencias (sincrónico, cacheado).
 * Puede devolverla antes de que termine el handshake: mongoose bufferiza las
 * operaciones de modelos hasta que conecta. Para acceso raw al driver nativo
 * (conn.db) usar getSentenciasDb(), que espera a que esté lista.
 */
function getSentenciasConnection() {
	// Conexión dedicada caída (falló el connect inicial o se desconectó sin
	// auto-reconectar): descartarla y recrear en la próxima línea.
	if (_conn && _conn !== mongoose.connection && _conn.readyState === 0) {
		const dead = _conn;
		_conn = null;
		dead.destroy().catch(() => {});
	}
	if (_conn) return _conn;

	const uri = resolvedUri();
	if (!uri) {
		throw new Error('SENTENCIAS_MONGO_URI/URLDB no configurada para la conexión de sentencias');
	}
	if (uri === defaultUri()) {
		// Misma URI que la conexión principal: reutilizar SIEMPRE el pool default,
		// aunque todavía no haya conectado (readyState 0 durante el arranque —
		// mongoose bufferiza las ops de modelos hasta que server.js conecte).
		// Abrir una dedicada acá cachearía un pool duplicado permanente.
		_conn = mongoose.connection;
		logger.info('[sentenciasConnection] reutilizando la conexión default de mongoose (misma URI)');
	} else {
		_conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 20000 });
		_conn.asPromise()
			.then(() => logger.info('[sentenciasConnection] conexión dedicada de sentencias establecida'))
			.catch((err) => logger.error(`[sentenciasConnection] error conectando la conexión dedicada: ${err.message}`));
	}
	return _conn;
}

/**
 * Devuelve el `Db` nativo de la conexión de sentencias, esperando a que esté
 * conectada. Rechaza si la URI no está configurada o el connect falla (el
 * próximo llamado recrea la conexión dedicada si quedó caída).
 */
async function getSentenciasDb() {
	const conn = getSentenciasConnection();
	if (conn.readyState !== 1) await conn.asPromise();
	return conn.db;
}

/**
 * Registra (una sola vez) y devuelve un modelo sobre la conexión de sentencias.
 * Se re-registra solo si la conexión dedicada fue recreada tras una caída.
 */
function getSentenciasModel(name, schema) {
	const conn = getSentenciasConnection();
	return conn.models[name] || conn.model(name, schema);
}

/**
 * Envuelve un modelo en un Proxy de resolución lazy: los modelos se exportan a
 * module-load (antes de que exista la URI), así que el binding real al modelo
 * se difiere hasta el primer acceso (siempre dentro de un request handler,
 * con el env ya cargado). Mantiene la interfaz de `mongoose.model(...)`:
 * estáticos (find, aggregate, ...), propiedades (db, schema, collection) y
 * construcción de documentos (`new Model(...)`).
 */
function lazyModel(name, schema) {
	const resolve = () => getSentenciasModel(name, schema);
	return new Proxy(function () {}, {
		get(_target, prop) {
			const model = resolve();
			const value = model[prop];
			return typeof value === 'function' ? value.bind(model) : value;
		},
		set(_target, prop, value) {
			resolve()[prop] = value;
			return true;
		},
		has(_target, prop) {
			return prop in resolve();
		},
		construct(_target, args) {
			const Model = resolve();
			return new Model(...args);
		},
		getPrototypeOf() {
			return Object.getPrototypeOf(resolve());
		},
	});
}

module.exports = { getSentenciasConnection, getSentenciasDb, getSentenciasModel, lazyModel };
