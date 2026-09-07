/**
 * Tandas del app-update (AppUpdateTanda) y capacidad real de la flota.
 *
 * Una "tanda" es el drenado completo de los elegibles de un fuero: la de
 * apertura (08:00 ART, todo el pool vencido) mide cuánto tarda la flota en
 * pasar por todos los documentos una vez; las de goteo miden el ritmo del
 * resto del día. De ahí salen los KPIs que avisan si hay que tocar umbral,
 * cantidad de procesos o servidor.
 */
const {
    AppUpdateTanda, ConfiguracionAppUpdate, ManagerConfig,
    CausasCivil, CausasSegSoc, CausasTrabajo, CausasComercial,
} = require('pjn-models');
const { logger } = require('../config/pino');

const FUEROS = [
    { fuero: 'civil', fueroCode: 'CIV', model: CausasCivil },
    { fuero: 'ss', fueroCode: 'CSS', model: CausasSegSoc },
    { fuero: 'trabajo', fueroCode: 'CNT', model: CausasTrabajo },
    { fuero: 'comercial', fueroCode: 'COM', model: CausasComercial },
];

/** Mismo filtro de pool que countEligibleDocuments en pjn-workers (sin umbral ni lock). */
const FILTRO_POOL = {
    source: { $in: ['app', 'cache'] },
    verified: true,
    isValid: true,
    update: true,
    isPrivate: { $ne: true },
    listOnly: { $ne: true },
    movimientosCount: { $gt: 0 },
};

/** Referencia de seg/doc cuando todavía no hay tandas suficientes para medirla. */
const BASELINE_SEG_POR_DOC = 24;

/** Umbrales de alerta (ver docs de la vista Capacidad). */
const ALERTAS = {
    tandaVsUmbralPct: 80,      // la tanda de apertura tarda > 80 % del umbral
    utilizacionAltaPct: 70,    // demanda diaria / capacidad
    utilizacionBajaPct: 15,
    segPorDocFactor: 1.5,      // seg/doc > 1.5× baseline
    tasaExitoMinPct: 90,
    loadAlto: 1.5,             // load por CPU
    ayudaMaxPct: 50,           // más de la mitad de la tanda la hicieron helpers
};

function fechaArgentina(d = new Date()) {
    return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
}

function serializar(t) {
    const plain = t.toObject ? t.toObject({ flattenMaps: true }) : t;
    return { ...plain, resumen: AppUpdateTanda.resumir(t) };
}

function mediana(valores) {
    const v = valores.filter(x => typeof x === 'number' && x > 0).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10;
}

