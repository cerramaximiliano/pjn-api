/**
 * Segmentación estructural de resoluciones judiciales (determinística).
 * Port JS de pjn-etapa-model/src/segmentar.py — mantener en sincronía.
 *
 * Detecta las secciones rituales por sus fórmulas: encabezado → vistos →
 * considerandos → parte dispositiva → firma. El extracto útil para
 * clasificar/revisar es `encabezado + parte dispositiva`.
 */

function sinTildes(t) {
    return (t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// Fórmulas de apertura de la parte dispositiva. Se toma la ÚLTIMA ocurrencia
// (los considerandos citan "resuelve" de otras resoluciones; la propia es la final).
const RE_DISPOSITIVA = new RegExp(
    "(POR\\s+(?:ELLO|TODO\\s+ELLO|LO\\s+EXPUESTO)[\\s\\S]{0,300}?" +
    "(?:SE\\s+RESUELVE|RESUELVE[NSE]*|RESUELVO|FALLA|FALLO)\\s*[:;.]?" +
    "|(?:EL\\s+TRIBUNAL|LA\\s+SALA|ESTA\\s+SALA|EL\\s+JUZGADO|S\\.?\\s?S\\.?)\\s+RESUELVE\\s*[:;.]?" +
    "|\\bSE\\s+RESUELVE\\s*[:;.]" +
    "|\\bRESUELVO\\s*[:;.]" +
    "|\\bRESUELVE\\s*[:;.]" +
    "|\\bFALLO\\s*[:;.]" +
    "|\\bFALLA\\s*[:;.])",
    "gi"
);
const RE_CONSIDERANDO = /\bCONSIDERANDO\S{0,2}\s*[:;.]?/i;
const RE_VISTOS = /(AUTOS?\s+Y\s+VISTOS?|VISTOS?\s+Y\s+CONSIDERANDO\S{0,2}|VISTOS?\s*[:;])/i;
const RE_FIRMA = new RegExp(
    "(REG[IÍ]STRESE[\\s\\S]{0,80}NOTIF[IÍ]QUESE|NOTIF[IÍ]QUESE\\s+Y\\s+REG[IÍ]STRESE" +
    "|FIRMADO(?:\\s+DIGITALMENTE)?\\s*[:;]|ANTE\\s+M[IÍ]\\s*[:;])",
    "i"
);

function segmentar(texto) {
    const t = texto || "";
    const plano = sinTildes(t);

    const mVistos = plano.match(RE_VISTOS);
    const mCons = plano.match(RE_CONSIDERANDO);
    let mDisp = null;
    RE_DISPOSITIVA.lastIndex = 0;
    for (let m; (m = RE_DISPOSITIVA.exec(plano)) !== null; ) mDisp = { index: m.index, texto: m[0] };

    const inicios = [mVistos && mVistos.index, mCons && mCons.index, mDisp && mDisp.index]
        .filter((x) => typeof x === "number");
    const finEnc = inicios.length ? Math.min(...inicios) : Math.min(t.length, 400);

    let dispositiva = "";
    if (mDisp) {
        dispositiva = t.slice(mDisp.index);
        const mFirma = sinTildes(dispositiva).match(RE_FIRMA);
        if (mFirma && mFirma.index > 40) {
            dispositiva = dispositiva.slice(0, mFirma.index + mFirma[0].length);
        }
    }

    return {
        encabezado: t.slice(0, finEnc).trim(),
        dispositiva: dispositiva.trim(),
        tieneVistos: !!mVistos,
        tieneConsiderandos: !!mCons,
        tieneDispositiva: !!mDisp,
    };
}

function extractoRevision(texto, maxEnc = 350, maxDisp = 2000) {
    const s = segmentar(texto);
    const partes = [];
    if (s.encabezado) partes.push(s.encabezado.slice(0, maxEnc));
    if (s.dispositiva) partes.push("[…]\n" + s.dispositiva.slice(0, maxDisp));
    else if (!partes.length) partes.push((texto || "").slice(0, maxEnc + maxDisp));
    return partes.join("\n");
}

module.exports = { segmentar, extractoRevision };
