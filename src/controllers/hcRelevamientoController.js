/**
 * Controller del relevamiento del haber de caja (pjn-liquidacion-worker/scripts/hc-relevamiento.js).
 *
 * El evaluador corre cada hora en worker_02 y deja un documento por PRPA en `previsional-hc-evaluaciones` y uno por
 * pasada en `previsional-hc-resumen`. Las constancias de primeros pagos cuyo resultado depende de una mala lectura del
 * OCR quedan con `revision.requerida`; el revisor corrige o valida desde la admin y la corrección se guarda en
 * `previsional-hc-revisiones` (un documento por PRPA, que las pasadas no pisan). La próxima pasada la aplica.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const AWS = require('aws-sdk');
const { CausasSegSoc } = require('pjn-models');
const { logger } = require('../config/pino');

const suelto = (nombre, coleccion) =>
  mongoose.models[nombre] || mongoose.model(nombre, new mongoose.Schema({}, { strict: false, collection: coleccion }));
const Evaluacion = suelto('HcEvaluacion', 'previsional-hc-evaluaciones');
const Resumen = suelto('HcResumen', 'previsional-hc-resumen');
const Prpa = suelto('PrevisionalPrpa', 'previsional-prpa');
const Revision = mongoose.models.HcRevision || mongoose.model('HcRevision', new mongoose.Schema({ _id: mongoose.Schema.Types.ObjectId }, { strict: false, collection: 'previsional-hc-revisiones', _id: false }));

const Carga = suelto('PrpaCarga', 'previsional-prpa-cargas');

// PRPA original subido por un revisor: el archivo (con datos personales) va a un bucket privado y cifrado; el worker
// (pjn-liquidacion-worker/scripts/procesar-cargas-prpa.js) lo procesa y genera un PRPA de origen 'carga_manual'.
const TIPOS_CARGA = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const MAX_CARGA = 30 * 1024 * 1024;
let _s3 = null;
function s3() {
  if (_s3) return _s3;
  if (!process.env.PRPA_S3_ACCESS_KEY_ID || !process.env.PRPA_S3_SECRET_ACCESS_KEY) return null;
  _s3 = new AWS.S3({ region: process.env.PRPA_S3_REGION || 'sa-east-1', accessKeyId: process.env.PRPA_S3_ACCESS_KEY_ID, secretAccessKey: process.env.PRPA_S3_SECRET_ACCESS_KEY });
  return _s3;
}
const BUCKET = () => process.env.PRPA_S3_BUCKET || 'lawanalytics-prpa-originales';
const PROY_CARGA = { s3: 0 };

const ESTADOS_REVISION = ['corregida', 'validada', 'descartada'];
const MOTIVOS = ['fad_no_leida', 'fecha_invalida', 'fecha_corregida', 'sin_tiempos', 'tiempos_inconsistentes', 'filas_ocr', 'categorias_ocr', 'moratoria_no_capturada', 'calidad_ocr'];

const PROY_LISTA = {
  fuente: 1, fadMes: 1, estado: 1, estadoReferencia: 1, pension: 1, moratoria: 1, calidadOk: 1, causaYear: 1,
  componentes: 1, desvios: 1, causas: 1, revision: 1, impresos: 1, recalculos: 1, evaluadoEn: 1, versionHub: 1
};

const esFecha = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const esMes = (v) => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const amd = (t) => {
  if (!t || typeof t !== 'object') return null;
  const o = { a: Number(t.a) || 0, m: Number(t.m) || 0, d: Number(t.d) || 0 };
  if ([o.a, o.m, o.d].some((x) => x < 0 || x > 99)) throw new Error('tiempo fuera de rango');
  return o;
};

/** Valida y normaliza las correcciones del revisor. Lanza Error con el motivo si algo no cierra. */
function normalizarCorrecciones(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (c.fechas) {
    out.fechas = {};
    for (const k of ['fad', 'cese', 'solicitud', 'alta', 'acuerdo']) {
      const v = c.fechas[k];
      if (v === undefined || v === null || v === '') continue;
      if (!esFecha(v)) throw new Error(`fecha ${k} inválida (AAAA-MM-DD)`);
      out.fechas[k] = v;
    }
  }
  if (c.impresos) {
    out.impresos = {};
    for (const k of ['W', 'R', 'sumatoriaDep', 'PBU', 'PC', 'PAP']) {
      const v = num(c.impresos[k]);
      if (v === null) continue;
      if (!Number.isFinite(v) || v < 0) throw new Error(`importe ${k} inválido`);
      out.impresos[k] = v;
    }
  }
  if (c.periodoDep && (c.periodoDep.desde || c.periodoDep.hasta)) {
    if (!esMes(c.periodoDep.desde) || !esMes(c.periodoDep.hasta)) throw new Error('período del promedio inválido (AAAA-MM)');
    out.periodoDep = { desde: c.periodoDep.desde, hasta: c.periodoDep.hasta };
  }
  if (c.tiempos) {
    const t = {};
    for (const tr of ['antes', 'despues']) {
      t[tr] = {};
      for (const k of ['dep', 'aut', 'sim']) t[tr][k] = amd(c.tiempos[tr] && c.tiempos[tr][k]) || { a: 0, m: 0, d: 0 };
    }
    t.total = amd(c.tiempos.total);
    out.tiempos = t;
  }
  if (Array.isArray(c.filas) && c.filas.length) {
    if (c.filas.length > 600) throw new Error('demasiadas filas (máximo 600)');
    out.filas = c.filas.map((f, i) => {
      if (!esMes(f.periodo)) throw new Error(`fila ${i + 1}: período inválido (AAAA-MM)`);
      const importe = num(f.importe);
      if (!Number.isFinite(importe) || importe <= 0) throw new Error(`fila ${i + 1}: importe inválido`);
      const meses = num(f.meses);
      return { periodo: f.periodo, importe, moneda: f.moneda ? String(f.moneda).slice(0, 12) : 'auto', hasta: f.hasta && esMes(f.hasta) ? f.hasta : undefined, meses: meses > 1 ? meses : undefined };
    });
  }
  if (typeof c.moratoria === 'boolean') out.moratoria = c.moratoria;
  return out;
}

