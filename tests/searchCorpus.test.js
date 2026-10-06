'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildSearchCorpusSet, SearchCorpusError } = require('../src/utils/searchCorpus');

test('buildSearchCorpusSet: un $set por subcampo, solo lo que viene', () => {
	assert.deepEqual(buildSearchCorpusSet({ app: 'saij', mcp: 'all' }), {
		'searchCorpus.app': 'saij',
		'searchCorpus.mcp': 'all',
	});
	assert.deepEqual(buildSearchCorpusSet({ public: 'all' }), { 'searchCorpus.public': 'all' });
	assert.deepEqual(buildSearchCorpusSet({ app: 'saij', mcp: 'saij', public: 'saij' }), {
		'searchCorpus.app': 'saij',
		'searchCorpus.mcp': 'saij',
		'searchCorpus.public': 'saij',
	});
});

test('buildSearchCorpusSet: rechaza valores, consumidores y formas inválidas', () => {
	assert.throws(() => buildSearchCorpusSet({ app: 'pjn' }), SearchCorpusError);
	assert.throws(() => buildSearchCorpusSet({ otro: 'saij' }), SearchCorpusError);
	assert.throws(() => buildSearchCorpusSet('all'), SearchCorpusError);
	assert.throws(() => buildSearchCorpusSet(['saij']), SearchCorpusError);
	assert.throws(() => buildSearchCorpusSet(null), SearchCorpusError);
	assert.throws(() => buildSearchCorpusSet({}), SearchCorpusError);
});

// ── Controller con el modelo simulado (sin Mongo) ─────────────────────────────

function loadControllerWithFakeModel(fake) {
	const modelPath = path.resolve(__dirname, '../src/models/ConfiguracionSemanticWorker.js');
	const ctrlPath = path.resolve(__dirname, '../src/controllers/configuracionSemanticWorkerController.js');
	delete require.cache[ctrlPath];
	require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: fake };
	return require(ctrlPath);
}

function fakeRes() {
	return {
		statusCode: 200,
		body: null,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
}

test('updateConfig: searchCorpus parcial se guarda por subcampo (no pisa los otros consumidores)', async () => {
	let captured = null;
	const fake = {
		findOneAndUpdate(filter, update) {
			captured = { filter, update };
			return { select: async () => ({ name: 'sentencias-semantic' }) };
		},
	};
	const ctrl = loadControllerWithFakeModel(fake);
	const res = fakeRes();
	await ctrl.updateConfig({ body: { searchCorpus: { app: 'saij', mcp: 'saij' }, topK: 10 } }, res);
	assert.equal(res.statusCode, 200);
	assert.deepEqual(captured.update, {
		$set: { 'searchCorpus.app': 'saij', 'searchCorpus.mcp': 'saij', topK: 10 },
	});
	assert.equal('searchCorpus' in captured.update.$set, false);
});

test('updateConfig: searchCorpus inválido → 400 sin escribir', async () => {
	let called = false;
	const fake = { findOneAndUpdate() { called = true; return { select: async () => ({}) }; } };
	const ctrl = loadControllerWithFakeModel(fake);
	const res = fakeRes();
	await ctrl.updateConfig({ body: { searchCorpus: { public: 'todo' } } }, res);
	assert.equal(res.statusCode, 400);
	assert.equal(called, false);
});
