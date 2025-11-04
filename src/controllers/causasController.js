const { CausasCivil, CausasComercial, CausasSegSoc, CausasTrabajo } = require("pjn-models")
const { logger } = require('../config/pino');

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

      // Parámetros de ordenamiento
      const sortBy = req.query.sortBy || 'year'; // Campo por el cual ordenar
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1; // Orden ascendente o descendente

      // Log para depuración
      logger.info(`Ordenamiento recibido - sortBy: ${req.query.sortBy}, sortOrder: ${req.query.sortOrder}`);

      // Construir objeto de sort para MongoDB
      const sortOptions = {};

      // Mapeo de campos permitidos para ordenar
      const allowedSortFields = ['number', 'year', 'caratula', 'juzgado', 'objeto', 'movimientosCount'];

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

      // Obtener conteos totales reales en paralelo con filtros aplicados
      const [totalCivil, totalComercial, totalSegSoc, totalTrabajo] = await Promise.all([
        fuero && fuero !== 'CIV' ? 0 : CausasCivil.countDocuments(searchFilters),
        fuero && fuero !== 'COM' ? 0 : CausasComercial.countDocuments(searchFilters),
        fuero && fuero !== 'CSS' ? 0 : CausasSegSoc.countDocuments(searchFilters),
        fuero && fuero !== 'CNT' ? 0 : CausasTrabajo.countDocuments(searchFilters)
      ]);

      const totalCausasReal = totalCivil + totalComercial + totalSegSoc + totalTrabajo;
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
  },

  // Actualizar campos de una causa
  async updateCausa(req, res) {
    try {
      const { fuero, id } = req.params;
      const updateData = req.body;
      const Model = getModel(fuero);

      // Campos permitidos para actualizar
      const allowedFields = [
        'caratula', 'juzgado', 'objeto', 'lastUpdate',
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

      // Guardar los cambios
      await causa.save();

      res.json({
        success: true,
        message: 'Movimiento eliminado correctamente',
        data: {
          causaId: causa._id,
          movimientoEliminado,
          movimientosRestantes: causa.movimiento.length
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
  }

};

module.exports = causasController;