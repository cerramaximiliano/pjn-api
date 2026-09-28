/**
 * Test de integración (node + assert) de causasService.associateFolderToCausa
 * con identidad {number, year, incidente} (2026-09-28: el principal CSS 35258/2010
 * quedó con la carátula y los movimientos de su queja /2).
 *
 * Corre contra URLDB_TEST: la toma del .env de pjn-api o, si no está, del .env de
 * law-analytics-server. NUNCA cae a URLDB (producción). Docs sintéticos con
 * number 9935259 en `causas-segsocial` y `causas-civil`, borrados al inicio y al final.
 *
 * Uso: node scripts/test-associate-incidente.js
 */
const path = require('path');
const assert = require('assert');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.URLDB_TEST) {
    dotenv.config({ path: path.join(__dirname, '..', '..', 'law-analytics-server', '.env') });
}
if (!process.env.URLDB_TEST) {
    console.error('URLDB_TEST no está definida ni en pjn-api/.env ni en law-analytics-server/.env. Este script NO corre contra URLDB (producción). Abortando.');
    process.exit(2);
}
if (process.env.URLDB && process.env.URLDB_TEST === process.env.URLDB) {
    console.error('URLDB_TEST apunta a la misma URI que URLDB (producción). Abortando.');
    process.exit(2);
}

const mongoose = require('mongoose');
const { CausasSegSoc, CausasCivil } = require('pjn-models');
const causaService = require('../src/service/causasService');
const { compararIncidentes } = require('../src/service/incidentesLinkService');

const NUMBER = 9935259;
const YEAR = 2010;
const oid = () => new mongoose.Types.ObjectId();
const userId = oid();
const folderId = oid();

const quejaDoc = () => ({
    number: NUMBER, year: YEAR, incidente: '2', fuero: 'CSS', source: 'pjn-login',
    caratula: 'Recurso Queja Nº 2 - PEREZ JUAN c/ ANSES s/ REAJUSTES VARIOS',
    verified: true, isValid: true, folderIds: [], userCausaIds: [], userUpdatesEnabled: [],
});
const principalDoc = (extra = {}) => ({
    ...quejaDoc(), incidente: null, caratula: 'PEREZ JUAN c/ ANSES s/ REAJUSTES VARIOS', ...extra,
});

const ss = () => mongoose.connection.db.collection('causas-segsocial');
const civ = () => mongoose.connection.db.collection('causas-civil');

async function limpiar() {
    await CausasSegSoc.deleteMany({ number: NUMBER });
    await CausasCivil.deleteMany({ number: NUMBER });
}

const casos = [];
const caso = (nombre, fn) => casos.push({ nombre, fn });

caso('(1) solo existe la queja → findOne con incidente:null no la devuelve (sí con incidente:"2")', async () => {
    await ss().insertOne(quejaDoc());
    assert.strictEqual(await CausasSegSoc.findOne({ number: NUMBER, year: YEAR, incidente: null }), null);
    assert.ok(await CausasSegSoc.findOne({ number: NUMBER, year: YEAR, incidente: '2' }));
});

caso('(2) solo la queja → associateFolderToCausa crea el principal (incidente null) y no toca la queja', async () => {
    await ss().insertOne(quejaDoc());
    const r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    assert.ok(r, 'associateFolderToCausa devolvió null');
    assert.strictEqual(r.created, true);

    const docs = await ss().find({ number: NUMBER, year: YEAR }).toArray();
    assert.strictEqual(docs.length, 2);
    const principal = docs.find((d) => d.incidente === null);
    assert.ok(principal, 'no se creó el principal con incidente:null');
    assert.strictEqual(String(principal._id), String(r.causaId));
    assert.deepStrictEqual(principal.folderIds.map(String), [String(folderId)]);
    assert.strictEqual(principal.source, 'app');

    const queja = docs.find((d) => d.incidente === '2');
    assert.deepStrictEqual(queja.folderIds, []);
    assert.deepStrictEqual(queja.userCausaIds, []);
    assert.strictEqual(queja.source, 'pjn-login');
    assert.ok(/^Recurso Queja Nº 2/.test(queja.caratula));
});

caso('(3) principal legacy sin campo incidente + queja → se vincula el principal (created:false)', async () => {
    const { insertedId } = await ss().insertOne({ number: NUMBER, year: YEAR, fuero: 'CSS', source: 'scraping', caratula: 'PEREZ JUAN c/ ANSES s/ REAJUSTES VARIOS', verified: true, isValid: true });
    await ss().insertOne(quejaDoc());

    const r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    assert.ok(r, 'associateFolderToCausa devolvió null');
    assert.strictEqual(r.created, false);
    assert.strictEqual(String(r.causaId), String(insertedId));
    assert.strictEqual(r.caratula, 'PEREZ JUAN c/ ANSES s/ REAJUSTES VARIOS');
    const queja = await ss().findOne({ number: NUMBER, incidente: '2' });
    assert.ok(!queja.folderIds || queja.folderIds.length === 0, 'la queja no debe recibir folderIds');
});

