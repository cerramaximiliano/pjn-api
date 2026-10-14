/**
 * limpiarTextoResolucion — limpieza del texto crudo de pdf-parse de una resolución PJN.
 *
 * Copia autocontenida de `cleanSentenciaText` (pjn-rag-shared/src/services/text/sentenciaChunker.js),
 * que es lo que aplica el pipeline de sentencias-capturadas antes de guardar. pjn-api no
 * depende de pjn-rag-shared, por eso se copia. Quita: ids de sistema (#id#id#ts), marcas de
 * agua verticales, pies repetidos (Fecha de firma / Firmado por), ".-" sueltos y iniciales
 * pegadas a la fecha, repeticiones del encabezado del tribunal, números de página sueltos;
 * repara sustantivos truncados ("regulació" → "regulación") y une cortes de línea/página.
 * Idempotente. Mantener en sincronía con el origen y con src/texto.py::limpiar del repo
 * pjn-clasificador-resoluciones.
 */

const MAX_TRIBUNAL_CHARS = 600;
const RE_ANTECEDENTES = /(?:(?:AUTOS\s+Y\s+)?Y?\s*VISTOS?\s*[:\.]|(?:Y\s+)?RESULTANDO\s*[:\.]|ANTECEDENTES\s*[:\.])/i;
const RE_CONSIDERANDO = /(?:VISTOS?\s+Y\s+CONSIDERANDO|(?:Y\s+)?CONSIDERANDO)\s*[:.:\n]?(?=\s)/i;
const RE_VOTO_CUESTION = /(?:Sobre|A)\s+la\s+cuesti[oó]n\s+propuesta[^\n]{0,80}?dijo\s*:/i;

const EXPLICIT_FIXES = new Map([
  ['intervenció', 'intervención'], ['reintervenció', 'reintervención'], ['presunció', 'presunción'], ['prevenció', 'prevención'],
  ['extinció', 'extinción'], ['intenció', 'intención'], ['obtenció', 'obtención'], ['retenció', 'retención'], ['distinció', 'distinción'],
  ['perenció', 'perención'], ['detenció', 'detención'], ['disfunció', 'disfunción'], ['desatenció', 'desatención'], ['defunció', 'defunción'],
  ['conjunció', 'conjunción'], ['contenció', 'contención'], ['reconvenció', 'reconvención'], ['contravenció', 'contravención'],
  ['abstenció', 'abstención'], ['mantenció', 'mantención'], ['invenció', 'invención'], ['manutenció', 'manutención'], ['subvenció', 'subvención'],
  ['reinserció', 'reinserción'], ['proporció', 'proporción'], ['desproporció', 'desproporción'], ['deserció', 'deserción'], ['inserció', 'inserción'],
  ['absorció', 'absorción'], ['relació', 'relación'], ['citació', 'citación'], ['atenció', 'atención'], ['sanció', 'sanción'], ['menció', 'mención'],
  ['funció', 'función'], ['canció', 'canción'], ['tambié', 'también'], ['demá', 'demás'], ['ademá', 'además'], ['ningú', 'ningún'], ['algú', 'algún'],
  ['segú', 'según'], ['comú', 'común'],
]);
const EXPLICIT_RE = new RegExp('(?<![\\wáéíóúüñÁÉÍÓÚÜÑ])(' + [...EXPLICIT_FIXES.keys()].sort((a, b) => b.length - a.length).join('|') + ')(?=[\\s.,;:()\\[\\]!?»\\n]|$)', 'gim');

function preserveCase(original, replacement) {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

function fixEncodingArtifacts(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/​/g, ' ');
  t = t.replace(/[­‌‍﻿]/g, '');
  t = t.replace(/([\wáéíóúüñ]{1,}[áéíóú])(\n+)([ns])(?=[\s.,;:()\[\]!?»\n]|$)/gim, (m, word, newlines, consonant) => {
    const c = word === word.toUpperCase() ? consonant.toUpperCase() : consonant;
    return word + c + newlines;
  });
  const appendN = (m) => m + (m === m.toUpperCase() ? 'N' : 'n');
  t = t.replace(/[\wáéíóúüñ]{5,}ació(?=[\s.,;:()\[\]!?»\n]|$)/gim, appendN);
  for (const suf of ['ució', 'ició', 'esió', 'usió', 'isió', 'nsió', 'pció', 'cció']) {
    t = t.replace(new RegExp(suf + '(?=[\\s.,;:()\\[\\]!?»\\n]|$)', 'gim'), appendN);
  }
  t = t.replace(EXPLICIT_RE, (m) => preserveCase(m, EXPLICIT_FIXES.get(m.toLowerCase()) || m));
  return t;
}

