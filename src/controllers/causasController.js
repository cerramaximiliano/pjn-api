const { CausasCivil, CausasSegSoc, CausasTrabajo } = require("pjn-models")
const { logger } = require('../config/pino');

const getModel = (fuero) => {
  switch (fuero) {
    case 'CIV': return CausasCivil;
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

      // Obtener conteos totales reales en paralelo
      const [totalCivil, totalSegSoc, totalTrabajo] = await Promise.all([
        fuero && fuero !== 'CIV' ? 0 : CausasCivil.countDocuments({ verified: true, isValid: true }),
        fuero && fuero !== 'CSS' ? 0 : CausasSegSoc.countDocuments({ verified: true, isValid: true }),
        fuero && fuero !== 'CNT' ? 0 : CausasTrabajo.countDocuments({ verified: true, isValid: true })
      ]);

      const totalCausasReal = totalCivil + totalSegSoc + totalTrabajo;
      const totalPages = Math.ceil(totalCausasReal / limit);

      // Estrategia optimizada: consultar solo los documentos necesarios por página
      let causasPaginadas = [];
      
      // Calcular cuántos documentos tomar de cada colección
      const limitPerCollection = Math.ceil(limit / 3) + 10; // Un poco más para asegurar que tengamos suficientes
      
      // Consultar con skip y limit directamente en MongoDB
      const [causasCivil, causasSegSoc, causasTrabajo] = await Promise.all([
        fuero && fuero !== 'CIV' ? [] : CausasCivil.find({ verified: true, isValid: true })
          .sort({ year: -1, number: -1 })
          .skip(Math.floor(skip / 3))
          .limit(limitPerCollection)
          .lean(),
        fuero && fuero !== 'CSS' ? [] : CausasSegSoc.find({ verified: true, isValid: true })
          .sort({ year: -1, number: -1 })
          .skip(Math.floor(skip / 3))
          .limit(limitPerCollection)
          .lean(),
        fuero && fuero !== 'CNT' ? [] : CausasTrabajo.find({ verified: true, isValid: true })
          .sort({ year: -1, number: -1 })
          .skip(Math.floor(skip / 3))
          .limit(limitPerCollection)
          .lean()
      ]);

      // Combinar y agregar fuero
      const allCausas = [
        ...causasCivil.map(causa => ({ ...causa, fuero: 'CIV' })),
        ...causasSegSoc.map(causa => ({ ...causa, fuero: 'CSS' })),
        ...causasTrabajo.map(causa => ({ ...causa, fuero: 'CNT' }))
      ];

      // Ordenar solo los documentos necesarios
      allCausas.sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year;
        return b.number - a.number;
      });

      // Tomar solo el límite necesario
      causasPaginadas = allCausas.slice(0, limit);

      res.json({
        success: true,
        message: `Mostrando ${causasPaginadas.length} de ${totalCausasReal} causas verificadas y válidas${fuero ? ` del fuero ${fuero}` : ''}`,
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
  }

};

module.exports = causasController;