caso('(4) source: no pisa pjn-login, sí promueve cache → app', async () => {
    const { insertedId: privId } = await ss().insertOne(principalDoc({ source: 'pjn-login' }));
    let r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    assert.strictEqual(String(r.causaId), String(privId));
    assert.strictEqual((await ss().findOne({ _id: privId })).source, 'pjn-login');

    await limpiar();

    const { insertedId: cacheId } = await ss().insertOne(principalDoc({ source: 'cache' }));
    r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    assert.strictEqual(String(r.causaId), String(cacheId));
    assert.strictEqual((await ss().findOne({ _id: cacheId })).source, 'app');
});

caso('(5) CausasCivil: el modelo se resuelve (pjn-models lo registra como "Causas") y escribe en causas-civil', async () => {
    assert.strictEqual(mongoose.models.CausasCivil, undefined, 'precondición: pjn-models no registra "CausasCivil"');
    assert.ok(mongoose.models.Causas, 'precondición: pjn-models registra "Causas"');

    const r = await causaService.associateFolderToCausa('CausasCivil', { number: NUMBER, year: YEAR, userId, folderId });
    assert.ok(r, 'associateFolderToCausa devolvió null para CausasCivil (antes: "Modelo CausasCivil no encontrado")');
    assert.strictEqual(r.created, true);
    const doc = await civ().findOne({ _id: r.causaId });
    assert.ok(doc, 'el doc no quedó en causas-civil');
    assert.strictEqual(doc.incidente, null);
    assert.strictEqual(doc.fuero, 'CIV');
});

// ---- Vínculo bidireccional principal ↔ incidentes (2026-09-28) ----

caso('(6) queja existente (parentCausaId null) → el principal nuevo queda vinculado en ambos sentidos', async () => {
    const { insertedId: quejaId } = await ss().insertOne({ ...quejaDoc(), parentCausaId: null });

    const r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    assert.ok(r, 'associateFolderToCausa devolvió null');
    assert.strictEqual(r.created, true);

    const principal = await ss().findOne({ _id: r.causaId });
    assert.strictEqual(principal.incidente, null);
    assert.ok(Array.isArray(principal.incidentes) && principal.incidentes.length === 1, 'el principal no tiene incidentes[] (¿strict descartó el path?)');
    assert.strictEqual(String(principal.incidentes[0].causaId), String(quejaId));
    assert.strictEqual(principal.incidentes[0].incidente, '2');
    assert.ok(principal.incidentes[0].linkedAt instanceof Date, 'linkedAt no es Date');

    const queja = await ss().findOne({ _id: quejaId });
    assert.strictEqual(String(queja.parentCausaId), String(r.causaId));
    // La queja no se toca en nada más.
    assert.deepStrictEqual(queja.folderIds, []);
    assert.deepStrictEqual(queja.userCausaIds, []);
    assert.strictEqual(queja.source, 'pjn-login');
});

caso('(7) incidentes "12" y "1" (insertados en ese orden) → incidentes[] en orden natural ["1","12"] y ambos con parentCausaId', async () => {
    const { insertedId: id12 } = await ss().insertOne({ ...quejaDoc(), incidente: '12', parentCausaId: null });
    const { insertedId: id1 } = await ss().insertOne({ ...quejaDoc(), incidente: '1' }); // sin el campo: también cuenta como null

    const r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    const principal = await ss().findOne({ _id: r.causaId });
    assert.deepStrictEqual(principal.incidentes.map((i) => i.incidente), ['1', '12']);
    assert.deepStrictEqual(principal.incidentes.map((i) => String(i.causaId)), [String(id1), String(id12)]);

    const hijos = await ss().find({ number: NUMBER, year: YEAR, incidente: { $ne: null } }).toArray();
    assert.strictEqual(hijos.length, 2);
    for (const h of hijos) assert.strictEqual(String(h.parentCausaId), String(r.causaId));
});

caso('(8) sin incidentes → el principal nuevo no recibe incidentes[]', async () => {
    const r = await causaService.associateFolderToCausa('CausasSegSocial', { number: NUMBER, year: YEAR, userId, folderId });
    const principal = await ss().findOne({ _id: r.causaId });
    assert.ok(principal.incidentes === undefined || principal.incidentes.length === 0, 'no debía escribirse incidentes[]');
});

caso('(9) compararIncidentes: orden natural por segmentos', async () => {
    const entrada = ['42/10', '42/2', '12', '2', '1', '42', '12/2'];
    assert.deepStrictEqual(entrada.slice().sort(compararIncidentes), ['1', '2', '12', '12/2', '42', '42/2', '42/10']);
});

(async () => {
    let fallidos = 0;
    try {
        await mongoose.connect(process.env.URLDB_TEST, { serverSelectionTimeoutMS: 10000 });
        const dbName = mongoose.connection.db.databaseName;
        assert.ok(/test/i.test(dbName), `La base conectada (${dbName}) no parece de test. Abortando.`);
        console.log(`Conectado a ${dbName}`);

        for (const { nombre, fn } of casos) {
            await limpiar();
            try {
                await fn();
                console.log(`✓ ${nombre}`);
            } catch (e) {
                fallidos++;
                console.log(`✗ ${nombre}\n   ${e.message}`);
            }
        }
    } finally {
        await limpiar().catch(() => {});
        await mongoose.disconnect().catch(() => {});
    }
    console.log(`\n${casos.length - fallidos}/${casos.length} casos OK`);
    process.exit(fallidos ? 1 : 0);
})();
