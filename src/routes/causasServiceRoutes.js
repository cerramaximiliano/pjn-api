const express = require('express');
const router = express.Router();
const causaService = require('../service/causasService');
const juzgadosController = require('../controllers/juzgadosController');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

/**
 * Normaliza el causaType recibido a nombre de modelo correcto
 * Acepta múltiples formatos: nombres descriptivos, códigos de fuero, nombres de modelo
 * @param {string} causaType - Tipo de causa en cualquier formato
 * @returns {string|null} - Nombre de modelo normalizado o null si es inválido
 */
function normalizeCausaType(causaType) {
  const causaTypeNormalizationMap = {
    // Nombres descriptivos
    'Civil': 'CausasCivil',
    'Comercial': 'CausasComercial',
    'Seguridad Social': 'CausasSegSocial',
    'Laboral': 'CausasTrabajo',
    'Trabajo': 'CausasTrabajo',
    // Códigos de fuero
    'CIV': 'CausasCivil',
    'COM': 'CausasComercial',
    'CSS': 'CausasSegSocial',
    'CNT': 'CausasTrabajo',
    // Ya normalizados
    'CausasCivil': 'CausasCivil',
    'CausasComercial': 'CausasComercial',
    'CausasSegSocial': 'CausasSegSocial',
    'CausasTrabajo': 'CausasTrabajo'
  };

  return causaTypeNormalizationMap[causaType] || null;
}

/**
 * @swagger
 * tags:
 *   name: CausaService
 *   description: API para gestionar servicios relacionados con causas judiciales
 */

/**
 * @swagger
 * /causas-service/update-status:
 *   patch:
 *     summary: Actualiza el estado de actualización para un usuario específico
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - updateValue
 *             properties:
 *               userId:
 *                 type: string
 *                 description: ID del usuario
 *               updateValue:
 *                 type: boolean
 *                 description: Valor para la propiedad update (true o false)
 *     responses:
 *       200:
 *         description: Estado de actualización modificado correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 updated:
 *                   type: object
 *                   properties:
 *                     civil:
 *                       type: number
 *                     trabajo:
 *                       type: number
 *                     segSocial:
 *                       type: number
 *       400:
 *         description: Datos inválidos
 *       500:
 *         description: Error del servidor
 */
