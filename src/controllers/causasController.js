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
  }

};

module.exports = causasController;