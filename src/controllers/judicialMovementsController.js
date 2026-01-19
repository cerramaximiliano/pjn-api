const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

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

/**
 * Eliminar un movimiento judicial por ID
 * DELETE /api/judicial-movements/:id
 */
exports.deleteMovement = async (req, res) => {
	const { id } = req.params;

	if (!id) {
		return res.status(400).json({
			success: false,
			message: 'El parámetro id es requerido',
		});
	}

	try {
		// Validar que el ID sea un ObjectId válido
		if (!ObjectId.isValid(id)) {
			return res.status(400).json({
				success: false,
				message: 'El ID proporcionado no es válido',
			});
		}

		const db = mongoose.connection.db;
		const collection = db.collection('judicialmovements');

		const result = await collection.deleteOne({ _id: new ObjectId(id) });

		if (result.deletedCount === 0) {
			return res.status(404).json({
				success: false,
				message: 'No se encontró el movimiento judicial con el ID especificado',
			});
		}

		return res.status(200).json({
			success: true,
			message: 'Movimiento judicial eliminado correctamente',
		});
	} catch (error) {
		console.error('❌ Error al eliminar movimiento judicial:', error);
		return res.status(500).json({
			success: false,
			message: 'Error al eliminar el movimiento judicial',
			error: error.message,
		});
	}
};