router.patch('/update-status', async (req, res) => {
  try {
    const { userId, updateValue } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'El ID de usuario es requerido' 
      });
    }
    
    // Convertir updateValue a booleano explícitamente
    const boolUpdateValue = updateValue === true || updateValue === 'true';
    
    const result = await causaService.updateCausasUpdateStatus(userId, boolUpdateValue);
    
    res.json({
      success: result.success,
      message: result.success 
        ? `Estado de actualización modificado correctamente a ${boolUpdateValue}` 
        : 'Error al modificar el estado de actualización',
      updated: result.updated
    });
  } catch (error) {
    console.error('Error al actualizar estado:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/update-by-subscriptions:
 *   patch:
 *     summary: Actualiza el estado de actualización considerando usuarios con suscripciones activas
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userIds
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array de IDs de usuarios con suscripciones activas
 *     responses:
 *       200:
 *         description: Estado de actualización modificado correctamente
 *       400:
 *         description: Datos inválidos
 *       500:
 *         description: Error del servidor
 */
router.patch('/update-by-subscriptions', async (req, res) => {
  try {
    const { userIds } = req.body;
    
    if (!userIds || !Array.isArray(userIds)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere un array de IDs de usuarios' 
      });
    }
    
    const result = await causaService.updateCausasBasedOnSubscriptions(userIds);
    
    res.json({
      success: result.success,
      message: result.success 
        ? `Se actualizaron ${result.updated} documentos según las suscripciones activas` 
        : 'Error al actualizar documentos',
      updated: result.updated
    });
  } catch (error) {
    console.error('Error al actualizar estado por suscripciones:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/initialize-updates:
 *   post:
 *     summary: Inicializa el array userUpdatesEnabled para todas las causas
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Inicialización completada correctamente
 *       500:
 *         description: Error del servidor
 */
router.post('/initialize-updates', async (req, res) => {
  try {
    const result = await causaService.initializeUserUpdatesEnabled();
    
    res.json({
      success: result.success,
      message: result.success 
        ? `Se inicializaron ${result.updated} documentos correctamente` 
        : 'Error al inicializar documentos',
      updated: result.updated
    });
  } catch (error) {
    console.error('Error al inicializar estado de updates:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/associate-folder:
 *   post:
 *     summary: Asocia un folder a un documento de causa
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - causaType
 *               - number
 *               - year
 *               - userId
 *               - folderId
 *             properties:
 *               causaType:
 *                 type: string
 *                 enum: [CausasCivil, CausasTrabajo, CausasSegSocial, CausasComercial]
 *                 description: Tipo de causa
 *               number:
 *                 type: string
 *                 description: Número de expediente
 *               year:
 *                 type: string
 *                 description: Año del expediente
 *               userId:
 *                 type: string
 *                 description: ID del usuario
 *               folderId:
 *                 type: string
 *                 description: ID del folder
 *               hasPaidSubscription:
 *                 type: boolean
 *                 description: Indica si el usuario tiene suscripción de pago
 *     responses:
 *       200:
 *         description: Folder asociado correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 created:
 *                   type: boolean
 *                   description: Indica si se creó una nueva causa (true) o se actualizó una existente (false)
 *                 update:
 *                   type: boolean
 *                   description: Indica si la causa requiere actualización
 *                 data:
 *                   type: object
 *       400:
 *         description: Datos inválidos
 *       409:
 *         description: La carpeta ya está asociada a la causa
 *       500:
 *         description: Error del servidor
 */
router.post('/associate-folder', async (req, res) => {
  try {
    let { causaType, number, year, userId, folderId, hasPaidSubscription } = req.body;

    if (!causaType || !number || !year || !userId || !folderId) {
      return res.status(400).json({
        success: false,
        message: 'Todos los campos son requeridos: causaType, number, year, userId, folderId'
      });
    }

    // Normalizar causaType
    const normalizedCausaType = normalizeCausaType(causaType);

    if (!normalizedCausaType) {
      return res.status(400).json({
        success: false,
        message: `Tipo de causa inválido: ${causaType}. Valores aceptados: CIV, COM, CSS, CNT, Civil, Comercial, Seguridad Social, Laboral, Trabajo, CausasCivil, CausasComercial, CausasSegSocial, CausasTrabajo`
      });
    }

    const result = await causaService.associateFolderToCausa(normalizedCausaType, {
      number,
      year,
      userId,
      folderId,
      hasPaidSubscription: !!hasPaidSubscription
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        message: 'Error al asociar folder a la causa'
      });
    }

    res.json({
      success: true,
      message: result.created
        ? 'Nueva causa creada y folder asociado exitosamente'
        : 'Folder asociado exitosamente a causa existente',
      created: result.created,
      update: result.update,
      data: result
    });
  } catch (error) {
    console.error('Error al asociar folder:', error);

    // Manejar error de duplicados específicamente
    if (error.message && error.message.startsWith('DUPLICATE_FOLDER:')) {
      return res.status(409).json({
        success: false,
        message: 'Esta carpeta ya está asociada a la causa',
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/dissociate-folder:
 *   delete:
 *     summary: Desasocia un folder de un documento de causa
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - causaType
 *               - causaId
 *               - folderId
 *               - userId
 *             properties:
 *               causaType:
 *                 type: string
 *                 enum: [CausasCivil, CausasTrabajo, CausasSegSocial, CausasComercial]
 *                 description: Tipo de causa
 *               causaId:
 *                 type: string
 *                 description: ID del documento de causa
 *               folderId:
 *                 type: string
 *                 description: ID del folder a desasociar
 *               userId:
 *                 type: string
 *                 description: ID del usuario
 *     responses:
 *       200:
 *         description: Folder desasociado correctamente
 *       400:
 *         description: Datos inválidos
 *       500:
 *         description: Error del servidor
 */
router.delete('/dissociate-folder', async (req, res) => {
  try {
    let { causaType, causaId, folderId, userId } = req.body;
    console.log(causaType, causaId, folderId, userId)
    if (!causaType || !causaId || !folderId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Todos los campos son requeridos: causaType, causaId, folderId, userId'
      });
    }

    // Normalizar causaType
    const normalizedCausaType = normalizeCausaType(causaType);

    if (!normalizedCausaType) {
      return res.status(400).json({
        success: false,
        message: `Tipo de causa inválido: ${causaType}. Valores aceptados: CIV, COM, CSS, CNT, Civil, Comercial, Seguridad Social, Laboral, Trabajo, CausasCivil, CausasComercial, CausasSegSocial, CausasTrabajo`
      });
    }

    const result = await causaService.dissociateFolderFromCausa(normalizedCausaType, {
      causaId,
      folderId,
      userId
    });
    
    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Error al desasociar folder de la causa'
      });
    }
    
    res.json({
      success: true,
      message: 'Folder desasociado correctamente de la causa'
    });
  } catch (error) {
    console.error('Error al desasociar folder:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/find-by-folder/{causaType}/{folderId}:
 *   get:
 *     summary: Busca una causa que contenga un folder específico
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: causaType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [CausasCivil, CausasTrabajo, CausasSegSocial, CausasComercial]
 *         description: Tipo de causa
 *       - in: path
 *         name: folderId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del folder a buscar
 *     responses:
 *       200:
 *         description: Causa encontrada o respuesta vacía si no existe
 *       400:
 *         description: Datos inválidos
 *       500:
 *         description: Error del servidor
 */
router.get('/find-by-folder/:causaType/:folderId', async (req, res) => {
  try {
    let { causaType, folderId } = req.params;

    if (!causaType || !folderId) {
      return res.status(400).json({
        success: false,
        message: 'Tipo de causa y ID de folder son requeridos'
      });
    }

    // Normalizar causaType
    const normalizedCausaType = normalizeCausaType(causaType);

    if (!normalizedCausaType) {
      return res.status(400).json({
        success: false,
        message: `Tipo de causa inválido: ${causaType}. Valores aceptados: CIV, COM, CSS, CNT, Civil, Comercial, Seguridad Social, Laboral, Trabajo, CausasCivil, CausasComercial, CausasSegSocial, CausasTrabajo`
      });
    }

    const causa = await causaService.findCausaByFolderId(normalizedCausaType, folderId);
    
    res.json({
      success: true,
      message: causa ? 'Causa encontrada' : 'No se encontró causa con este folder',
      data: causa
    });
  } catch (error) {
    console.error('Error al buscar causa por folder:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/causa-type-by-code/{pjnCode}:
 *   get:
 *     summary: Determina qué tipo de causa corresponde según el código PJN
 *     tags: [CausaService]
 *     parameters:
 *       - in: path
 *         name: pjnCode
 *         required: true
 *         schema:
 *           type: string
 *         description: Código PJN
 *     responses:
 *       200:
 *         description: Tipo de causa correspondiente
 *       400:
 *         description: Datos inválidos
 */
router.get('/causa-type-by-code/:pjnCode', async (req, res) => {
  try {
    const { pjnCode } = req.params;
    
    if (!pjnCode) {
      return res.status(400).json({ 
        success: false, 
        message: 'Código PJN es requerido' 
      });
    }
    
    const causaType = causaService.getCausaTypeByPjnCode(pjnCode);
    
    res.json({
      success: !!causaType,
      message: causaType ? `Código PJN ${pjnCode} corresponde a ${causaType}` : `Código PJN ${pjnCode} no corresponde a ningún tipo de causa`,
      data: { causaType }
    });
  } catch (error) {
    console.error('Error al determinar tipo de causa:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/migrate-array-fields/{causaType}:
 *   post:
 *     summary: Migra documentos para asegurar que folderIds y userCausaIds sean arrays
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: causaType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [CausasCivil, CausasTrabajo, CausasSegSocial, CausasComercial]
 *         description: Tipo de causa
 *     responses:
 *       200:
 *         description: Migración completada correctamente
 *       400:
 *         description: Datos inválidos
 *       500:
 *         description: Error del servidor
 */
router.post('/migrate-array-fields/:causaType', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { causaType } = req.params;
    
    if (!causaType) {
      return res.status(400).json({ 
        success: false, 
        message: 'Tipo de causa es requerido' 
      });
    }
    
    const result = await causaService.migrateArrayFields(causaType);
    
    res.json({
      success: result.success,
      message: result.success 
        ? `Se migraron ${result.count} documentos correctamente` 
        : 'Error al migrar documentos',
      count: result.count
    });
  } catch (error) {
    console.error('Error al migrar documentos:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/migrate-fuero-codes:
 *   post:
 *     summary: Migra el campo fuero de nombres descriptivos a códigos (CIV, COM, CSS, CNT)
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Migración completada correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 updated:
 *                   type: object
 *                   properties:
 *                     civil:
 *                       type: number
 *                     comercial:
 *                       type: number
 *                     segSocial:
 *                       type: number
 *                     trabajo:
 *                       type: number
 *                 total:
 *                   type: number
 *       500:
 *         description: Error del servidor
 */
router.post('/migrate-fuero-codes', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const mongoose = require('mongoose');

    const causaTypes = [
      { model: 'CausasCivil', correctCode: 'CIV', wrongValues: ['Civil', 'civil', 'CIVIL'] },
      { model: 'CausasComercial', correctCode: 'COM', wrongValues: ['Comercial', 'comercial', 'COMERCIAL'] },
      { model: 'CausasSegSocial', correctCode: 'CSS', wrongValues: ['Seguridad Social', 'seguridad social', 'SEGURIDAD SOCIAL', 'SS', 'ss'] },
      { model: 'CausasTrabajo', correctCode: 'CNT', wrongValues: ['Laboral', 'laboral', 'LABORAL', 'Trabajo', 'trabajo', 'TRABAJO'] }
    ];

    const results = {
      civil: 0,
      comercial: 0,
      segSocial: 0,
      trabajo: 0
    };

    for (const causaType of causaTypes) {
      if (!mongoose.models[causaType.model]) {
        console.error(`Modelo ${causaType.model} no encontrado`);
        continue;
      }

      const CausaModel = mongoose.model(causaType.model);

      // Actualizar documentos que tienen valores incorrectos
      const updateResult = await CausaModel.updateMany(
        { fuero: { $in: causaType.wrongValues } },
        { $set: { fuero: causaType.correctCode } }
      );

      const count = updateResult.modifiedCount || 0;

      switch (causaType.model) {
        case 'CausasCivil':
          results.civil = count;
          break;
        case 'CausasComercial':
          results.comercial = count;
          break;
        case 'CausasSegSocial':
          results.segSocial = count;
          break;
        case 'CausasTrabajo':
          results.trabajo = count;
          break;
      }

      console.log(`Migrados ${count} documentos de ${causaType.model} a fuero: ${causaType.correctCode}`);
    }

    const total = results.civil + results.comercial + results.segSocial + results.trabajo;

    res.json({
      success: true,
      message: `Migración completada. Total de documentos actualizados: ${total}`,
      updated: results,
      total: total
    });
  } catch (error) {
    console.error('Error al migrar códigos de fuero:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /causas-service/juzgados/codigo/{codigo}:
 *   get:
 *     summary: Busca juzgados por código con filtros opcionales
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: codigo
 *         required: true
 *         schema:
 *           type: string
 *         description: Código del juzgado (obligatorio)
 *       - in: query
 *         name: jurisdiccion
 *         schema:
 *           type: string
 *         description: Filtrar por jurisdicción
 *       - in: query
 *         name: ciudad
 *         schema:
 *           type: string
 *         description: Filtrar por ciudad
 *       - in: query
 *         name: organismo
 *         schema:
 *           type: string
 *         description: Filtrar por organismo
 *       - in: query
 *         name: datosCompletos
 *         schema:
 *           type: boolean
 *         description: Filtrar por juzgados con datos completos
 *     responses:
 *       200:
 *         description: Juzgados encontrados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 count:
 *                   type: number
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Código es obligatorio
 *       404:
 *         description: No se encontraron juzgados
 *       500:
 *         description: Error del servidor
 */
router.get('/juzgados/codigo/:codigo', verifyToken, juzgadosController.findByCodigo);

/**
 * @swagger
 * /causas-service/juzgados:
 *   get:
 *     summary: Obtiene todos los juzgados con filtros y paginación
 *     tags: [CausaService]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: jurisdiccion
 *         schema:
 *           type: string
 *         description: Filtrar por jurisdicción
 *       - in: query
 *         name: ciudad
 *         schema:
 *           type: string
 *         description: Filtrar por ciudad
 *       - in: query
 *         name: organismo
 *         schema:
 *           type: string
 *         description: Filtrar por organismo
 *       - in: query
 *         name: datosCompletos
 *         schema:
 *           type: boolean
 *         description: Filtrar por juzgados con datos completos
 *       - in: query
 *         name: page
 *         schema:
 *           type: number
 *           default: 1
 *         description: Número de página
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *           default: 20
 *         description: Cantidad de resultados por página
 *     responses:
 *       200:
 *         description: Juzgados encontrados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 count:
 *                   type: number
 *                 total:
 *                   type: number
 *                 page:
 *                   type: number
 *                 pages:
 *                   type: number
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: Error del servidor
 */
router.get('/juzgados', verifyToken, juzgadosController.findAll);

module.exports = router;