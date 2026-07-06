'use strict';
/**
 * queryPlanner.js
 *
 * Router de consulta por prompt (self-query retriever). Convierte el prompt en
 * lenguaje natural del usuario en un SearchPlan estructurado usando la API de
 * OpenAI (JSON mode). El plan alimenta la búsqueda de sentencias:
 *   - filters: juzgado/sala/fuero/sentenciaTipo/dateFrom/dateTo → filtro Qdrant
 *   - lexicalTerms: citas exactas a exigir (art. X / ley Y) → capa léxica (futura)
 *   - semanticQuery: intención conceptual → embedding
 *   - strategy / needsExactCitation
 *
 * Es OPCIONAL: el endpoint /sentencias/ask solo lo invoca si el flag
 * ConfiguracionSemanticWorker.searchQueryPlanner.enabled === true (toggle admin).
 * Ante cualquier error/timeout devuelve null → el caller cae a búsqueda simple.
 */
const OpenAI = require('openai').default;
const { logger } = require('../config/pino');

let _openai = null;
function getOpenAI() {
	if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	return _openai;
}

const SYSTEM_PROMPT = `Sos un planificador de consultas para un buscador de SENTENCIAS judiciales argentinas.
Recibís el prompt en lenguaje natural de un abogado y devolvés SOLO un JSON (sin texto extra) con este shape exacto:

{
  "semanticQuery": string,        // la intención CONCEPTUAL, reescrita para búsqueda semántica (sin números de juzgado ni fechas). Ej: "criterio sobre la sanción conminatoria por retención de aportes no ingresados".
  "lexicalTerms": string[],       // citas EXACTAS que el prompt exige encontrar textualmente. Normalizá: "artículo 132 bis"->"132 bis", "ley 27.742"->"27742" o "ley 27742", "art 80"->"art 80". Vacío [] si no hay citas exactas.
  "filters": {
    "juzgado": number|null,       // número de juzgado de 1ra instancia si el prompt lo menciona ("juzgado 52"->52). null si no.
    "sala": number|null,          // número de Sala de Cámara. Convertí romanos: "Sala II"->2, "Sala X"->10. null si no.
    "fuero": "CNT"|"CIV"|"CSS"|"COM"|null,  // CNT=trabajo/laboral, CIV=civil, CSS=seguridad social/previsional, COM=comercial. null si no se infiere.
    "sentenciaTipo": "definitiva"|"interlocutoria"|null,
    "dateFrom": string|null,      // ISO YYYY-MM-DD. "en 2025 y 2026"->"2025-01-01". "desde marzo 2025"->"2025-03-01". null si no.
    "dateTo": string|null         // ISO YYYY-MM-DD. null si abierto.
  },
  "strategy": "semantic"|"lexical"|"hybrid",  // "hybrid" por defecto; "lexical" si es puramente búsqueda de una cita exacta; "semantic" si es puramente conceptual sin citas.
  "needsExactCitation": boolean   // true si el prompt requiere artículos/leyes específicos.
}

Reglas:
- NO inventes filtros que el prompt no menciona: si no aparece, va null (o [] para lexicalTerms).
- Si mencionan un artículo o ley concreta, poné needsExactCitation=true y agregá el término a lexicalTerms.
- semanticQuery siempre presente: capturá el tema aunque haya filtros.
- Fecha: si dicen solo años (ej "2025 y 2026"), dateFrom = "AAAA-01-01" del año menor, dateTo = null.`;

function coercePlan(raw) {
	const f = (raw && raw.filters) || {};
	const asInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : null);
	const fueros = ['CNT', 'CIV', 'CSS', 'COM'];
	const tipos = ['definitiva', 'interlocutoria'];
	const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
	return {
		semanticQuery: (typeof raw.semanticQuery === 'string' && raw.semanticQuery.trim()) || '',
		lexicalTerms: Array.isArray(raw.lexicalTerms) ? raw.lexicalTerms.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 8) : [],
		filters: {
			juzgado: asInt(f.juzgado),
			sala: asInt(f.sala),
			fuero: fueros.includes(f.fuero) ? f.fuero : null,
			sentenciaTipo: tipos.includes(f.sentenciaTipo) ? f.sentenciaTipo : null,
			dateFrom: isoDate(f.dateFrom),
			dateTo: isoDate(f.dateTo),
		},
		strategy: ['semantic', 'lexical', 'hybrid'].includes(raw.strategy) ? raw.strategy : 'hybrid',
		needsExactCitation: raw.needsExactCitation === true,
	};
}

/**
 * @param {string} prompt
 * @param {{ model?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<object|null>} SearchPlan validado, o null si falla.
 */
async function planQuery(prompt, opts = {}) {
	const model = opts.model || 'gpt-4o-mini';
	const t0 = Date.now();
	try {
		const openai = getOpenAI();
		const resp = await openai.chat.completions.create(
			{
				model,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: String(prompt).slice(0, 2000) },
				],
				response_format: { type: 'json_object' },
				temperature: 0,
				max_tokens: 400,
			},
			{ timeout: opts.timeoutMs || 8000 }
		);
		const content = resp.choices[0]?.message?.content;
		if (!content) return null;
		const plan = coercePlan(JSON.parse(content));
		plan._meta = { model, latencyMs: Date.now() - t0, tokens: resp.usage?.total_tokens };
		logger.info({ prompt: String(prompt).slice(0, 120), plan }, '[queryPlanner] plan generado');
		return plan;
	} catch (e) {
		logger.warn(`[queryPlanner] error (${Date.now() - t0}ms): ${e.message}`);
		return null;
	}
}

module.exports = { planQuery };
