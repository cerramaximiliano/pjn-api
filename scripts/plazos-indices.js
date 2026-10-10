// Índices del subsistema de plazos para las consultas de la admin (/admin/causas/plazos).
// Sin ellos, estadísticas y vencimientos barren plazos-notificaciones completa (30–45 s en el rs0).
// Se corre contra el PRIMARIO de cada base (los índices se replican). Idempotente.
// Uso: MONGO_URI=<uri> node scripts/plazos-indices.js            (rs0 desde worker_01, y/o Atlas)
//      MONGO_URI=<uri> node scripts/plazos-indices.js --dry-run  (solo muestra lo que crearía)
const { MongoClient } = require("mongodb");
const INDICES = {
	"plazos-notificaciones": [
		[{ processingStatus: 1, "plazo.vencimiento": 1 }, { name: "status_vencimiento" }],
		[{ "plazo.fuente": 1 }, { name: "plazo_fuente" }],
		// el índice por origen (cédulas de usuarios) lo crea plazos-worker-usuarios al arrancar (F2)
	],
	"plazos-dataset": [[{ sinPlazo: 1, "revision.estado": 1, plazoDias: 1 }, { name: "sinPlazo_revision_plazoDias" }]],
};
(async () => {
	const uri = process.env.MONGO_URI;
	if (!uri) throw new Error("Falta MONGO_URI");
	const dry = process.argv.includes("--dry-run");
	const c = new MongoClient(uri); await c.connect();
	const db = c.db();
	for (const [col, defs] of Object.entries(INDICES)) {
		if (!(await db.listCollections({ name: col }).toArray()).length) { console.log(`${col}: no existe en ${db.databaseName}, se saltea`); continue; }
		const existentes = new Set((await db.collection(col).indexes()).map((i) => i.name));
		for (const [key, opts] of defs) {
			if (existentes.has(opts.name)) { console.log(`${col}.${opts.name}: ya existe`); continue; }
			if (dry) { console.log(`${col}.${opts.name}: crearía ${JSON.stringify(key)}`); continue; }
			const t = Date.now(); await db.collection(col).createIndex(key, opts);
			console.log(`${col}.${opts.name}: creado en ${Date.now() - t} ms`);
		}
	}
	await c.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
