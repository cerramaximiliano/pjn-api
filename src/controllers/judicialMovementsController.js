const mongoose = require('mongoose');

/**
 * Controlador para manejar consultas a la colección judicialmovements
 */

/**
 * Obtener movimientos judiciales por expediente.id
 * GET /api/judicial-movements/by-expediente/:expedienteId
 */
exports.getMovementsByExpedienteId = async (req, res) => {
	const { expedienteId } = req.params;

	if (!expedienteId) {
		return res.status(400).json({
			success: false,
			message: 'El parámetro expedienteId es requerido',
		});
	}

	try {
		// Usar la conexión existente de Mongoose
		const db = mongoose.connection.db;
		const collection = db.collection('judicialmovements');

		// Buscar documentos donde expediente.id coincida con el expedienteId
		const movements = await collection
			.find({ 'expediente.id': expedienteId })
			.sort({ 'movimiento.fecha': -1 }) // Ordenar por fecha de movimiento descendente
			.toArray();

		return res.status(200).json({
			success: true,
			message: 'Movimientos judiciales obtenidos correctamente',
			count: movements.length,
			data: movements,
		});
	} catch (error) {
		console.error('❌ Error al obtener movimientos judiciales:', error);
		return res.status(500).json({
			success: false,
			message: 'Error al obtener los movimientos judiciales',
			error: error.message,
		});
	}
};
