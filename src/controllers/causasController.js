const { CausasCivil, CausasComercial, CausasSegSoc, CausasTrabajo } = require("pjn-models")
const { logger} = require('../config/pino');
const axios = require('axios');

const getModel = (fuero) => {
  switch (fuero) {
    case 'CIV': return CausasCivil;
    case 'COM': return CausasComercial;
    case 'CSS': return CausasSegSoc;
    case 'CNT': return CausasTrabajo;
    default: throw new Error('Fuero no válido');
  }
};

const causasController = {
  // Buscar por número y año
  async findByNumberAndYear(req, res) {
    try {
      const { fuero, number, year } = req.params;
      const Model = getModel(fuero);

      const causa = await Model.findOne({ number, year });
      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          count: 0,
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Causa encontrada',
        count: 1,
        data: causa
      });
    } catch (error) {
      logger.error(`Error buscando causa: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: null
      });
    }
  },

  // Buscar por ID
  async findById(req, res) {
    try {
      const { fuero, id } = req.params;
      const Model = getModel(fuero);

      const causa = await Model.findById(id).lean();
      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          count: 0,
          data: null
        });
      }

      // Agregar el array de movimientos con el nombre esperado por el frontend
      // El campo en la BD es "movimiento" pero el frontend espera "movimientos"
      if (causa.movimiento && Array.isArray(causa.movimiento)) {
        causa.movimientos = causa.movimiento;
      }

      res.json({
        success: true,
        message: 'Causa encontrada',
        count: 1,
        data: causa
      });
    } catch (error) {
      logger.error(`Error buscando causa por ID: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: null
      });
    }
  },

  // Buscar por objeto
  async findByObjeto(req, res) {
    try {
      const { fuero } = req.params;
      const { objeto } = req.query;
      
      if (!objeto || typeof objeto !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'El parámetro objeto es requerido y debe ser un texto',
          count: 0,
          data: []
        });
      }
      
      const Model = getModel(fuero);

      const causas = await Model.find({
        objeto: { $regex: objeto, $options: 'i' }
      }).sort({ year: -1, number: -1 });

      res.json({
        success: true,
        message: `Se encontraron ${causas.length} causas con objeto similar a "${objeto}"`,
        count: causas.length,
        data: causas
      });
    } catch (error) {
      logger.error(`Error buscando por objeto: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Listar objetos únicos
  async listObjetos(req, res) {
    try {
      const { fuero } = req.params;
      const Model = getModel(fuero);

      const objetos = await Model.distinct('objeto', {
        objeto: { $ne: null }
      });

      res.json({
        success: true,
        message: `Se encontraron ${objetos.length} objetos únicos`,
        count: objetos.length,
        data: objetos
      });
    } catch (error) {
      logger.error(`Error listando objetos: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Búsqueda avanzada
  async searchAdvanced(req, res) {
    try {
      const { fuero } = req.params;
      const { year, caratula, juzgado, objeto } = req.query;
      const Model = getModel(fuero);

      let query = {};
      let criteria = [];

      if (year) {
        query.year = year;
        criteria.push(`año ${year}`);
      }
      if (juzgado) {
        query.juzgado = juzgado;
        criteria.push(`juzgado ${juzgado}`);
      }
      if (caratula) {
        query.caratula = { $regex: caratula, $options: 'i' };
        criteria.push(`carátula que contiene "${caratula}"`);
      }
      if (objeto && typeof objeto === 'string') {
        query.objeto = { $regex: objeto, $options: 'i' };
        criteria.push(`objeto similar a "${objeto}"`);
      }

      const causas = await Model.find(query)
        .sort({ year: -1, number: -1 })
        .limit(100);

      const criteriaText = criteria.length > 0 ? 
        `Búsqueda por: ${criteria.join(', ')}` : 
        'Búsqueda sin criterios específicos';

      res.json({
        success: true,
        message: `Se encontraron ${causas.length} causas. ${criteriaText}${causas.length === 100 ? ' (limitado a 100 resultados)' : ''}`,
        count: causas.length,
        criteria: criteria,
        limitApplied: causas.length === 100,
        data: causas
      });
    } catch (error) {
      logger.error(`Error en búsqueda avanzada: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  async addCausa(req, res) {
    try {
      const { fuero } = req.params;
      const { number, year, userId, ...causeData } = req.body;
      // Validar datos requeridos
      if (!number || !year) {
        return res.status(400).json({
          success: false,
          message: 'Número y año son campos obligatorios'
        });
      }

      // Usar la función getModel existente
      let Model;
      try {
        Model = getModel(fuero.toUpperCase());
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: 'Fuero no válido. Debe ser CIV, CSS o CNT'
        });
      }

      // Verificar si ya existe una causa con el mismo número y año
      const existingCause = await Model.findOne({
        number: number.toString(),
        year: year.toString()
      });

      if (existingCause) {
        // Si la causa existe y se proporcionó un userId, agregarlo al array
        if (userId) {
          // Verificar si el userId ya existe en el array para evitar duplicados
          if (!existingCause.userCausaIds || !existingCause.userCausaIds.includes(userId)) {
            // Si el array no existe, crearlo
            if (!existingCause.userCausaIds) {
              existingCause.userCausaIds = [];
            }

            // Agregar el nuevo userId al array
            existingCause.userCausaIds.push(userId);
            await existingCause.save();

            return res.status(200).json({
              success: true,
              message: 'Usuario agregado a la causa existente',
              data: existingCause
            });
          } else {
            return res.status(200).json({
              success: true,
              message: 'El usuario ya está asociado a esta causa',
              data: existingCause
            });
          }
        } else {
          // Si no se proporcionó userId, simplemente informar que la causa existe
          return res.status(200).json({
            success: true,
            message: 'Causa existente recuperada',
            data: existingCause
          });
        }
      }

      // Si no existe, crear una nueva causa
      const newCause = new Model({
        number: number.toString(),
        year: year.toString(),
        fuero: fuero.toUpperCase(),
        userCausaIds: userId ? [userId] : [],  // Inicializar el array con el userId si existe
        ...causeData,
        date: new Date()
      });
      // Guardar en la base de datos
      await newCause.save();

      res.status(201).json({
        success: true,
        message: 'Causa agregada correctamente',
        data: newCause
      });

    } catch (error) {
      logger.error(`Error al agregar causa: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error al agregar la causa',
        error: error.message
      });
    }
  },

  // Obtener todas las causas verificadas de los tres modelos
  async getAllVerifiedCausas(req, res) {
    try {
      // Obtener parámetros de paginación
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      // Filtro por fuero si se especifica
      const fuero = req.query.fuero ? req.query.fuero.toUpperCase() : null;

      // Filtros de búsqueda adicionales
      const searchFilters = { verified: true, isValid: true };

      if (req.query.number) {
        searchFilters.number = parseInt(req.query.number);
      }

      if (req.query.year) {
        searchFilters.year = parseInt(req.query.year);
      }

      if (req.query.objeto) {
        searchFilters.objeto = { $regex: req.query.objeto, $options: 'i' };
      }

      if (req.query.caratula) {
        searchFilters.caratula = { $regex: req.query.caratula, $options: 'i' };
      }

      // Filtro por fechaUltimoMovimiento
      if (req.query.fechaUltimoMovimiento) {
        try {
          const fechaBusqueda = new Date(req.query.fechaUltimoMovimiento);
          // Buscar fechas que coincidan en día, mes y año (UTC)
          const fechaInicio = new Date(Date.UTC(fechaBusqueda.getUTCFullYear(), fechaBusqueda.getUTCMonth(), fechaBusqueda.getUTCDate(), 0, 0, 0, 0));
          const fechaFin = new Date(Date.UTC(fechaBusqueda.getUTCFullYear(), fechaBusqueda.getUTCMonth(), fechaBusqueda.getUTCDate(), 23, 59, 59, 999));
          searchFilters.fechaUltimoMovimiento = { $gte: fechaInicio, $lte: fechaFin };
          logger.info(`Filtro por fechaUltimoMovimiento: ${fechaInicio.toISOString()} - ${fechaFin.toISOString()}`);
        } catch (error) {
          logger.error(`Error parseando fechaUltimoMovimiento: ${error.message}`);
        }
      }

      // Filtro por lastUpdate
      if (req.query.lastUpdate) {
        try {
          const fechaBusqueda = new Date(req.query.lastUpdate);
          // Buscar fechas que coincidan en día, mes y año (UTC)
          const fechaInicio = new Date(Date.UTC(fechaBusqueda.getUTCFullYear(), fechaBusqueda.getUTCMonth(), fechaBusqueda.getUTCDate(), 0, 0, 0, 0));
          const fechaFin = new Date(Date.UTC(fechaBusqueda.getUTCFullYear(), fechaBusqueda.getUTCMonth(), fechaBusqueda.getUTCDate(), 23, 59, 59, 999));
          searchFilters.lastUpdate = { $gte: fechaInicio, $lte: fechaFin };
          logger.info(`Filtro por lastUpdate: ${fechaInicio.toISOString()} - ${fechaFin.toISOString()}`);
        } catch (error) {
          logger.error(`Error parseando lastUpdate: ${error.message}`);
        }
      }

      // Filtro por update (actualizable)
      if (req.query.update !== undefined) {
        searchFilters.update = req.query.update === 'true';
        logger.info(`Filtro por update: ${searchFilters.update}`);
      }

      // Filtro por isPrivate (privada)
      if (req.query.isPrivate !== undefined) {
        if (req.query.isPrivate === 'null') {
          searchFilters.isPrivate = null;
        } else {
          searchFilters.isPrivate = req.query.isPrivate === 'true';
        }
        logger.info(`Filtro por isPrivate: ${searchFilters.isPrivate}`);
      }

      // Filtro soloElegibles: aplica los criterios completos del worker
      if (req.query.soloElegibles === 'true') {
        // Criterios que coinciden EXACTAMENTE con el worker de actualización
        searchFilters.source = { $in: ["app", "cache", "pjn-login"] };
        searchFilters.update = true;
        searchFilters.isPrivate = { $ne: true };
        searchFilters.movimientosCount = { $gt: 0 };
        searchFilters['movimiento.0'] = { $exists: true };
        logger.info(`Filtro soloElegibles: aplicando criterios completos del worker`);
      }

      // Filtro por estadoActualizacion (actualizados/pendientes/errores)
      if (req.query.estadoActualizacion && req.query.estadoActualizacion !== 'todos') {
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0]; // "2026-02-01"

        switch (req.query.estadoActualizacion) {
          case 'actualizados':
            // Actualizados hoy: updateStats.today.date === today
            searchFilters['updateStats.today.date'] = todayStr;
            searchFilters['updateStats.today.count'] = { $gt: 0 };
            logger.info(`Filtro estadoActualizacion: actualizados hoy (${todayStr})`);
            break;
          case 'pendientes':
            // Pendientes: NO actualizados hoy Y sin cooldown activo
            searchFilters.$and = searchFilters.$and || [];
            searchFilters.$and.push({
              $or: [
                { 'updateStats.today.date': { $ne: todayStr } },
                { 'updateStats.today.date': { $exists: false } },
                { 'updateStats.today': { $exists: false } }
              ]
            });
            // Excluir los que están en cooldown
            searchFilters.$and.push({
              $or: [
                { 'scrapingProgress.skipUntil': { $exists: false } },
                { 'scrapingProgress.skipUntil': null },
                { 'scrapingProgress.skipUntil': { $lte: now } }
              ]
            });
            logger.info(`Filtro estadoActualizacion: pendientes (no actualizados hoy y sin cooldown)`);
            break;
          case 'errores':
            // Con errores/cooldown: scrapingProgress.skipUntil > now
            searchFilters['scrapingProgress.skipUntil'] = { $gt: now };
            logger.info(`Filtro estadoActualizacion: errores (en cooldown)`);
            break;
        }
      }

      // Parámetros de ordenamiento
      const sortBy = req.query.sortBy || 'year'; // Campo por el cual ordenar
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1; // Orden ascendente o descendente

      // Log para depuración
      logger.info(`Ordenamiento recibido - sortBy: ${req.query.sortBy}, sortOrder: ${req.query.sortOrder}`);

      // Construir objeto de sort para MongoDB
      const sortOptions = {};

      // Mapeo de campos permitidos para ordenar
      const allowedSortFields = ['number', 'year', 'caratula', 'juzgado', 'objeto', 'movimientosCount', 'lastUpdate', 'fechaUltimoMovimiento'];

      if (allowedSortFields.includes(sortBy)) {
        sortOptions[sortBy] = sortOrder;
        // Agregar ordenamiento secundario por year y number si no son el campo principal
        if (sortBy !== 'year') {
          sortOptions['year'] = -1;
        }
        if (sortBy !== 'number') {
          sortOptions['number'] = -1;
        }
      } else {
        // Ordenamiento por defecto
        sortOptions.year = -1;
        sortOptions.number = -1;
      }

      // Filtros base sin búsqueda para obtener total general de la base de datos
      const baseFilters = { verified: true, isValid: true };

      // Obtener conteos totales en paralelo: con filtros aplicados y total de la base de datos
      const [totalCivil, totalComercial, totalSegSoc, totalTrabajo, totalCivilDB, totalComercialDB, totalSegSocDB, totalTrabajoDB] = await Promise.all([
        // Conteos con filtros de búsqueda aplicados
        fuero && fuero !== 'CIV' ? 0 : CausasCivil.countDocuments(searchFilters),
        fuero && fuero !== 'COM' ? 0 : CausasComercial.countDocuments(searchFilters),
        fuero && fuero !== 'CSS' ? 0 : CausasSegSoc.countDocuments(searchFilters),
        fuero && fuero !== 'CNT' ? 0 : CausasTrabajo.countDocuments(searchFilters),
        // Conteos totales de la base de datos (sin filtros de búsqueda)
        fuero && fuero !== 'CIV' ? 0 : CausasCivil.countDocuments(baseFilters),
        fuero && fuero !== 'COM' ? 0 : CausasComercial.countDocuments(baseFilters),
        fuero && fuero !== 'CSS' ? 0 : CausasSegSoc.countDocuments(baseFilters),
        fuero && fuero !== 'CNT' ? 0 : CausasTrabajo.countDocuments(baseFilters)
      ]);

      const totalCausasReal = totalCivil + totalComercial + totalSegSoc + totalTrabajo;
      const totalInDatabase = totalCivilDB + totalComercialDB + totalSegSocDB + totalTrabajoDB;
      const totalPages = Math.ceil(totalCausasReal / limit);

      // Estrategia híbrida: traer suficientes documentos de cada colección
      // para cubrir la página actual más un buffer, ordenar en memoria,
      // y luego aplicar paginación exacta
      let causasPaginadas = [];

      // Calcular cuántos documentos necesitamos traer de cada colección
      // Traemos desde el inicio hasta skip + limit para asegurar que tenemos
      // suficientes documentos después del ordenamiento global
      const maxDocsToFetch = skip + limit;

      // Consultar documentos con ordenamiento de MongoDB y límite razonable
      const [causasCivil, causasComercial, causasSegSoc, causasTrabajo] = await Promise.all([
        fuero && fuero !== 'CIV' ? [] : CausasCivil.find(searchFilters)
          .sort(sortOptions)
          .limit(maxDocsToFetch)
          .lean(),
        fuero && fuero !== 'COM' ? [] : CausasComercial.find(searchFilters)
          .sort(sortOptions)
          .limit(maxDocsToFetch)
          .lean(),
        fuero && fuero !== 'CSS' ? [] : CausasSegSoc.find(searchFilters)
          .sort(sortOptions)
          .limit(maxDocsToFetch)
          .lean(),
        fuero && fuero !== 'CNT' ? [] : CausasTrabajo.find(searchFilters)
          .sort(sortOptions)
          .limit(maxDocsToFetch)
          .lean()
      ]);

      // Combinar y agregar fuero
      const allCausas = [
        ...causasCivil.map(causa => ({ ...causa, fuero: 'CIV' })),
        ...causasComercial.map(causa => ({ ...causa, fuero: 'COM' })),
        ...causasSegSoc.map(causa => ({ ...causa, fuero: 'CSS' })),
        ...causasTrabajo.map(causa => ({ ...causa, fuero: 'CNT' }))
      ];

      // Ordenar los documentos combinados usando el mismo criterio de sortOptions
      allCausas.sort((a, b) => {
        // Aplicar ordenamiento dinámico basado en sortBy
        let fieldA = a[sortBy];
        let fieldB = b[sortBy];

        // Manejar valores undefined/null (colocarlos al final)
        const aIsNull = fieldA === null || fieldA === undefined;
        const bIsNull = fieldB === null || fieldB === undefined;

        if (aIsNull && bIsNull) return 0;
        if (aIsNull) return 1; // A va al final
        if (bIsNull) return -1; // B va al final

        // Manejo especial para strings (case-insensitive)
        if (typeof fieldA === 'string' && typeof fieldB === 'string') {
          const comparison = fieldA.toLowerCase().localeCompare(fieldB.toLowerCase());
          if (comparison !== 0) return comparison * sortOrder;
        } else if (fieldA !== fieldB) {
          // Para números y otros tipos
          if (fieldA < fieldB) return -1 * sortOrder;
          if (fieldA > fieldB) return 1 * sortOrder;
        }

        // Ordenamiento secundario por year si no es el campo principal
        if (sortBy !== 'year' && a.year !== b.year) {
          return b.year - a.year;
        }

        // Ordenamiento terciario por number si no es el campo principal
        if (sortBy !== 'number' && a.number !== b.number) {
          return b.number - a.number;
        }

        return 0;
      });

      // Aplicar paginación en memoria: skip y limit
      causasPaginadas = allCausas.slice(skip, skip + limit);

      res.json({
        success: true,
        message: `Mostrando ${causasPaginadas.length} de ${totalCausasReal} causas verificadas y válidas${fuero ? ` del fuero ${fuero}` : ''}`,
        count: totalCausasReal,
        totalInDatabase: totalInDatabase,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          limit: limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        breakdown: {
          civil: totalCivil,
          seguridad_social: totalSegSoc,
          trabajo: totalTrabajo
        },
        filters: {
          fuero: fuero || 'todos'
        },
        data: causasPaginadas
      });
    } catch (error) {
      logger.error(`Error obteniendo causas verificadas: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Obtener todas las causas no verificadas (verified: true, isValid: false)
  async getAllNonVerifiedCausas(req, res) {
    try {
      // Obtener parámetros de paginación
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      // Filtro por fuero si se especifica
      const fuero = req.query.fuero ? req.query.fuero.toUpperCase() : null;

      // Filtros de búsqueda adicionales - verified: true, isValid: false
      const searchFilters = { verified: true, isValid: false };

      if (req.query.number) {
        searchFilters.number = parseInt(req.query.number);
      }

      if (req.query.year) {
        searchFilters.year = parseInt(req.query.year);
      }

      if (req.query.objeto) {
        searchFilters.objeto = { $regex: req.query.objeto, $options: 'i' };
      }

      if (req.query.caratula) {
        searchFilters.caratula = { $regex: req.query.caratula, $options: 'i' };
      }

      // Parámetros de ordenamiento
      const sortBy = req.query.sortBy || 'year';
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

      logger.info(`Ordenamiento recibido - sortBy: ${req.query.sortBy}, sortOrder: ${req.query.sortOrder}`);

      // Construir objeto de sort para MongoDB
      const sortOptions = {};

      // Mapeo de campos permitidos para ordenar
      const allowedSortFields = ['number', 'year', 'caratula', 'juzgado', 'objeto', 'movimientosCount', 'lastUpdate', 'fechaUltimoMovimiento'];

      if (allowedSortFields.includes(sortBy)) {
        sortOptions[sortBy] = sortOrder;
        // Agregar ordenamiento secundario por year y number si no son el campo principal
        if (sortBy !== 'year') {
          sortOptions['year'] = -1;
        }
        if (sortBy !== 'number') {
          sortOptions['number'] = -1;
        }
      } else {
        // Ordenamiento por defecto
        sortOptions.year = -1;
        sortOptions.number = -1;
      }

      // Filtros base sin búsqueda para obtener total general de la base de datos
      const baseFilters = { verified: true, isValid: true };

      // Obtener conteos totales en paralelo: con filtros aplicados y total de la base de datos
      const [totalCivil, totalComercial, totalSegSoc, totalTrabajo, totalCivilDB, totalComercialDB, totalSegSocDB, totalTrabajoDB] = await Promise.all([
        // Conteos con filtros de búsqueda aplicados
        fuero && fuero !== 'CIV' ? 0 : CausasCivil.countDocuments(searchFilters),
        fuero && fuero !== 'COM' ? 0 : CausasComercial.countDocuments(searchFilters),
        fuero && fuero !== 'CSS' ? 0 : CausasSegSoc.countDocuments(searchFilters),
        fuero && fuero !== 'CNT' ? 0 : CausasTrabajo.countDocuments(searchFilters),
        // Conteos totales de la base de datos (sin filtros de búsqueda)
        fuero && fuero !== 'CIV' ? 0 : CausasCivil.countDocuments(baseFilters),
        fuero && fuero !== 'COM' ? 0 : CausasComercial.countDocuments(baseFilters),
        fuero && fuero !== 'CSS' ? 0 : CausasSegSoc.countDocuments(baseFilters),
        fuero && fuero !== 'CNT' ? 0 : CausasTrabajo.countDocuments(baseFilters)
      ]);

      const totalCausasReal = totalCivil + totalComercial + totalSegSoc + totalTrabajo;
      const totalInDatabase = totalCivilDB + totalComercialDB + totalSegSocDB + totalTrabajoDB;
      const totalPages = Math.ceil(totalCausasReal / limit);

      logger.info(`Conteo total real de causas no verificadas: ${totalCausasReal} (Civil: ${totalCivil}, Comercial: ${totalComercial}, SegSoc: ${totalSegSoc}, Trabajo: ${totalTrabajo})`);

      // Realizar búsquedas en paralelo en las colecciones necesarias
      const promises = [];

      if (!fuero || fuero === 'CIV') {
        promises.push(CausasCivil.find(searchFilters).sort(sortOptions).lean());
      }
      if (!fuero || fuero === 'COM') {
        promises.push(CausasComercial.find(searchFilters).sort(sortOptions).lean());
      }
      if (!fuero || fuero === 'CSS') {
        promises.push(CausasSegSoc.find(searchFilters).sort(sortOptions).lean());
      }
      if (!fuero || fuero === 'CNT') {
        promises.push(CausasTrabajo.find(searchFilters).sort(sortOptions).lean());
      }

      const results = await Promise.all(promises);

      // Combinar todos los resultados y agregar el campo fuero
      let allCausas = [];
      let fueroIndex = 0;
      const fueros = !fuero ? ['CIV', 'COM', 'CSS', 'CNT'] : [fuero];

      results.forEach((causasArray, index) => {
        const currentFuero = fueros[fueroIndex];
        const causasWithFuero = causasArray.map(causa => ({
          ...causa,
          fuero: currentFuero
        }));
        allCausas = allCausas.concat(causasWithFuero);
        fueroIndex++;
      });

      // Aplicar ordenamiento global si estamos consultando múltiples fueros
      if (!fuero) {
        allCausas.sort((a, b) => {
          for (const key in sortOptions) {
            const order = sortOptions[key];
            if (a[key] !== b[key]) {
              if (a[key] < b[key]) return -order;
              if (a[key] > b[key]) return order;
            }
          }
          return 0;
        });
      }

      // Aplicar paginación manualmente después de combinar
      let causasPaginadas;
      causasPaginadas = allCausas.slice(skip, skip + limit);

      res.json({
        success: true,
        message: `Mostrando ${causasPaginadas.length} de ${totalCausasReal} causas no verificadas${fuero ? ` del fuero ${fuero}` : ''}`,
        count: totalCausasReal,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          limit: limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        breakdown: {
          civil: totalCivil,
          comercial: totalComercial,
          seguridad_social: totalSegSoc,
          trabajo: totalTrabajo
        },
        filters: {
          fuero: fuero || 'todos'
        },
        data: causasPaginadas
      });
    } catch (error) {
      logger.error(`Error obteniendo causas no verificadas: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Obtener movimientos de una causa por ID con paginación
  async getMovimientosByDocumentId(req, res) {
    try {
      const { fuero, id } = req.params;
      // Obtener parámetros de paginación con valores por defecto
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20; // 20 movimientos por página por defecto
      const skip = (page - 1) * limit;

      const Model = getModel(fuero);

      // Buscar el documento por ID
      const causa = await Model.findById(id).select('number year caratula movimiento movimientosCount userUpdatesEnabled folderIds userCausaIds');
      
      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          count: 0,
          data: null
        });
      }

      // Extraer los movimientos y ordenarlos por fecha descendente
      const movimientos = causa.movimiento || [];
      const movimientosOrdenados = movimientos.sort((a, b) => {
        return new Date(b.fecha) - new Date(a.fecha);
      });

      // Aplicar paginación
      const totalMovimientos = movimientosOrdenados.length;
      const totalPages = Math.ceil(totalMovimientos / limit);
      const movimientosPaginados = movimientosOrdenados.slice(skip, skip + limit);

      res.json({
        success: true,
        message: `Mostrando ${movimientosPaginados.length} de ${totalMovimientos} movimientos`,
        count: totalMovimientos,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          limit: limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        causa: {
          id: causa._id,
          number: causa.number,
          year: causa.year,
          caratula: causa.caratula,
          movimientosCount: causa.movimientosCount,
          userUpdatesEnabled: causa.userUpdatesEnabled || [],
          folderIds: causa.folderIds || [],
          userCausaIds: causa.userCausaIds || []
        },
        data: movimientosPaginados
      });
    } catch (error) {
      logger.error(`Error obteniendo movimientos: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Eliminar una causa por ID
  async deleteCausaById(req, res) {
    try {
      const { fuero, id } = req.params;
      const Model = getModel(fuero);

      // Buscar y eliminar el documento
      const causaEliminada = await Model.findByIdAndDelete(id);
      
      if (!causaEliminada) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Causa eliminada correctamente',
        data: {
          id: causaEliminada._id,
          number: causaEliminada.number,
          year: causaEliminada.year,
          caratula: causaEliminada.caratula,
          fuero: fuero
        }
      });
    } catch (error) {
      logger.error(`Error eliminando causa: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Buscar causas con filtros
  async findByFilters(req, res) {
    try {
      const { fuero } = req.params;
      const { verified, isValid, update, source } = req.query;
      const Model = getModel(fuero);

      // Construir query dinámicamente
      let query = {};
      let criteria = [];

      // Agregar filtros solo si están presentes
      if (verified !== undefined) {
        query.verified = verified === 'true';
        criteria.push(`verified: ${verified}`);
      }

      if (isValid !== undefined) {
        query.isValid = isValid === 'true';
        criteria.push(`isValid: ${isValid}`);
      }

      if (update !== undefined) {
        query.update = update === 'true';
        criteria.push(`update: ${update}`);
      }

      if (source) {
        query.source = source;
        criteria.push(`source: ${source}`);
      }

      // Ejecutar búsqueda con proyección para obtener solo los campos necesarios
      const causas = await Model.find(query)
        .select('number year')
        .sort({ year: -1, number: -1 })
        .limit(100);

      // Mapear los resultados para incluir el fuero y solo los campos solicitados
      const causasFormateadas = causas.map(causa => ({
        fuero: fuero,
        number: causa.number,
        year: causa.year
      }));

      const criteriaText = criteria.length > 0 ? 
        `Filtros aplicados: ${criteria.join(', ')}` : 
        'Sin filtros aplicados';

      res.json({
        success: true,
        message: `Se encontraron ${causas.length} causas en ${fuero}. ${criteriaText}${causas.length === 100 ? ' (limitado a 100 resultados)' : ''}`,
        count: causas.length,
        filters: {
          fuero,
          verified: verified !== undefined ? verified === 'true' : undefined,
          isValid: isValid !== undefined ? isValid === 'true' : undefined,
          update: update !== undefined ? update === 'true' : undefined,
          source: source || undefined
        },
        limitApplied: causas.length === 100,
        data: causasFormateadas
      });
    } catch (error) {
      logger.error(`Error buscando causas con filtros: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Obtener causas con folderIds vinculadas por fuero
  async getCausasWithFolders(req, res) {
    try {
      const { fuero } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;
      const light = req.query.light === 'true';

      const Model = getModel(fuero);

      // Obtener total de causas con folderIds
      const totalCount = await Model.countDocuments({
        folderIds: { $exists: true, $ne: [], $not: { $size: 0 } }
      });

      // Obtener causas paginadas
      const query = Model.find({
        folderIds: { $exists: true, $ne: [], $not: { $size: 0 } }
      });

      // Si light=true, solo seleccionar campos específicos
      if (light) {
        query.select('number year caratula juzgado objeto verified isValid folderIds userCausaIds movimientosCount lastUpdate');
      }

      const causas = await query
        .sort({ year: -1, number: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const totalPages = Math.ceil(totalCount / limit);

      res.json({
        success: true,
        message: `Mostrando ${causas.length} de ${totalCount} causas con carpetas vinculadas en ${fuero}`,
        count: totalCount,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          limit: limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        fuero: fuero,
        data: causas
      });
    } catch (error) {
      logger.error(`Error obteniendo causas con folders: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: []
      });
    }
  },

  // Actualizar campos de una causa
  async updateCausa(req, res) {
    try {
      const { fuero, id } = req.params;
      const updateData = req.body;
      const Model = getModel(fuero);

      // Campos permitidos para actualizar
      const allowedFields = [
        'caratula', 'juzgado', 'objeto', 'lastUpdate', 'fechaUltimoMovimiento',
        'verified', 'isValid', 'update'
      ];

      // Filtrar solo campos permitidos
      const filteredUpdate = {};
      Object.keys(updateData).forEach(key => {
        if (allowedFields.includes(key)) {
          filteredUpdate[key] = updateData[key];
        }
      });

      if (Object.keys(filteredUpdate).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No hay campos válidos para actualizar',
          data: null
        });
      }

      // Buscar y actualizar el documento
      const causaActualizada = await Model.findByIdAndUpdate(
        id,
        { $set: filteredUpdate },
        { new: true, runValidators: true }
      ).lean();

      if (!causaActualizada) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Causa actualizada correctamente',
        data: causaActualizada
      });
    } catch (error) {
      logger.error(`Error actualizando causa: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Eliminar un movimiento específico de una causa
  async deleteMovimiento(req, res) {
    try {
      const { fuero, id, movimientoIndex } = req.params;
      const Model = getModel(fuero);

      // Convertir el índice a número
      const index = parseInt(movimientoIndex);
      if (isNaN(index) || index < 0) {
        return res.status(400).json({
          success: false,
          message: 'Índice de movimiento inválido',
          data: null
        });
      }

      // Buscar la causa
      const causa = await Model.findById(id);

      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      // Verificar que el array movimiento existe y tiene el índice
      if (!causa.movimiento || !Array.isArray(causa.movimiento)) {
        return res.status(404).json({
          success: false,
          message: 'Esta causa no tiene movimientos',
          data: null
        });
      }

      if (index >= causa.movimiento.length) {
        return res.status(404).json({
          success: false,
          message: 'Movimiento no encontrado en el índice especificado',
          data: null
        });
      }

      // Guardar el movimiento que se va a eliminar para devolverlo
      const movimientoEliminado = causa.movimiento[index];

      // Eliminar el movimiento del array
      causa.movimiento.splice(index, 1);

      // Actualizar el contador de movimientos
      if (causa.movimientosCount) {
        causa.movimientosCount = causa.movimiento.length;
      }

      // Agregar entrada al updateHistory
      const ahora = new Date();
      if (!causa.updateHistory || !Array.isArray(causa.updateHistory)) {
        causa.updateHistory = [];
      }

      causa.updateHistory.push({
        timestamp: ahora,
        source: 'manual',
        updateType: 'update',
        success: true,
        movimientosAdded: -1,
        movimientosTotal: causa.movimiento.length,
        details: {
          movimientoEliminado: {
            fecha: movimientoEliminado.fecha,
            tipo: movimientoEliminado.tipo
          }
        }
      });

      // Guardar los cambios
      await causa.save();

      res.json({
        success: true,
        message: 'Movimiento eliminado correctamente',
        data: {
          causaId: causa._id,
          movimientoEliminado,
          movimientosRestantes: causa.movimiento.length,
          updateHistory: causa.updateHistory || []
        }
      });
    } catch (error) {
      logger.error(`Error eliminando movimiento: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Función auxiliar para obtener usuarios con notificaciones habilitadas
  getEnabledUsers(causa) {
    const enabledUsers = [];

    // Verificar userUpdatesEnabled
    if (causa.userUpdatesEnabled && Array.isArray(causa.userUpdatesEnabled)) {
      for (const userUpdate of causa.userUpdatesEnabled) {
        if (userUpdate.enabled && userUpdate.userId) {
          enabledUsers.push(userUpdate.userId);
        }
      }
    }

    // Si no hay userUpdatesEnabled, usar userCausaIds como fallback
    if (enabledUsers.length === 0 && causa.userCausaIds && causa.userCausaIds.length > 0) {
      // Por defecto, asumir que todos los usuarios quieren notificaciones
      enabledUsers.push(...causa.userCausaIds);
    }

    return enabledUsers;
  },

  // Función auxiliar para enviar notificación de movimiento
  async sendMovementNotification(causa, movimiento) {
    const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notifications.lawanalytics.app';
    const serviceToken = process.env.INTERNAL_SERVICE_TOKEN;

    if (!serviceToken) {
      throw new Error('INTERNAL_SERVICE_TOKEN no configurado');
    }

    // Obtener usuarios con notificaciones habilitadas
    const enabledUsers = this.getEnabledUsers(causa);

    if (enabledUsers.length === 0) {
      logger.info(`No hay usuarios con notificaciones habilitadas para causa ${causa.number}/${causa.year}`);
      return {
        success: true,
        usersNotified: 0,
        reason: 'No hay usuarios habilitados'
      };
    }

    // Preparar payload con un movimiento por cada usuario habilitado
    const movements = [];
    for (const userId of enabledUsers) {
      movements.push({
        userId: userId.toString(),
        expediente: {
          id: causa._id.toString(),
          number: causa.number,
          year: causa.year,
          fuero: causa.fuero,
          caratula: causa.caratula || '',
          objeto: causa.objeto || ''
        },
        movimiento: {
          fecha: movimiento.fecha,
          tipo: movimiento.tipo || 'MOVIMIENTO',
          detalle: movimiento.detalle,
          url: movimiento.url || null
        }
      });
    }

    const payload = {
      notificationTime: new Date().toISOString(),
      movements: movements
    };

    const webhookUrl = `${notificationServiceUrl}/api/judicial-movements/webhook/daily-movements`;

    logger.info(`Enviando notificación a: ${webhookUrl}`);
    logger.info(`Usuarios a notificar: ${enabledUsers.length}`);
    logger.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceToken}`
      },
      timeout: 30000
    });

    return {
      success: response.data.success !== false,
      usersNotified: enabledUsers.length,
      data: response.data
    };
  },

  // Agregar un movimiento a una causa
  async addMovimiento(req, res) {
    try {
      const { fuero, id } = req.params;
      const { fecha, tipo, detalle, url, sendNotification } = req.body;
      const Model = getModel(fuero);

      // Validar campos requeridos
      if (!fecha || !tipo || !detalle) {
        return res.status(400).json({
          success: false,
          message: 'Los campos fecha, tipo y detalle son obligatorios',
          data: null
        });
      }

      // Buscar la causa
      const causa = await Model.findById(id);

      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      // Convertir la fecha del nuevo movimiento
      const fechaNuevoMovimiento = new Date(fecha);

      // Crear el nuevo movimiento
      const nuevoMovimiento = {
        fecha: fechaNuevoMovimiento,
        tipo,
        detalle,
        url: url || null
      };

      // Inicializar el array de movimientos si no existe
      if (!causa.movimiento || !Array.isArray(causa.movimiento)) {
        causa.movimiento = [];
      }

      // Encontrar la posición correcta para insertar el movimiento (orden descendente por fecha)
      // Posición 0 = más reciente, última posición = más antiguo
      let insertIndex = causa.movimiento.length; // Por defecto, al final

      for (let i = 0; i < causa.movimiento.length; i++) {
        const movFecha = new Date(causa.movimiento[i].fecha);
        if (fechaNuevoMovimiento > movFecha) {
          insertIndex = i;
          break;
        }
      }

      // Insertar el movimiento en la posición correcta
      causa.movimiento.splice(insertIndex, 0, nuevoMovimiento);

      // Actualizar el contador de movimientos
      causa.movimientosCount = causa.movimiento.length;

      // Actualizar lastUpdate con la fecha y hora actual (UTC)
      const ahora = new Date();
      causa.lastUpdate = ahora;

      // Verificar si la fecha del nuevo movimiento es más reciente que fechaUltimoMovimiento
      if (!causa.fechaUltimoMovimiento || fechaNuevoMovimiento > causa.fechaUltimoMovimiento) {
        causa.fechaUltimoMovimiento = fechaNuevoMovimiento;
      }

      // Inicializar updateHistory si no existe
      if (!causa.updateHistory || !Array.isArray(causa.updateHistory)) {
        causa.updateHistory = [];
      }

      // Agregar entrada al updateHistory
      causa.updateHistory.push({
        timestamp: ahora,
        source: 'manual',
        updateType: 'update',
        success: true,
        movimientosAdded: 1,
        movimientosTotal: causa.movimiento.length,
        details: {
          movimientoAgregado: {
            fecha: nuevoMovimiento.fecha,
            tipo: nuevoMovimiento.tipo
          }
        }
      });

      // Guardar los cambios
      await causa.save();

      // Enviar notificación si está habilitada
      let notificationResult = null;
      if (sendNotification) {
        try {
          notificationResult = await this.sendMovementNotification(causa, nuevoMovimiento);
          logger.info(`Notificación enviada: ${notificationResult.success ? 'exitosa' : 'fallida'} - Usuarios notificados: ${notificationResult.usersNotified || 0}`);
        } catch (notifError) {
          logger.error(`Error enviando notificación: ${notifError.message}`);
          // No fallar la operación si falla la notificación
        }
      }

      res.json({
        success: true,
        message: 'Movimiento agregado correctamente',
        data: {
          causaId: causa._id,
          nuevoMovimiento,
          movimientosCount: causa.movimientosCount,
          fechaUltimoMovimiento: causa.fechaUltimoMovimiento,
          lastUpdate: causa.lastUpdate,
          notificationSent: notificationResult ? notificationResult.success : false,
          usersNotified: notificationResult ? notificationResult.usersNotified : 0,
          updateHistory: causa.updateHistory || []
        }
      });
    } catch (error) {
      logger.error(`Error agregando movimiento: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Enviar notificación de un movimiento específico
  async sendMovimientoNotification(req, res) {
    try {
      const { fuero, id, movimientoIndex } = req.params;
      const Model = getModel(fuero);

      // Convertir el índice a número
      const index = parseInt(movimientoIndex);
      if (isNaN(index) || index < 0) {
        return res.status(400).json({
          success: false,
          message: 'Índice de movimiento inválido',
          data: null
        });
      }

      // Buscar la causa
      const causa = await Model.findById(id);

      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      // Verificar que el índice existe
      if (index >= causa.movimiento.length) {
        return res.status(404).json({
          success: false,
          message: 'Movimiento no encontrado',
          data: null
        });
      }

      // Obtener el movimiento específico
      const movimiento = causa.movimiento[index];

      // Enviar notificación usando la función auxiliar
      let notificationResult = null;
      try {
        notificationResult = await this.sendMovementNotification(causa, movimiento);
        logger.info(`Notificación de movimiento enviada: ${notificationResult.success ? 'exitosa' : 'fallida'} - Usuarios notificados: ${notificationResult.usersNotified || 0}`);
      } catch (notifError) {
        logger.error(`Error enviando notificación: ${notifError.message}`);
        return res.status(500).json({
          success: false,
          message: 'Error al enviar la notificación',
          error: notifError.message,
          data: null
        });
      }

      res.json({
        success: notificationResult.success,
        message: notificationResult.usersNotified > 0
          ? `Notificación enviada a ${notificationResult.usersNotified} usuario${notificationResult.usersNotified > 1 ? 's' : ''}`
          : 'No hay usuarios habilitados para notificar',
        data: {
          usersNotified: notificationResult.usersNotified,
          movimiento: {
            index,
            fecha: movimiento.fecha,
            tipo: movimiento.tipo,
            detalle: movimiento.detalle
          }
        }
      });
    } catch (error) {
      logger.error(`Error enviando notificación de movimiento: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Obtener usuarios con notificaciones habilitadas para una causa
  async getNotificationUsers(req, res) {
    try {
      const { fuero, id } = req.params;
      const Model = getModel(fuero);
      const mongoose = require('mongoose');

      // Buscar la causa
      const causa = await Model.findById(id).select('userUpdatesEnabled userCausaIds');

      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: []
        });
      }

      // Obtener los IDs de usuarios habilitados
      const enabledUserIds = causasController.getEnabledUsers(causa);

      if (enabledUserIds.length === 0) {
        return res.json({
          success: true,
          message: 'No hay usuarios con notificaciones habilitadas',
          count: 0,
          data: []
        });
      }

      // Buscar información de los usuarios en la colección "usuarios"
      const db = mongoose.connection.db;
      const usuariosCollection = db.collection('usuarios');

      const usuarios = await usuariosCollection.find({
        _id: { $in: enabledUserIds.map(id => new mongoose.Types.ObjectId(id)) }
      }).toArray();

      // Formatear la respuesta
      const usersData = usuarios.map(user => ({
        id: user._id.toString(),
        email: user.email || 'Sin email',
        name: user.name || user.email || 'Usuario sin nombre'
      }));

      res.json({
        success: true,
        message: 'Usuarios obtenidos correctamente',
        count: usersData.length,
        data: usersData
      });
    } catch (error) {
      logger.error(`Error obteniendo usuarios para notificación: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: []
      });
    }
  },

  // Limpiar todo el historial de actualizaciones de una causa
  async clearUpdateHistory(req, res) {
    try {
      const { fuero, id } = req.params;
      const Model = getModel(fuero);

      // Buscar la causa
      const causa = await Model.findById(id);

      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      // Limpiar el array updateHistory
      const historyCount = causa.updateHistory ? causa.updateHistory.length : 0;
      causa.updateHistory = [];

      await causa.save();

      res.json({
        success: true,
        message: `Historial limpiado correctamente. ${historyCount} entrada${historyCount !== 1 ? 's' : ''} eliminada${historyCount !== 1 ? 's' : ''}`,
        data: {
          causaId: causa._id,
          entriesDeleted: historyCount
        }
      });
    } catch (error) {
      logger.error(`Error limpiando historial de actualizaciones: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Eliminar una entrada específica del historial de actualizaciones
  async deleteUpdateHistoryEntry(req, res) {
    try {
      const { fuero, id, entryIndex } = req.params;
      const Model = getModel(fuero);

      // Convertir el índice a número
      const index = parseInt(entryIndex);
      if (isNaN(index) || index < 0) {
        return res.status(400).json({
          success: false,
          message: 'Índice de entrada inválido',
          data: null
        });
      }

      // Buscar la causa
      const causa = await Model.findById(id);

      if (!causa) {
        return res.status(404).json({
          success: false,
          message: 'Causa no encontrada',
          data: null
        });
      }

      // Verificar que el array updateHistory existe y tiene el índice
      if (!causa.updateHistory || !Array.isArray(causa.updateHistory)) {
        causa.updateHistory = [];
      }

      if (index >= causa.updateHistory.length) {
        return res.status(404).json({
          success: false,
          message: 'Entrada no encontrada en el historial',
          data: null
        });
      }

      // Eliminar la entrada del historial
      const deletedEntry = causa.updateHistory.splice(index, 1)[0];

      await causa.save();

      res.json({
        success: true,
        message: 'Entrada eliminada correctamente',
        data: {
          causaId: causa._id,
          deletedEntry: {
            timestamp: deletedEntry.timestamp,
            updateType: deletedEntry.updateType,
            source: deletedEntry.source
          },
          remainingEntries: causa.updateHistory.length
        }
      });
    } catch (error) {
      logger.error(`Error eliminando entrada del historial: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Obtener estadísticas de elegibilidad para actualización
  // IMPORTANTE: Los criterios deben coincidir EXACTAMENTE con los del worker (app-update-manager.js)
  async getEligibilityStats(req, res) {
    try {
      const { fuero, thresholdHours = 2 } = req.query;
      const threshold = parseInt(thresholdHours);
      const now = new Date();
      const updateThreshold = new Date(now - threshold * 60 * 60 * 1000);
      const todayStr = now.toISOString().split('T')[0];

      // Modelos a consultar
      const models = fuero && fuero !== 'todos'
        ? [{ model: getModel(fuero), name: fuero }]
        : [
            { model: CausasCivil, name: 'CIV' },
            { model: CausasComercial, name: 'COM' },
            { model: CausasSegSoc, name: 'CSS' },
            { model: CausasTrabajo, name: 'CNT' }
          ];

      // Ejecutar consultas en paralelo por cada modelo
      const statsPromises = models.map(async ({ model, name }) => {
        // Criterios base que coinciden EXACTAMENTE con el worker
        // Ver: app-update-manager.js -> countPendingDocumentsByFuero()
        const workerBaseFilter = {
          source: { $in: ["app", "cache", "pjn-login"] },
          verified: true,
          isValid: true,
          update: true,
          isPrivate: { $ne: true },
          movimientosCount: { $gt: 0 },
          'movimiento.0': { $exists: true }
        };

        // Total verificados (para contexto)
        const total = await model.countDocuments({ verified: true, isValid: true });

        // Elegibles: cumplen criterios base del worker
        const eligible = await model.countDocuments(workerBaseFilter);

        // Actualizados: elegibles con lastUpdate dentro del threshold
        const eligibleUpdated = await model.countDocuments({
          ...workerBaseFilter,
          lastUpdate: { $gte: updateThreshold }
        });

        // Pendientes: elegibles que necesitan actualización Y no están en cooldown
        const eligiblePending = await model.countDocuments({
          ...workerBaseFilter,
          $and: [
            {
              $or: [
                { lastUpdate: { $exists: false } },
                { lastUpdate: { $lt: updateThreshold } }
              ]
            },
            {
              $or: [
                { 'scrapingProgress.skipUntil': { $exists: false } },
                { 'scrapingProgress.skipUntil': null },
                { 'scrapingProgress.skipUntil': { $lte: now } }
              ]
            },
            {
              $or: [
                { processingLock: { $exists: false } },
                { processingLock: null },
                { 'processingLock.expiresAt': { $lt: now } }
              ]
            }
          ]
        });

        // Con errores: elegibles en cooldown activo
        const eligibleWithErrors = await model.countDocuments({
          ...workerBaseFilter,
          'scrapingProgress.skipUntil': { $gt: now }
        });

        // No elegibles para el worker (no cumplen criterios base)
        const notEligible = await model.countDocuments({
          verified: true,
          isValid: true,
          $or: [
            { update: { $ne: true } },
            { isPrivate: true },
            { source: { $nin: ["app", "cache", "pjn-login"] } },
            { movimientosCount: { $lte: 0 } },
            { movimientosCount: { $exists: false } },
            { 'movimiento.0': { $exists: false } }
          ]
        });

        // Actualizados hoy (basado en appUpdateStats.today)
        const updatedToday = await model.countDocuments({
          ...workerBaseFilter,
          'updateStats.today.date': todayStr,
          'updateStats.today.count': { $gt: 0 }
        });

        return {
          fuero: name,
          total,
          eligible,
          eligibleUpdated,
          eligiblePending,
          eligibleWithErrors,
          notEligible,
          updatedToday
        };
      });

      const statsByFuero = await Promise.all(statsPromises);

      // Calcular totales
      const totals = statsByFuero.reduce((acc, curr) => ({
        total: acc.total + curr.total,
        eligible: acc.eligible + curr.eligible,
        eligibleUpdated: acc.eligibleUpdated + curr.eligibleUpdated,
        eligiblePending: acc.eligiblePending + curr.eligiblePending,
        eligibleWithErrors: acc.eligibleWithErrors + curr.eligibleWithErrors,
        notEligible: acc.notEligible + curr.notEligible,
        updatedToday: acc.updatedToday + curr.updatedToday
      }), {
        total: 0, eligible: 0, eligibleUpdated: 0, eligiblePending: 0,
        eligibleWithErrors: 0, notEligible: 0, updatedToday: 0
      });

      // Calcular porcentaje de cobertura basado en "actualizados hoy"
      // Esto evita falsos positivos cuando el threshold es bajo (ej: 2h)
      const coveragePercent = totals.eligible > 0
        ? ((totals.updatedToday / totals.eligible) * 100).toFixed(1)
        : 0;

      // Pendientes hoy = elegibles que NO fueron actualizados hoy y NO están en cooldown
      const pendingToday = totals.eligible - totals.updatedToday - totals.eligibleWithErrors;

      res.json({
        success: true,
        message: 'Estadísticas de elegibilidad',
        data: {
          thresholdHours: threshold,
          timestamp: now.toISOString(),
          todayDate: todayStr,
          totals: {
            ...totals,
            pendingToday: Math.max(0, pendingToday),
            coveragePercent: parseFloat(coveragePercent)
          },
          byFuero: statsByFuero.reduce((acc, curr) => {
            acc[curr.fuero] = curr;
            return acc;
          }, {})
        }
      });
    } catch (error) {
      logger.error(`Error obteniendo estadísticas de elegibilidad: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  // Obtener estadísticas de causas para el dashboard
  async getStats(req, res) {
    try {
      // Ejecutar todas las consultas en paralelo para mejor rendimiento
      const [
        // PJN - Verified (verified: true, isValid: true)
        civilVerified,
        comercialVerified,
        segSocVerified,
        trabajoVerified,
        // PJN - Non-verified (verified: true, isValid: false)
        civilNonVerified,
        comercialNonVerified,
        segSocNonVerified,
        trabajoNonVerified
      ] = await Promise.all([
        // Verified counts
        CausasCivil.countDocuments({ verified: true, isValid: true }),
        CausasComercial.countDocuments({ verified: true, isValid: true }),
        CausasSegSoc.countDocuments({ verified: true, isValid: true }),
        CausasTrabajo.countDocuments({ verified: true, isValid: true }),
        // Non-verified counts
        CausasCivil.countDocuments({ verified: true, isValid: false }),
        CausasComercial.countDocuments({ verified: true, isValid: false }),
        CausasSegSoc.countDocuments({ verified: true, isValid: false }),
        CausasTrabajo.countDocuments({ verified: true, isValid: false })
      ]);

      const totalVerified = civilVerified + comercialVerified + segSocVerified + trabajoVerified;
      const totalNonVerified = civilNonVerified + comercialNonVerified + segSocNonVerified + trabajoNonVerified;

      res.json({
        success: true,
        message: 'Estadísticas de causas PJN',
        data: {
          verified: totalVerified,
          nonVerified: totalNonVerified,
          total: totalVerified + totalNonVerified,
          breakdown: {
            verified: {
              civil: civilVerified,
              comercial: comercialVerified,
              segSoc: segSocVerified,
              trabajo: trabajoVerified
            },
            nonVerified: {
              civil: civilNonVerified,
              comercial: comercialNonVerified,
              segSoc: segSocNonVerified,
              trabajo: trabajoNonVerified
            }
          }
        }
      });
    } catch (error) {
      logger.error(`Error obteniendo estadísticas: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  /**
   * Obtiene estadísticas de capacidad de procesamiento para el dashboard
   * Incluye: tiempo promedio, capacidad por worker, proyecciones y simulador
   */
  async getCapacityStats(req, res) {
    try {
      const {
        thresholdHours = 2,
        workersPerFuero = 3,
        workHoursPerDay = 14
      } = req.query;

      const threshold = parseInt(thresholdHours);
      const workers = parseInt(workersPerFuero);
      const workHours = parseInt(workHoursPerDay);

      const models = [
        { model: CausasCivil, name: 'CIV', fuero: 'civil' },
        { model: CausasComercial, name: 'COM', fuero: 'comercial' },
        { model: CausasSegSoc, name: 'CSS', fuero: 'ss' },
        { model: CausasTrabajo, name: 'CNT', fuero: 'trabajo' }
      ];

      // Filtro base para documentos elegibles
      const workerBaseFilter = {
        source: { $in: ["app", "cache", "pjn-login"] },
        verified: true,
        isValid: true,
        update: true,
        isPrivate: { $ne: true },
        movimientosCount: { $gt: 0 },
        'movimiento.0': { $exists: true }
      };

      // Obtener estadísticas por fuero
      const statsPromises = models.map(async ({ model, name, fuero }) => {
        // Agregación para obtener promedios de updateStats
        const statsAgg = await model.aggregate([
          { $match: { 'updateStats.count': { $gt: 0 } } },
          { $group: {
            _id: null,
            avgMs: { $avg: '$updateStats.avgMs' },
            totalUpdates: { $sum: '$updateStats.count' },
            totalErrors: { $sum: '$updateStats.errors' },
            docsWithStats: { $sum: 1 }
          }}
        ]);

        // Contar documentos elegibles
        const eligibleCount = await model.countDocuments(workerBaseFilter);

        // Obtener updateStats.today para calcular procesados hoy
        const todayStr = new Date().toISOString().split('T')[0];
        const updatedTodayCount = await model.countDocuments({
          ...workerBaseFilter,
          'updateStats.today.date': todayStr
        });

        const stats = statsAgg[0] || { avgMs: 25000, totalUpdates: 0, totalErrors: 0, docsWithStats: 0 };
        const avgSeconds = (stats.avgMs || 25000) / 1000;

        // Calcular capacidad
        const docsPerHourPerWorker = Math.floor(3600 / avgSeconds);
        const docsPerHourTotal = docsPerHourPerWorker * workers;
        const docsPerDayTotal = docsPerHourTotal * workHours;

        // Calcular actualizaciones posibles por documento
        const maxUpdatesPerDocPerDay = Math.floor(workHours / threshold);
        const theoreticalDailyCapacity = docsPerDayTotal;
        const actualMaxUpdates = eligibleCount > 0
          ? Math.min(maxUpdatesPerDocPerDay, Math.floor(theoreticalDailyCapacity / eligibleCount))
          : 0;

        // Tasa de éxito (exitosos / total)
        const successRate = stats.totalUpdates > 0
          ? ((stats.totalUpdates - stats.totalErrors) / stats.totalUpdates) * 100
          : 100;

        return {
          fuero: name,
          fueroKey: fuero,
          eligible: eligibleCount,
          updatedToday: updatedTodayCount,
          processing: {
            avgSeconds: Math.round(avgSeconds * 10) / 10,
            avgMs: Math.round(stats.avgMs || 25000),
            totalUpdates: stats.totalUpdates,
            totalErrors: stats.totalErrors,
            successRate: Math.round(successRate * 10) / 10
          },
          capacity: {
            docsPerHourPerWorker,
            docsPerHourTotal,
            docsPerDayTotal,
            workers
          },
          projections: {
            maxUpdatesPerDocPerDay,
            actualUpdatesPerDocPerDay: actualMaxUpdates,
            timeToProcessAllOnce: eligibleCount > 0
              ? Math.round((eligibleCount / docsPerHourTotal) * 60) // minutos
              : 0,
            dailyCoveragePercent: eligibleCount > 0
              ? Math.min(100, Math.round((docsPerDayTotal / eligibleCount) * 100))
              : 100
          }
        };
      });

      const statsByFuero = await Promise.all(statsPromises);

      // Calcular totales
      const totals = statsByFuero.reduce((acc, curr) => ({
        eligible: acc.eligible + curr.eligible,
        updatedToday: acc.updatedToday + curr.updatedToday,
        totalUpdates: acc.totalUpdates + curr.processing.totalUpdates,
        totalErrors: acc.totalErrors + curr.processing.totalErrors,
        docsPerDayTotal: acc.docsPerDayTotal + curr.capacity.docsPerDayTotal
      }), { eligible: 0, updatedToday: 0, totalUpdates: 0, totalErrors: 0, docsPerDayTotal: 0 });

      // Promedio ponderado del tiempo de procesamiento
      const weightedAvgMs = statsByFuero.reduce((acc, curr) => {
        return acc + (curr.processing.avgMs * curr.processing.totalUpdates);
      }, 0) / (totals.totalUpdates || 1);

      const avgSeconds = weightedAvgMs / 1000;
      const globalSuccessRate = totals.totalUpdates > 0
        ? ((totals.totalUpdates - totals.totalErrors) / totals.totalUpdates) * 100
        : 100;

      res.json({
        success: true,
        message: 'Estadísticas de capacidad de procesamiento',
        data: {
          config: {
            thresholdHours: threshold,
            workersPerFuero: workers,
            workHoursPerDay: workHours
          },
          totals: {
            eligible: totals.eligible,
            updatedToday: totals.updatedToday,
            avgSeconds: Math.round(avgSeconds * 10) / 10,
            avgMs: Math.round(weightedAvgMs),
            successRate: Math.round(globalSuccessRate * 10) / 10,
            docsPerHourPerWorker: Math.floor(3600 / avgSeconds),
            docsPerDayAllFueros: totals.docsPerDayTotal,
            maxUpdatesPerDocPerDay: Math.floor(workHours / threshold),
            timeToProcessAllOnce: totals.eligible > 0
              ? Math.round((totals.eligible / (totals.docsPerDayTotal / workHours)) * 60)
              : 0,
            dailyCoveragePercent: totals.eligible > 0
              ? Math.min(100, Math.round((totals.docsPerDayTotal / totals.eligible) * 100))
              : 100
          },
          byFuero: statsByFuero.reduce((acc, curr) => {
            acc[curr.fuero] = curr;
            return acc;
          }, {}),
          simulation: {
            description: 'Ajusta los parámetros para simular diferentes escenarios',
            parameters: {
              thresholdHours: 'Tiempo mínimo entre actualizaciones de un mismo documento',
              workersPerFuero: 'Cantidad de workers por fuero',
              workHoursPerDay: 'Horas de trabajo por día'
            },
            example: '?thresholdHours=2&workersPerFuero=3&workHoursPerDay=14'
          }
        }
      });
    } catch (error) {
      logger.error(`Error obteniendo estadísticas de capacidad: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  }

};

module.exports = causasController;