const tandasController = {
    /** GET /api/workers/tandas/today?date=YYYY-MM-DD */
    async getToday(req, res) {
        try {
            const date = req.query.date || fechaArgentina();
            const tandas = await AppUpdateTanda.find({ date }).sort({ inicio: 1 });
            res.json({ success: true, data: { date, tandas: tandas.map(serializar) } });
        } catch (error) {
            logger.error(`[tandas] getToday: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /** GET /api/workers/tandas/last?n=20&fuero=civil&soloApertura=true */
    async getLast(req, res) {
        try {
            const n = Math.min(parseInt(req.query.n) || 20, 200);
            const filtro = {};
            if (req.query.fuero) filtro.fuero = req.query.fuero;
            const tandas = await AppUpdateTanda.find(filtro).sort({ inicio: -1 }).limit(n);
            let lista = tandas.map(serializar);
            if (req.query.soloApertura === 'true') lista = lista.filter(t => t.resumen.esDeApertura);
            res.json({ success: true, data: lista });
        } catch (error) {
            logger.error(`[tandas] getLast: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/workers/tandas/capacity
     * Capacidad real: config vigente + pool/elegibles por fuero + última tanda
     * de apertura y última tanda de cada fuero + KPIs y alertas derivadas.
     */
    async getCapacity(req, res) {
        try {
            const hoy = fechaArgentina();
            const desde = new Date(Date.now() - 14 * 86400e3);
            const [managerConfig, configs, tandasRecientes] = await Promise.all([
                ManagerConfig.getConfig(),
                ConfiguracionAppUpdate.find({ update_mode: { $in: FUEROS.map(f => f.fuero) }, enabled: true }).lean(),
                AppUpdateTanda.find({ inicio: { $gte: desde } }).sort({ inicio: -1 }).lean(),
            ]);

            const workStartHour = managerConfig?.workStartHour ?? 8;
            const workEndHour = managerConfig?.workEndHour ?? 22;
            const horasLaborales = Math.max(1, workEndHour - workStartHour);
            const procesosPorFuero = managerConfig?.maxWorkers ?? 1;

            const now = new Date();
            const fueros = await Promise.all(FUEROS.map(async ({ fuero, fueroCode, model }) => {
                const config = configs.find(c => c.update_mode === fuero) || null;
                const umbralHoras = config?.last_update_threshold_hours ?? null;
                const [pool, elegiblesAhora, enProceso] = await Promise.all([
                    model.countDocuments(FILTRO_POOL),
                    umbralHoras
                        ? model.countDocuments({
                            ...FILTRO_POOL,
                            $or: [{ lastUpdate: { $exists: false } }, { lastUpdate: { $lt: new Date(now - umbralHoras * 3600e3) } }],
                        })
                        : 0,
                    model.countDocuments({ ...FILTRO_POOL, 'processingLock.expiresAt': { $gte: now } }),
                ]);

                const propias = tandasRecientes.filter(t => t.fuero === fuero);
                const conResumen = propias.map(t => ({ ...t, resumen: AppUpdateTanda.resumir(t) }));
                const cerradas = conResumen.filter(t => t.estado === 'cerrada');
                const aperturas = cerradas.filter(t => t.resumen.esDeApertura && t.procesados >= 5);
                const tandaApertura = aperturas[0] || null;
                const ultimaTanda = conResumen[0] || null;
                const abierta = conResumen.find(t => t.estado === 'abierta') || null;
                const tandasHoy = conResumen.filter(t => t.date === hoy);

                // Baseline propio del fuero: mediana de seg/doc de las tandas cerradas con volumen
                const baselineSegPorDoc = mediana(cerradas.filter(t => t.procesados >= 20).map(t => t.resumen.segPorDocPromedio)) || BASELINE_SEG_POR_DOC;
                const segPorDoc = tandaApertura?.resumen.segPorDocPromedio || baselineSegPorDoc;
                const procesosPropios = config ? procesosPorFuero : 0;

                // Rondas que exige el umbral por jornada y demanda diaria del fuero
                const rondasPorDia = umbralHoras ? Math.max(1, Math.floor(horasLaborales / umbralHoras)) : null;
                const demandaDiaria = rondasPorDia ? pool * rondasPorDia : null;
                // Capacidad con los procesos propios (sin ayuda), a segPorDoc medido
                const capacidadDiariaPropia = procesosPropios ? Math.round(procesosPropios * horasLaborales * 3600 / segPorDoc) : 0;
                // Pool máximo que los procesos propios drenan dentro de un umbral
                const poolMaxPropio = umbralHoras && procesosPropios ? Math.round(procesosPropios * umbralHoras * 3600 / segPorDoc) : null;
                // Duración estimada de una tanda completa sin ayuda de otros fueros
                const duracionSinAyudaMin = procesosPropios ? Math.round(pool * segPorDoc / procesosPropios / 60) : null;

                const kpis = {
                    umbralHoras,
                    rondasPorDia,
                    demandaDiaria,
                    capacidadDiariaPropia,
                    utilizacionPropiaPct: capacidadDiariaPropia && demandaDiaria !== null ? Math.round(demandaDiaria / capacidadDiariaPropia * 100) : null,
                    poolMaxPropio,
                    duracionSinAyudaMin,
                    duracionVsUmbralPct: tandaApertura && umbralHoras ? Math.round(tandaApertura.resumen.duracionMs / (umbralHoras * 3600e3) * 100) : null,
                    duracionSinAyudaVsUmbralPct: duracionSinAyudaMin !== null && umbralHoras ? Math.round(duracionSinAyudaMin / (umbralHoras * 60) * 100) : null,
                    segPorDoc,
                    baselineSegPorDoc,
                    segPorDocVsBaseline: Math.round(segPorDoc / baselineSegPorDoc * 100) / 100,
                    ayudaPct: tandaApertura?.procesados ? Math.round(tandaApertura.resumen.docsAyuda / tandaApertura.procesados * 100) : null,
                };

                const alertas = [];
                if (!config) alertas.push({ nivel: 'error', codigo: 'sin_config', mensaje: 'Sin configuración habilitada para este fuero' });
                if (kpis.duracionVsUmbralPct !== null && kpis.duracionVsUmbralPct > ALERTAS.tandaVsUmbralPct)
                    alertas.push({ nivel: kpis.duracionVsUmbralPct > 100 ? 'error' : 'warning', codigo: 'tanda_vs_umbral', mensaje: `La tanda de apertura tardó ${tandaApertura.resumen.duracionMin} min = ${kpis.duracionVsUmbralPct} % del umbral de ${umbralHoras} h: subir umbral o agregar procesos` });
                if (kpis.duracionSinAyudaVsUmbralPct !== null && kpis.duracionSinAyudaVsUmbralPct > 100)
                    alertas.push({ nivel: 'warning', codigo: 'depende_de_ayuda', mensaje: `Sin ayuda de otros fueros, drenar el pool (${pool} docs) llevaría ${duracionSinAyudaMin} min, más que el umbral de ${umbralHoras} h` });
                if (kpis.utilizacionPropiaPct !== null && kpis.utilizacionPropiaPct > ALERTAS.utilizacionAltaPct)
                    alertas.push({ nivel: kpis.utilizacionPropiaPct > 100 ? 'error' : 'warning', codigo: 'utilizacion_alta', mensaje: `Demanda diaria ${demandaDiaria} updates vs capacidad propia ${capacidadDiariaPropia} (${kpis.utilizacionPropiaPct} %)` });
                if (kpis.segPorDocVsBaseline > ALERTAS.segPorDocFactor)
                    alertas.push({ nivel: 'warning', codigo: 'lento', mensaje: `${segPorDoc} s/doc, ${kpis.segPorDocVsBaseline}× el baseline de ${baselineSegPorDoc} s: portal lento o servidor saturado` });
                if (tandaApertura?.resumen.tasaExito !== null && tandaApertura?.resumen.tasaExito < ALERTAS.tasaExitoMinPct)
                    alertas.push({ nivel: tandaApertura.resumen.tasaExito < 70 ? 'error' : 'warning', codigo: 'exito_bajo', mensaje: `Tasa de éxito ${tandaApertura.resumen.tasaExito} % en la tanda de apertura (errores: ${Object.entries(tandaApertura.errores || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'sin detalle'})` });
                if (tandaApertura?.resumen.loadPromedio > ALERTAS.loadAlto)
                    alertas.push({ nivel: 'warning', codigo: 'load_alto', mensaje: `Load promedio ${tandaApertura.resumen.loadPromedio} por CPU durante la tanda: el servidor está al límite, agregar procesos no rinde` });
                if (kpis.ayudaPct !== null && kpis.ayudaPct > ALERTAS.ayudaMaxPct)
                    alertas.push({ nivel: 'info', codigo: 'ayuda_alta', mensaje: `${kpis.ayudaPct} % de la tanda la procesaron helpers de otros fueros` });
                if (ultimaTanda?.motivoCierre === 'cierre_horario')
                    alertas.push({ nivel: 'warning', codigo: 'ronda_incompleta', mensaje: `La última tanda (#${ultimaTanda.numero} del ${ultimaTanda.date}) quedó incompleta al cierre del horario` });

                return {
                    fuero, fueroCode,
                    config: config ? { workerId: config.worker_id, umbralHoras, batchSize: config.batch_size, updateProgress: config.updateProgress } : null,
                    procesosPropios,
                    pool, elegiblesAhora, enProceso,
                    tandasHoy: tandasHoy.length,
                    procesadosHoy: tandasHoy.reduce((s, t) => s + t.procesados, 0),
                    tandaApertura, ultimaTanda, abierta,
                    kpis, alertas,
                };
            }));

            // Flota: demanda y capacidad agregadas. La capacidad de la flota es
            // la suma de sus procesos (con ayuda entre fueros, un proceso ocioso
            // trabaja para cualquier fuero).
            const procesosFlota = fueros.reduce((s, f) => s + f.procesosPropios, 0);
            const segPorDocFlota = mediana(fueros.map(f => f.kpis.segPorDoc)) || BASELINE_SEG_POR_DOC;
            const demandaDiaria = fueros.reduce((s, f) => s + (f.kpis.demandaDiaria || 0), 0);
            const capacidadDiaria = Math.round(procesosFlota * horasLaborales * 3600 / segPorDocFlota);
            const utilizacionPct = capacidadDiaria ? Math.round(demandaDiaria / capacidadDiaria * 100) : null;
            const poolTotal = fueros.reduce((s, f) => s + f.pool, 0);
            const alertasFlota = [];
            if (utilizacionPct !== null && utilizacionPct > ALERTAS.utilizacionAltaPct)
                alertasFlota.push({ nivel: utilizacionPct > 100 ? 'error' : 'warning', codigo: 'utilizacion_alta', mensaje: `La flota está al ${utilizacionPct} % (demanda ${demandaDiaria} updates/día, capacidad ${capacidadDiaria}): agregar procesos o subir umbrales` });
            if (utilizacionPct !== null && utilizacionPct < ALERTAS.utilizacionBajaPct)
                alertasFlota.push({ nivel: 'info', codigo: 'utilizacion_baja', mensaje: `La flota está al ${utilizacionPct} %: hay margen para bajar umbrales (más frescura) o sumar causas` });

            res.json({
                success: true,
                data: {
                    generadoEn: now,
                    hoy,
                    config: {
                        maxWorkers: managerConfig?.maxWorkers ?? null,
                        minWorkers: managerConfig?.minWorkers ?? null,
                        workStartHour, workEndHour, horasLaborales,
                        workDays: managerConfig?.workDays ?? null,
                        procesosFlota,
                    },
                    flota: {
                        poolTotal, demandaDiaria, capacidadDiaria, utilizacionPct, segPorDocFlota,
                        docsPorMinFlota: Math.round(procesosFlota * 60 / segPorDocFlota * 10) / 10,
                        alertas: alertasFlota,
                    },
                    fueros,
                    umbralesAlerta: ALERTAS,
                },
            });
        } catch (error) {
            logger.error(`[tandas] getCapacity: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },
};

module.exports = tandasController;
