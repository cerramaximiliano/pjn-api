const { ConfiguracionEmailVerification } = require("pjn-models");
const { logger } = require('../config/pino');
const axios = require('axios');

const configuracionEmailVerificationController = {
  async findAll(req, res) {
    try {
      const configuracion = await ConfiguracionEmailVerification.findOne({
        worker_id: 'email_verification'
      }).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de verificación de email no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Configuración de verificación de email encontrada',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error obteniendo configuración de verificación de email: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async updateById(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'El parámetro id es obligatorio',
          data: null
        });
      }

      // Campos que no se pueden modificar directamente
      const protectedFields = [
        'worker_id',
        'todayVerified',
        'todayJobs',
        'todayDate',
        'totalVerified',
        'totalFailed',
        'stats',
        'processing',
        'lastRun'
      ];

      // Eliminar campos protegidos del update
      protectedFields.forEach(field => {
        delete updateData[field];
      });

      const configuracion = await ConfiguracionEmailVerification.findByIdAndUpdate(
        id,
        updateData,
        {
          new: true,
          runValidators: true
        }
      ).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de verificación de email no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Configuración de verificación de email actualizada exitosamente',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error actualizando configuración de verificación de email: ${error}`);

      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Error de validación',
          error: error.message,
          data: null
        });
      }

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

  async resetDailyCounters(req, res) {
    try {
      const { id } = req.params;

      const configuracion = await ConfiguracionEmailVerification.findByIdAndUpdate(
        id,
        {
          $set: {
            todayVerified: 0,
            todayJobs: 0,
            todayDate: new Date()
          }
        },
        { new: true }
      ).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de verificación de email no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Contadores diarios reseteados exitosamente',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error reseteando contadores diarios: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async clearProcessingState(req, res) {
    try {
      const { id } = req.params;

      const configuracion = await ConfiguracionEmailVerification.findByIdAndUpdate(
        id,
        {
          $set: {
            'processing.isRunning': false,
            'processing.completedAt': new Date()
          }
        },
        { new: true }
      ).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de verificación de email no encontrada',
          data: null
        });
      }

      res.json({
        success: true,
        message: 'Estado de procesamiento limpiado exitosamente',
        data: configuracion
      });

    } catch (error) {
      logger.error(`Error limpiando estado de procesamiento: ${error}`);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message,
        data: null
      });
    }
  },

  async refreshCredits(req, res) {
    try {
      const { id } = req.params;

      // Verificar que exista la API key de NeverBounce
      const apiKey = process.env.NEVER_BOUNCE_KEY;
      if (!apiKey) {
        return res.status(500).json({
          success: false,
          message: 'API key de NeverBounce no configurada en el servidor',
          data: null
        });
      }

      // Llamar a la API de NeverBounce para obtener info de cuenta
      const response = await axios.get('https://api.neverbounce.com/v4/account/info', {
        params: { key: apiKey },
        timeout: 30000
      });

      if (response.data.status !== 'success') {
        return res.status(400).json({
          success: false,
          message: `Error de NeverBounce: ${response.data.message || 'Error desconocido'}`,
          data: null
        });
      }

      // Calcular créditos totales
      const creditsInfo = response.data.credits_info || {};
      const paidCredits = parseFloat(creditsInfo.paid_credits_remaining) || 0;
      const freeCredits = parseFloat(creditsInfo.free_credits_remaining) || 0;
      const totalCredits = paidCredits + freeCredits;

      // Actualizar en la base de datos
      const configuracion = await ConfiguracionEmailVerification.findByIdAndUpdate(
        id,
        {
          $set: {
            neverBounceCredits: totalCredits
          }
        },
        { new: true }
      ).select('-__v');

      if (!configuracion) {
        return res.status(404).json({
          success: false,
          message: 'Configuración de verificación de email no encontrada',
          data: null
        });
      }

      logger.info(`Créditos de NeverBounce actualizados: ${totalCredits} (paid: ${paidCredits}, free: ${freeCredits})`);

      res.json({
        success: true,
        message: 'Créditos actualizados exitosamente desde NeverBounce',
        data: {
          ...configuracion.toObject(),
          creditsDetail: {
            paid: paidCredits,
            free: freeCredits,
            total: totalCredits
          }
        }
      });

    } catch (error) {
      logger.error(`Error actualizando créditos de NeverBounce: ${error}`);

      if (error.response) {
        return res.status(error.response.status || 500).json({
          success: false,
          message: 'Error al comunicarse con NeverBounce',
          error: error.response.data?.message || error.message,
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
  }
};

module.exports = configuracionEmailVerificationController;