const stripAllPjnHeaders = (text) => text.replace(/^#[\w\d]+(?:#[\w\d]+)*[^\n]*\n?/gm, '');
const stripVerticalText = (text) => text.replace(/(?:[A-ZÁÉÍÓÚÜÑ ]\n){4,}/g, ' ');

function findTribunalSplit(text) {
  const sectionMatches = [RE_ANTECEDENTES.exec(text), RE_CONSIDERANDO.exec(text), RE_VOTO_CUESTION.exec(text)].filter(Boolean);
  let splitAt = text.length;
  if (sectionMatches.length > 0) splitAt = Math.min(...sectionMatches.map((m) => m.index));
  if (splitAt > 1000) {
    const cap = Math.min(splitAt, MAX_TRIBUNAL_CHARS);
    const nl = text.lastIndexOf('\n', cap);
    splitAt = nl > 0 ? nl + 1 : cap;
  }
  return splitAt;
}
function collectHeaderLines(headText) {
  return headText.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 10 || /^SALA\s+(?:[IVX]{1,4}|[A-Z]|\d{1,2})$/.test(l))
    .filter((l) => !/^(?:Buenos Aires|Capital|República)/.test(l));
}
function removeTribunalRepetitions(headerLines, body) {
  for (const line of headerLines) {
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      body = body.replace(new RegExp('^[ \\t]*' + escaped + '[ \\t]*\\n', 'gm'), '\n');
      body = body.replace(new RegExp('^[ \\t]*' + escaped + '[ \\t]+', 'gm'), '');
    } catch (_) { /* línea malformada */ }
  }
  return body;
}

function limpiarTextoResolucion(text) {
  if (!text) return '';
  let t = fixEncodingArtifacts(text);
  t = stripAllPjnHeaders(t);
  t = stripVerticalText(t);
  t = t.replace(/Fecha de firma:[^\n]*(?:\n(?:Alta en sistema|Firmado por)[^\n]*)*/gm, '').replace(/^(?:Alta en sistema|Firmado por):[^\n]*/gm, '');
  t = t.replace(/,\s*\.-\s*(\d{1,2})/g, ', $1');
  t = t.replace(/(\s)\.-\s+(?=[a-záéíóúüñ])/gi, '$1');
  t = t.replace(/(?<!\d)(\d{4})[A-Z]{2,6}(?:\/[A-Z]{2,6})?(?=[ \t]*$)/gm, '$1');
  const pjnRe = /Poder Judicial de la Naci[oó]n[ \t]*\n?/g;
  const firstPjn = pjnRe.exec(t);
  if (firstPjn) {
    const fin = firstPjn.index + firstPjn[0].length;
    t = t.slice(0, fin) + t.slice(fin).replace(/Poder Judicial de la Naci[oó]n[ \t]*\n?/g, '');
  }
  {
    const splitAt = findTribunalSplit(t);
    if (splitAt > 0) {
      const head = t.slice(0, splitAt);
      t = head + removeTribunalRepetitions(collectHeaderLines(head), t.slice(splitAt));
    }
  }
  t = t.replace(/^\s*\d{1,3}\s*$/gm, '');
  t = t.replace(/ {2,}/g, ' ');
  t = t.replace(/([a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9,;"\)\]»])\n([a-záéíóúüñ])/g, '$1 $2');
  t = t.replace(/([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:[bcfghkmptv]|qu))[ \t]*\n{2,}[ \t]*(?=[a-záéíóúüñ])/g, '$1');
  t = t.replace(/([a-záéíóúüñ0-9,;"\)\]»])[ \t]*\n{2,}[ \t]*(?=[a-záéíóúüñ])/g, '$1 ');
  {
    const rePie = /(?:^|\n)[ \t]*Tribunal\s+de\s+origen\s*:/gi;
    let mPie, ultimo = null;
    while ((mPie = rePie.exec(t)) !== null) ultimo = mPie.index;
    if (ultimo !== null && ultimo > t.length * 0.85) t = t.slice(0, ultimo).trim();
  }
  t = t.replace(/^[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

module.exports = { limpiarTextoResolucion };
