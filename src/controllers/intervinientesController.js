/**
 * Controller para Intervinientes
 * Maneja las operaciones CRUD para la colección de intervinientes
 */
const Interviniente = require('../models/interviniente');
const { logger } = require('../config/pino');

const intervinientesController = {
    /**
     * Obtiene todos los intervinientes vinculados a una causa por su ID
     * GET /api/intervinientes/causa/:causaId
     */
    async findByCausaId(req, res) {
        try {
            const { causaId } = req.params;

            if (!causaId) {
                return res.status(400).json({
                    success: false,
                    message: 'El parámetro causaId es requerido',
                    data: null
                });
            }

            const intervinientes = await Interviniente.find({ causaId })
                .sort({ tipoInterviniente: 1, 'parte.tipo': 1 })
                .lean();

            // Agrupar por tipo para mejor organización
            const partes = intervinientes.filter(i => i.tipoInterviniente === 'PARTE');
            const letrados = intervinientes.filter(i => i.tipoInterviniente === 'LETRADO');

            res.json({
                success: true,
                message: intervinientes.length > 0
                    ? `Se encontraron ${intervinientes.length} intervinientes`
                    : 'No se encontraron intervinientes para esta causa',
                count: intervinientes.length,
                data: {
                    causaId,
                    partes,
                    letrados,
                    all: intervinientes
                }
            });
        } catch (error) {
            logger.error(`Error buscando intervinientes por causaId: ${error.message}`);

            if (error.name === 'CastError') {
                return res.status(400).json({
                    success: false,
                    message: 'ID de causa inválido',
                    error: error.message,
                    data: null
                });
            }

            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
                data: null
            });
        }
    },

    /**
     * Obtiene todos los intervinientes con paginación
     * GET /api/intervinientes
     */
    async findAll(req, res) {
        try {
            const {
                page = 1,
                limit = 20,
                tipoInterviniente,
                fuero,
                nombre
            } = req.query;

            const skip = (page - 1) * limit;

            // Construir filtro
            const filter = {};
            if (tipoInterviniente) filter.tipoInterviniente = tipoInterviniente;
            if (fuero) filter['expediente.fuero'] = fuero;
            if (nombre) {
                filter.$or = [
                    { 'parte.nombre': { $regex: nombre, $options: 'i' } },
                    { 'letrado.nombre': { $regex: nombre, $options: 'i' } },
                    { nombreNormalizado: { $regex: nombre.toLowerCase(), $options: 'i' } }
                ];
            }

            const [data, total] = await Promise.all([
                Interviniente.find(filter)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(Number(limit))
                    .lean(),
                Interviniente.countDocuments(filter)
            ]);

            res.json({
                success: true,
                message: data.length > 0 ? 'Intervinientes encontrados' : 'No se encontraron intervinientes',
                count: data.length,
                total,
                page: Number(page),
                pages: Math.ceil(total / limit),
                data
            });
        } catch (error) {
            logger.error(`Error obteniendo intervinientes: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
                data: null
            });
        }
    },

    /**
     * Obtiene un interviniente por su ID
     * GET /api/intervinientes/:id
     */
    async findById(req, res) {
        try {
            const { id } = req.params;

            if (!id) {
                return res.status(400).json({
                    success: false,
                    message: 'El parámetro id es requerido',
                    data: null
                });
            }

            const interviniente = await Interviniente.findById(id).lean();

            if (!interviniente) {
                return res.status(404).json({
                    success: false,
                    message: 'Interviniente no encontrado',
                    data: null
                });
            }

            res.json({
                success: true,
                message: 'Interviniente encontrado',
                data: interviniente
            });
        } catch (error) {
            logger.error(`Error buscando interviniente por ID: ${error.message}`);

            if (error.name === 'CastError') {
                return res.status(400).json({
                    success: false,
                    message: 'ID inválido',
                    error: error.message,
                    data: null
                });
            }

            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
                data: null
            });
        }
    },

    /**
     * Busca intervinientes por nombre (parte o letrado)
     * GET /api/intervinientes/buscar/nombre
     */
    async findByNombre(req, res) {
        try {
            const { nombre, page = 1, limit = 20 } = req.query;

            if (!nombre) {
                return res.status(400).json({
                    success: false,
                    message: 'El parámetro nombre es requerido',
                    data: null
                });
            }

            const skip = (page - 1) * limit;

            const filter = {
                $or: [
                    { 'parte.nombre': { $regex: nombre, $options: 'i' } },
                    { 'letrado.nombre': { $regex: nombre, $options: 'i' } },
                    { nombreNormalizado: { $regex: nombre.toLowerCase(), $options: 'i' } }
                ]
            };

            const [data, total] = await Promise.all([
                Interviniente.find(filter)
                    .sort({ 'expediente.year': -1, 'expediente.number': -1 })
                    .skip(skip)
                    .limit(Number(limit))
                    .lean(),
                Interviniente.countDocuments(filter)
            ]);

            res.json({
                success: true,
                message: data.length > 0
                    ? `Se encontraron ${total} intervinientes con nombre "${nombre}"`
                    : `No se encontraron intervinientes con nombre "${nombre}"`,
                count: data.length,
                total,
                page: Number(page),
                pages: Math.ceil(total / limit),
                data
            });
        } catch (error) {
            logger.error(`Error buscando intervinientes por nombre: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
                data: null
            });
        }
    },

    /**
     * Obtiene estadísticas de intervinientes
     * GET /api/intervinientes/stats
     */
    async getStats(req, res) {
        try {
            const stats = await Interviniente.aggregate([
                {
                    $facet: {
                        total: [{ $count: 'count' }],
                        byTipo: [
                            { $group: { _id: '$tipoInterviniente', count: { $sum: 1 } } }
                        ],
                        byFuero: [
                            { $group: { _id: '$expediente.fuero', count: { $sum: 1 } } }
                        ],
                        byTipoParte: [
                            { $match: { tipoInterviniente: 'PARTE' } },
                            { $group: { _id: '$parte.tipo', count: { $sum: 1 } } }
                        ],
                        byTipoLetrado: [
                            { $match: { tipoInterviniente: 'LETRADO' } },
                            { $group: { _id: '$letrado.tipo', count: { $sum: 1 } } }
                        ],
                        causasUnicas: [
                            { $group: { _id: '$causaId' } },
                            { $count: 'count' }
                        ]
                    }
                }
            ]);

            const result = stats[0];

            res.json({
                success: true,
                message: 'Estadísticas obtenidas',
                data: {
                    total: result.total[0]?.count || 0,
                    causasConIntervinientes: result.causasUnicas[0]?.count || 0,
                    byTipo: result.byTipo,
                    byFuero: result.byFuero,
                    byTipoParte: result.byTipoParte,
                    byTipoLetrado: result.byTipoLetrado
                }
            });
        } catch (error) {
            logger.error(`Error obteniendo estadísticas de intervinientes: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
                data: null
            });
        }
    },

    /**
     * Obtiene intervinientes por expediente (número y año)
     * GET /api/intervinientes/expediente/:fuero/:number/:year
     */
    async findByExpediente(req, res) {
        try {
            const { fuero, number, year } = req.params;

            if (!fuero || !number || !year) {
                return res.status(400).json({
                    success: false,
                    message: 'Los parámetros fuero, number y year son requeridos',
                    data: null
                });
            }

            const intervinientes = await Interviniente.find({
                'expediente.fuero': fuero.toUpperCase(),
                'expediente.number': Number(number),
                'expediente.year': Number(year)
            }).sort({ tipoInterviniente: 1, 'parte.tipo': 1 }).lean();

            const partes = intervinientes.filter(i => i.tipoInterviniente === 'PARTE');
            const letrados = intervinientes.filter(i => i.tipoInterviniente === 'LETRADO');

            res.json({
                success: true,
                message: intervinientes.length > 0
                    ? `Se encontraron ${intervinientes.length} intervinientes`
                    : 'No se encontraron intervinientes para este expediente',
                count: intervinientes.length,
                data: {
                    expediente: { fuero: fuero.toUpperCase(), number: Number(number), year: Number(year) },
                    partes,
                    letrados,
                    all: intervinientes
                }
            });
        } catch (error) {
            logger.error(`Error buscando intervinientes por expediente: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor',
                error: error.message,
                data: null
            });
        }
    }
};

module.exports = intervinientesController;
