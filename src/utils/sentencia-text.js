'use strict';
/**
 * sentencia-text.js — acceso al texto de sentencias-capturadas con soporte
 * de compresión gzip (campos `text` plano o `textGz` Binary).
 * Espejo del helper homónimo en pjn-workers-scraping.
 */

const zlib = require('zlib');

function gunzipText(gz) {
	if (gz == null) return null;
	const buf = Buffer.isBuffer(gz) ? gz : gz.buffer ? Buffer.from(gz.buffer) : Buffer.from(gz);
	return zlib.gunzipSync(buf).toString('utf8');
}

/** Texto de un subdoc {text?, textGz?} — plano tiene prioridad (docs en pipeline). */
function getSubdocText(subdoc) {
	if (!subdoc) return null;
	if (subdoc.text != null) return subdoc.text;
	if (subdoc.textGz != null) return gunzipText(subdoc.textGz);
	return null;
}

module.exports = { gunzipText, getSubdocText };