module.exports = {
  /**
   * GET /api/hc-relevamiento/resumen?historial=48
   * Última pasada, historial de pasadas y estado vivo de las constancias (estados y revisión manual).
   */
  async getResumen(req, res) {
    try {
      const n = Math.min(500, Math.max(1, parseInt(req.query.historial || '48', 10)));
      const [pasadas, porEstado, porMotivo, porEstadoRevision, requerida, revisadas] = await Promise.all([
        Resumen.find({}, { abiertos: 0 }).sort({ _id: -1 }).limit(n).lean(),
        Evaluacion.aggregate([{ $group: { _id: { f: '$fuente', e: '$estado' }, n: { $sum: 1 } } }]),
        Evaluacion.aggregate([{ $match: { 'revision.requerida': true } }, { $unwind: '$revision.motivos' }, { $group: { _id: '$revision.motivos', n: { $sum: 1 } } }]),
        Evaluacion.aggregate([{ $match: { fuente: 'detalleBeneficio', 'revision.estado': { $ne: null } } }, { $group: { _id: '$revision.estado', n: { $sum: 1 } } }]),
        Evaluacion.countDocuments({ 'revision.requerida': true }),
        Revision.countDocuments({})
      ]);
      const estados = {};
      for (const g of porEstado) estados[`${g._id.f}:${g._id.e}`] = g.n;
      const motivos = Object.fromEntries(porMotivo.map((g) => [g._id, g.n]));
      const estadosRevision = Object.fromEntries(porEstadoRevision.filter((g) => g._id).map((g) => [g._id, g.n]));
      const ultima = pasadas[0] || null;
      res.json({
        success: true,
        data: {
          ultima,
          historial: pasadas.map((p) => ({ _id: p._id, evaluados: p.evaluados, nuevos: p.nuevos, totalPrpa: p.totalPrpa, porEstado: p.porEstado, revision: p.revision, segundos: p.segundos, versionHub: p.versionHub, motorVersion: p.motorVersion })),
          estados,
          revision: { requerida, revisadas, porMotivo: motivos, porEstado: estadosRevision },
          reglas: (ultima && ultima.reglas) || []
        }
      });
    } catch (err) {
      logger.error(`hc-relevamiento getResumen: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo el resumen', error: err.message });
    }
  },

  /**
   * GET /api/hc-relevamiento/casos
   * Query: fuente (default detalleBeneficio; 'todas'), estado, revision (requerida|revisada|todas), motivo, regla,
   *        componente + componenteEstado, page, limit (max 200).
   */
  async listCasos(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const filter = {};
      const fuente = req.query.fuente || 'detalleBeneficio';
      if (fuente !== 'todas') filter.fuente = fuente;
      if (req.query.estado) filter.estado = String(req.query.estado);
      if (req.query.revision === 'requerida') filter['revision.requerida'] = true;
      if (req.query.revision === 'revisada') filter['revision.estado'] = { $in: ESTADOS_REVISION };
      if (req.query.motivo && MOTIVOS.includes(req.query.motivo)) filter['revision.motivos'] = req.query.motivo;
      if (req.query.regla) filter['desvios.regla'] = String(req.query.regla);
      if (req.query.componente && /^(W|sumatoria|R|PBU|PC|PAP)$/.test(req.query.componente)) {
        filter[`componentes.${req.query.componente}.estado`] = req.query.componenteEstado ? String(req.query.componenteEstado) : { $exists: true };
      }
      const [docs, total] = await Promise.all([
        Evaluacion.find(filter, PROY_LISTA).sort({ fadMes: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Evaluacion.countDocuments(filter)
      ]);
      res.json({ success: true, data: { docs, total, page, limit, pages: Math.ceil(total / limit) } });
    } catch (err) {
      logger.error(`hc-relevamiento listCasos: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error listando casos', error: err.message });
    }
  },

  /**
   * GET /api/hc-relevamiento/casos/:id
   * Evaluación + lo leído de la constancia (fechas, impresos, tiempos, filas, controles) + revisión guardada.
   */
  async getCaso(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'id inválido' });
      const _id = new mongoose.Types.ObjectId(id);
      const [evaluacion, prpa, revision] = await Promise.all([
        Evaluacion.findById(_id).lean(),
        Prpa.findById(_id, {
          fuente: 1, fechas: 1, impresos: 1, tiempos: 1, prpa: 1, prpaMeses: 1, calidad: 1, categoriasAutonomo: 1, moratoria: 1,
          tipoPrestacion: 1, url: 1, causaId: 1, causaNumber: 1, causaYear: 1, fuero: 1, movFecha: 1, extraidoEn: 1, hojaIdx: 1,
          movOrigen: 1, reemplazadoPor: 1, reemplazadoEn: 1, cargaId: 1,
          'ocr.paginas': 1, 'hoja.moratoria': 1, 'hoja.tipoPrestacion': 1
        }).lean(),
        Revision.findById(_id).lean()
      ]);
      if (!evaluacion && !prpa) return res.status(404).json({ success: false, message: 'caso no encontrado' });
      const cargas = await Carga.find({ $or: [{ prpaId: _id }, { prpaIds: _id }] }, PROY_CARGA).sort({ subidoEn: -1 }).limit(20).lean();
      if (prpa && prpa.ocr && Array.isArray(prpa.ocr.paginas)) prpa.ocr = { paginas: prpa.ocr.paginas.length };
      const reemplazo = prpa && prpa.reemplazadoPor ? String(prpa.reemplazadoPor) : null;
      res.json({ success: true, data: { evaluacion, prpa, revision, cargas, reemplazo } });
    } catch (err) {
      logger.error(`hc-relevamiento getCaso: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo el caso', error: err.message });
    }
  },

  /**
   * PUT /api/hc-relevamiento/casos/:id/revision
   * Body: { estado: 'corregida'|'validada'|'descartada'|'pendiente', correcciones?, nota? }
   * 'pendiente' deja sin efecto las correcciones (vuelve a lo leído por el OCR) y conserva el historial. La próxima
   * pasada del evaluador reevalúa el caso.
   */
  async putRevision(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'id inválido' });
      const _id = new mongoose.Types.ObjectId(id);
      const { estado, nota } = req.body || {};
      const existe = await Prpa.exists({ _id });
      if (!existe) return res.status(404).json({ success: false, message: 'PRPA no encontrado' });
      if (estado !== 'pendiente' && !ESTADOS_REVISION.includes(estado)) return res.status(400).json({ success: false, message: `estado inválido (${ESTADOS_REVISION.join(', ')} o pendiente)` });
      let correcciones = null;
      try {
        correcciones = estado === 'corregida' ? normalizarCorrecciones(req.body.correcciones) : null;
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
      if (estado === 'corregida' && (!correcciones || !Object.keys(correcciones).length)) {
        return res.status(400).json({ success: false, message: 'una revisión corregida necesita al menos una corrección' });
      }
      const ahora = new Date();
      const entrada = { estado, nota: nota ? String(nota).slice(0, 2000) : null, por: req.userId || null, en: ahora };
      const doc = await Revision.findOneAndUpdate(
        { _id },
        {
          $set: { estado, correcciones, nota: entrada.nota, revisadoPor: entrada.por, actualizadoEn: ahora },
          $setOnInsert: { creadoEn: ahora },
          $push: { historial: { $each: [entrada], $slice: -20 } }
        },
        { upsert: true, new: true, lean: true }
      );
      // reflejo inmediato en la evaluación (la próxima pasada la recalcula con las correcciones)
      await Evaluacion.updateOne({ _id }, { $set: { 'revision.estado': estado, 'revision.actualizadoEn': ahora, ...(['validada', 'descartada'].includes(estado) ? { 'revision.requerida': false } : {}) } });
      res.json({ success: true, data: doc });
    } catch (err) {
      logger.error(`hc-relevamiento putRevision: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error guardando la revisión', error: err.message });
    }
  },

  /**
   * GET /api/hc-relevamiento/desvios
   * Desvíos de ANSES frente a la norma (solo constancias), con casos de ejemplo, y abiertos por componente.
   */
  async getDesvios(req, res) {
    try {
      const [desvios, abiertos] = await Promise.all([
        Evaluacion.aggregate([
          { $match: { fuente: { $ne: 'sica' } } },
          { $unwind: '$desvios' },
          { $group: { _id: { regla: '$desvios.regla', valor: '$desvios.valor' }, casos: { $addToSet: '$_id' } } },
          { $project: { _id: 0, regla: '$_id.regla', valor: '$_id.valor', n: { $size: '$casos' }, casos: { $slice: ['$casos', 20] } } },
          { $sort: { n: -1 } }
        ]),
        Evaluacion.aggregate([
          { $match: { fuente: 'detalleBeneficio', estado: 'abierto' } },
          { $project: { c: { $objectToArray: '$componentes' }, requerida: '$revision.requerida' } },
          { $unwind: '$c' },
          { $match: { 'c.v.estado': 'abierto' } },
          { $group: { _id: { componente: '$c.k', ocr: { $ifNull: ['$requerida', false] } }, n: { $sum: 1 } } },
          { $project: { _id: 0, componente: '$_id.componente', conMotivoOcr: '$_id.ocr', n: 1 } },
          { $sort: { componente: 1 } }
        ])
      ]);
      res.json({ success: true, data: { desvios, abiertos } });
    } catch (err) {
      logger.error(`hc-relevamiento getDesvios: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo desvíos', error: err.message });
    }
  },

  /**
   * POST /api/hc-relevamiento/cargas?prpaId=…  |  ?causaNumber=…&causaYear=…  [&nota=…]
   * Cuerpo: el archivo crudo (Content-Type application/pdf, image/jpeg o image/png; máximo 30 MB).
   * Sube el PRPA original al bucket privado y deja la carga pendiente para el worker. Con `prpaId` el resultado
   * reemplaza a esa lectura; con número y año de causa (fuero CSS) crea un caso nuevo.
   */
  async crearCarga(req, res) {
    try {
      const cliente = s3();
      if (!cliente) return res.status(503).json({ success: false, message: 'Almacenamiento de PRPA no configurado (PRPA_S3_*)' });
      const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = TIPOS_CARGA[tipo];
      if (!ext) return res.status(415).json({ success: false, message: 'Formato no admitido: PDF, JPG o PNG' });
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ success: false, message: 'Archivo vacío' });
      if (buf.length > MAX_CARGA) return res.status(413).json({ success: false, message: 'El archivo supera los 30 MB' });

      const q = req.query || {};
      let destino = {};
      if (q.prpaId) {
        if (!mongoose.isValidObjectId(q.prpaId)) return res.status(400).json({ success: false, message: 'prpaId inválido' });
        const p = await Prpa.findById(q.prpaId, { causaId: 1, causaNumber: 1, causaYear: 1, fuero: 1, juzgado: 1, secretaria: 1 }).lean();
        if (!p) return res.status(404).json({ success: false, message: 'PRPA no encontrado' });
        destino = { prpaId: p._id, causaId: p.causaId || null, causaNumber: p.causaNumber ?? null, causaYear: p.causaYear ?? null, fuero: p.fuero || 'CSS', juzgado: p.juzgado ?? null, secretaria: p.secretaria ?? null };
      } else {
        const number = parseInt(q.causaNumber, 10); const year = parseInt(q.causaYear, 10);
        if (!(number > 0) || !(year > 1900 && year < 2100)) return res.status(400).json({ success: false, message: 'Indicá el caso (prpaId) o el número y año de la causa' });
        const causa = await CausasSegSoc.findOne({ number, year }, { number: 1, year: 1, fuero: 1, juzgado: 1, secretaria: 1 }).lean();
        if (!causa) return res.status(404).json({ success: false, message: `No encontramos la causa ${number}/${year} del fuero de Seguridad Social` });
        destino = { prpaId: null, causaId: causa._id, causaNumber: causa.number, causaYear: causa.year, fuero: causa.fuero || 'CSS', juzgado: causa.juzgado ?? null, secretaria: causa.secretaria ?? null };
      }

      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const repetida = await Carga.findOne({ sha256, prpaId: destino.prpaId, causaId: destino.causaId, estado: { $in: ['pendiente', 'procesando', 'procesada'] } }, PROY_CARGA).lean();
      if (repetida) return res.status(200).json({ success: true, data: repetida, duplicada: true });

      const _id = new mongoose.Types.ObjectId();
      const key = `cargas/${_id}.${ext}`;
      await cliente.putObject({ Bucket: BUCKET(), Key: key, Body: buf, ContentType: tipo, ServerSideEncryption: 'AES256' }).promise();
      const doc = {
        _id, estado: 'pendiente', ...destino, tipo, bytes: buf.length, sha256,
        s3: { bucket: BUCKET(), key }, nota: q.nota ? String(q.nota).slice(0, 500) : null,
        subidoPor: req.userId || null, subidoEn: new Date(), intentos: 0
      };
      await Carga.collection.insertOne(doc);
      const { s3: _omit, ...publica } = doc;
      res.status(201).json({ success: true, data: publica });
    } catch (err) {
      logger.error(`hc-relevamiento crearCarga: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error subiendo el PRPA', error: err.message });
    }
  },

  /** GET /api/hc-relevamiento/cargas?estado=&page=&limit= */
  async listCargas(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const filter = {};
      if (req.query.estado) filter.estado = String(req.query.estado);
      const [docs, total] = await Promise.all([
        Carga.find(filter, PROY_CARGA).sort({ subidoEn: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Carga.countDocuments(filter)
      ]);
      res.json({ success: true, data: { docs, total, page, limit, pages: Math.ceil(total / limit) } });
    } catch (err) {
      logger.error(`hc-relevamiento listCargas: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error listando cargas', error: err.message });
    }
  },

  /** GET /api/hc-relevamiento/cargas/:id */
  async getCarga(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'id inválido' });
      const doc = await Carga.findById(id, PROY_CARGA).lean();
      if (!doc) return res.status(404).json({ success: false, message: 'carga no encontrada' });
      res.json({ success: true, data: doc });
    } catch (err) {
      logger.error(`hc-relevamiento getCarga: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error obteniendo la carga', error: err.message });
    }
  },

  _normalizarCorrecciones: normalizarCorrecciones
};
