const Juzgado = require("../models/juzgados");
const { logger } = require('../config/pino');

const juzgadosController = {
  // Buscar juzgados por código (obligatorio) y otros parámetros opcionales
  async findByCodigo(req, res) {
    try {
      const { codigo } = req.params;
      const { jurisdiccion, ciudad, organismo, datosCompletos } = req.query;

      // Validar que el código sea obligatorio
      if (!codigo) {
        return res.status(400).json({
          success: false,
          message: 'El parámetro código es obligatorio',
          count: 0,
          data: null
        });
      }

      // Construir el filtro de búsqueda
      const filter = { codigo: Number(codigo) };

      // Agregar filtros opcionales si están presentes
      if (jurisdiccion) {
        filter.jurisdiccion = new RegExp(jurisdiccion, 'i');
      }
      if (ciudad) {
        filter.ciudad = new RegExp(ciudad, 'i');
      }
      if (organismo) {
        filter.organismo = new RegExp(organismo, 'i');
      }
      if (datosCompletos !== undefined) {
        filter.datosCompletos = datosCompletos === 'true';
      }

      // Buscar juzgados
      const juzgados = await Juzgado.find(filter)
        .select('-__v')
        .sort({ codigo: 1 });

      if (!juzgados || juzgados.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No se encontraron juzgados con los criterios especificados',
          count: 0,
          data: []
        });
      }

      res.json({
        success: true,
        message: 'Juzgados encontrados',
        count: juzgados.length,
        data: juzgados
      });

    } catch (error) {
      logger.error(`Error buscando juzgados por código: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: null
      });
    }
  },

  // Obtener todos los juzgados con filtros opcionales
  async findAll(req, res) {
    try {
      const { jurisdiccion, ciudad, organismo, datosCompletos, page = 1, limit = 20 } = req.query;

      // Construir el filtro de búsqueda
      const filter = {};

      if (jurisdiccion) {
        filter.jurisdiccion = new RegExp(jurisdiccion, 'i');
      }
      if (ciudad) {
        filter.ciudad = new RegExp(ciudad, 'i');
      }
      if (organismo) {
        filter.organismo = new RegExp(organismo, 'i');
      }
      if (datosCompletos !== undefined) {
        filter.datosCompletos = datosCompletos === 'true';
      }

      // Calcular skip para paginación
      const skip = (page - 1) * limit;

      // Buscar juzgados con paginación
      const [juzgados, total] = await Promise.all([
        Juzgado.find(filter)
          .select('-__v')
          .sort({ codigo: 1 })
          .skip(skip)
          .limit(Number(limit)),
        Juzgado.countDocuments(filter)
      ]);

      res.json({
        success: true,
        message: 'Juzgados encontrados',
        count: juzgados.length,
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        data: juzgados
      });

    } catch (error) {
      logger.error(`Error obteniendo juzgados: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        count: 0,
        data: null
      });
    }
  }
};

module.exports = juzgadosController;