const { logger } = require('../config/pino');

/**
 * Vínculo bidireccional principal ↔ incidentes (PJN, 2026-09-28).
 *
 * Identidad = {number, year, incidente}: null = principal, "42"/"42/2" = incidente.
 * Los incidentes los trae la credencial de Mis Causas (pjn-mis-causas) y quedan con
 * `parentCausaId` solo si el principal ya existía en ese momento. Cuando pjn-api CREA
 * el principal (alta por número/año de un usuario) hay que dejar vinculados los
 * incidentes que ya estaban en la colección:
 *   - cada incidente: parentCausaId = principal._id (solo donde estaba null)
 *   - el principal:   incidentes = [{ causaId, incidente, linkedAt }] en orden natural
 *
 * Escrituras con updateOne/updateMany + { strict: false }: la pjn-models instalada acá
 * (1.53.0) no declara `incidentes` y Mongoose descarta en los updates los paths que no
 * están en el esquema. Nunca aborta el alta: cualquier error se loguea y devuelve { linked: 0 }.
 * Misma lógica que law-analytics-server/services/incidentesLinkService.js.
 */

// "1" < "2" < "12" < "12/2" < "42/2": compara segmento a segmento en numérico.
function claveNatural(incidente) {
    return String(incidente ?? '').split('/').map((s) => {
        const n = parseInt(s, 10);
        return Number.isNaN(n) ? s.trim() : n;
    });
}

function compararIncidentes(a, b) {
    const ka = claveNatural(a);
    const kb = claveNatural(b);
    const len = Math.max(ka.length, kb.length);
    for (let i = 0; i < len; i++) {
        if (ka[i] === undefined) return -1;
        if (kb[i] === undefined) return 1;
        if (ka[i] === kb[i]) continue;
        if (typeof ka[i] === 'number' && typeof kb[i] === 'number') return ka[i] - kb[i];
        return String(ka[i]).localeCompare(String(kb[i]), undefined, { numeric: true });
    }
    return 0;
}

/**
 * Vincula al principal recién creado los incidentes ya existentes de su número/año.
 * @param {import('mongoose').Model} CausaModel - Modelo de la colección (CausasCivil, CausasSegSoc, ...)
 * @param {{ _id: any, number: number, year: number }} principal - Doc del principal recién creado
 * @returns {Promise<{ linked: number }>} cantidad de incidentes vinculados
 */
async function vincularIncidentesDePrincipal(CausaModel, principal) {
    try {
        if (!CausaModel || !principal || !principal._id) return { linked: 0 };
        const { number, year } = principal;
        if (number === undefined || number === null || year === undefined || year === null) return { linked: 0 };

        const incidentes = await CausaModel.find({ number, year, incidente: { $ne: null } })
            .select('_id incidente parentCausaId')
            .setOptions({ strictQuery: false })
            .lean();
        if (!incidentes.length) return { linked: 0 };

        const now = new Date();

        // parentCausaId solo donde estaba null (null matchea null y ausente).
        await CausaModel.updateMany(
            { _id: { $in: incidentes.map((i) => i._id) }, parentCausaId: null },
            { $set: { parentCausaId: principal._id } },
            { strict: false, strictQuery: false }
        );

        // Reemplazo completo del array calculado (sin duplicados por construcción).
        const lista = incidentes
            .slice()
            .sort((a, b) => compararIncidentes(a.incidente, b.incidente))
            .map((i) => ({ causaId: i._id, incidente: i.incidente, linkedAt: now }));

        await CausaModel.updateOne(
            { _id: principal._id },
            { $set: { incidentes: lista } },
            { strict: false, strictQuery: false }
        );

        logger.info(`Principal ${CausaModel.modelName} ${number}/${year} (${principal._id}) vinculado a ${lista.length} incidente(s): ${lista.map((i) => i.incidente).join(', ')}`);
        return { linked: lista.length };
    } catch (error) {
        logger.error(`Error vinculando incidentes al principal ${principal && principal._id}: ${error.message}`);
        return { linked: 0 };
    }
}

module.exports = { vincularIncidentesDePrincipal, compararIncidentes };
