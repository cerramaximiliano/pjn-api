const mongoose = require("mongoose");

/**
 * Servicio para gestionar operaciones relacionadas con documentos de causas
 */
const causaService = {
    /**
     * Actualiza el estado de actualización para un usuario específico
     * @param {string} userId - ID del usuario
     * @param {boolean} updateValue - Valor para la propiedad update (true o false)
     * @returns {Promise<{success: boolean, updated: {civil: number, trabajo: number, segSocial: number}}>} - Resultado de la operación
     */
    async updateCausasUpdateStatus(userId, updateValue) {
        try {
            const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
                ? new mongoose.Types.ObjectId(userId) 
                : userId;
            
            const causaTypes = ['CausasCivil', 'CausasTrabajo', 'CausasSegSocial'];
            const results = {
                success: true,
                updated: {
                    civil: 0,
                    trabajo: 0,
                    segSocial: 0
                }
            };
            
            for (const causaType of causaTypes) {
                try {
                    if (!mongoose.models[causaType]) {
                        console.error(`Modelo ${causaType} no encontrado`);
                        continue;
                    }
                    
                    const CausaModel = mongoose.model(causaType);
                    
                    // Obtener todas las causas del usuario
                    const causasDelUsuario = await CausaModel.find({ userCausaIds: userIdObj });
                    let causasActualizadas = 0;
                    
                    for (const causa of causasDelUsuario) {
                        // Verificar si ya existe una entrada para el usuario
                        const userEntryIndex = causa.userUpdatesEnabled.findIndex(entry => 
                            entry.userId.toString() === userIdObj.toString()
                        );
                        
                        if (userEntryIndex !== -1) {
                            // Actualizar entrada existente
                            causa.userUpdatesEnabled[userEntryIndex].enabled = updateValue;
                        } else {
                            // Crear nueva entrada
                            causa.userUpdatesEnabled.push({
                                userId: userIdObj,
                                enabled: updateValue
                            });
                        }
                        
                        // Actualizar el campo update global basado en todos los usuarios
                        const alMenosUnUsuarioRequiereActualizacion = causa.userUpdatesEnabled.some(entry => entry.enabled);
                        causa.update = alMenosUnUsuarioRequiereActualizacion;
                        
                        await causa.save();
                        causasActualizadas++;
                    }
                    
                    // Registrar la cantidad de documentos actualizados
                    switch (causaType) {
                        case 'CausasCivil':
                            results.updated.civil = causasActualizadas;
                            break;
                        case 'CausasTrabajo':
                            results.updated.trabajo = causasActualizadas;
                            break;
                        case 'CausasSegSocial':
                            results.updated.segSocial = causasActualizadas;
                            break;
                    }
                    
                    console.log(`Actualizado estado de actualización a ${updateValue} para ${causasActualizadas} causas de tipo ${causaType} del usuario ${userId}`);
                } catch (error) {
                    console.error(`Error al actualizar estado de update en ${causaType}:`, error);
                    results.success = false;
                }
            }
            
            return results;
        } catch (error) {
            console.error(`Error general al actualizar estado de update:`, error);
            return { success: false, updated: { civil: 0, trabajo: 0, segSocial: 0 } };
        }
    },
    
    /**
     * Actualiza el estado de actualización considerando usuarios con suscripciones activas
     * @param {Array<string>} userIds - Array de IDs de usuarios con suscripciones activas
     * @returns {Promise<{success: boolean, updated: number}>} - Resultado de la operación
     */
    async updateCausasBasedOnSubscriptions(userIds) {
        try {
            const causaTypes = ['CausasCivil', 'CausasTrabajo', 'CausasSegSocial'];
            let totalUpdated = 0;
            
            // Convertir IDs a ObjectId si es necesario
            const userObjectIds = userIds.map(id => 
                mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
            );
            
            for (const causaType of causaTypes) {
                try {
                    if (!mongoose.models[causaType]) {
                        console.error(`Modelo ${causaType} no encontrado`);
                        continue;
                    }
                    
                    const CausaModel = mongoose.model(causaType);
                    
                    // Obtener todas las causas
                    const todasLasCausas = await CausaModel.find({});
                    let causasActualizadas = 0;
                    
                    for (const causa of todasLasCausas) {
                        let actualizado = false;
                        
                        // Verificar todos los usuarios asociados a esta causa
                        for (const usuarioId of causa.userCausaIds) {
                            const esUsuarioActivo = userObjectIds.some(id => 
                                id.toString() === usuarioId.toString()
                            );
                            
                            // Buscar si ya existe una entrada para este usuario
                            const userEntryIndex = causa.userUpdatesEnabled.findIndex(entry => 
                                entry.userId.toString() === usuarioId.toString()
                            );
                            
                            if (userEntryIndex !== -1) {
                                // Actualizar la entrada existente
                                if (causa.userUpdatesEnabled[userEntryIndex].enabled !== esUsuarioActivo) {
                                    causa.userUpdatesEnabled[userEntryIndex].enabled = esUsuarioActivo;
                                    actualizado = true;
                                }
                            } else {
                                // Crear una nueva entrada
                                causa.userUpdatesEnabled.push({
                                    userId: usuarioId,
                                    enabled: esUsuarioActivo
                                });
                                actualizado = true;
                            }
                        }
                        
                        // Actualizar el campo update global basado en todos los usuarios
                        const valorAnterior = causa.update;
                        const alMenosUnUsuarioRequiereActualizacion = causa.userUpdatesEnabled.some(entry => entry.enabled);
                        
                        if (valorAnterior !== alMenosUnUsuarioRequiereActualizacion || actualizado) {
                            causa.update = alMenosUnUsuarioRequiereActualizacion;
                            await causa.save();
                            causasActualizadas++;
                        }
                    }
                    
                    totalUpdated += causasActualizadas;
                    console.log(`Actualizadas ${causasActualizadas} causas de tipo ${causaType} según suscripciones activas`);
                    
                } catch (error) {
                    console.error(`Error al procesar ${causaType}:`, error);
                }
            }
            
            return { success: true, updated: totalUpdated };
        } catch (error) {
            console.error(`Error general al actualizar causas basado en suscripciones:`, error);
            return { success: false, updated: 0 };
        }
    },
    
    /**
     * Inicializa el array userUpdatesEnabled para todas las causas
     * Útil para migrar datos existentes cuando se agrega el nuevo campo
     * @returns {Promise<{success: boolean, updated: number}>} - Resultado de la operación
     */
    async initializeUserUpdatesEnabled() {
        try {
            const causaTypes = ['CausasCivil', 'CausasTrabajo', 'CausasSegSocial'];
            let totalUpdated = 0;
            
            for (const causaType of causaTypes) {
                try {
                    if (!mongoose.models[causaType]) {
                        console.error(`Modelo ${causaType} no encontrado`);
                        continue;
                    }
                    
                    const CausaModel = mongoose.model(causaType);
                    const causas = await CausaModel.find({
                        $or: [
                            { userUpdatesEnabled: { $exists: false } },
                            { userUpdatesEnabled: { $eq: [] } }
                        ]
                    });
                    
                    let causasActualizadas = 0;
                    
                    for (const causa of causas) {
                        // Inicializar userUpdatesEnabled según el valor actual de update
                        causa.userUpdatesEnabled = causa.userCausaIds.map(userId => ({
                            userId: userId,
                            enabled: causa.update || true // Por defecto habilitado o según el valor actual
                        }));
                        
                        await causa.save();
                        causasActualizadas++;
                    }
                    
                    totalUpdated += causasActualizadas;
                    console.log(`Inicializadas ${causasActualizadas} causas de tipo ${causaType}`);
                    
                } catch (error) {
                    console.error(`Error al inicializar ${causaType}:`, error);
                }
            }
            
            return { success: true, updated: totalUpdated };
        } catch (error) {
            console.error(`Error general al inicializar userUpdatesEnabled:`, error);
            return { success: false, updated: 0 };
        }
    },
    
    /**
     * Asocia un folder a un documento de causa
     * @param {string} causaType - Tipo de causa (CausasCivil, CausasTrabajo, CausasSegSocial)
     * @param {Object} params - Parámetros para la operación
     * @param {string} params.number - Número de expediente
     * @param {string} params.year - Año del expediente
     * @param {string} params.userId - ID del usuario
     * @param {string} params.folderId - ID del folder
     * @param {boolean} [params.hasPaidSubscription] - Indica si el usuario tiene suscripción de pago
     * @returns {Promise<{causaId: string, causaType: string}>} - ID y tipo de la causa creada/actualizada
     */
    async associateFolderToCausa(causaType, { number, year, userId, folderId, hasPaidSubscription = false }) {
        try {
            if (!mongoose.models[causaType]) {
                throw new Error(`Modelo ${causaType} no encontrado`);
            }

            const CausaModel = mongoose.model(causaType);
            
            // Aseguramos que los IDs sean ObjectId
            const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
                ? new mongoose.Types.ObjectId(userId) 
                : userId;
                
            const folderIdObj = mongoose.Types.ObjectId.isValid(folderId) 
                ? new mongoose.Types.ObjectId(folderId) 
                : folderId;

            // Buscar si existe un documento con el mismo número y año
            let causa = await CausaModel.findOne({
                number: number,
                year: year
            });

            if (causa) {
                // Asegurarnos de que folderIds y userCausaIds sean arrays
                if (!Array.isArray(causa.folderIds)) {
                    causa.folderIds = [];
                }
                
                if (!Array.isArray(causa.userCausaIds)) {
                    causa.userCausaIds = [];
                }
                
                if (!Array.isArray(causa.userUpdatesEnabled)) {
                    causa.userUpdatesEnabled = [];
                }
                
                // Verificar si ya existe el folderIds para evitar duplicados
                const folderExists = causa.folderIds.some(id => 
                    id.toString() === folderIdObj.toString()
                );
                
                if (!folderExists) {
                    causa.folderIds.push(folderIdObj);
                }
                
                // Verificar si ya existe el userCausaIds para evitar duplicados
                const userExists = causa.userCausaIds.some(id => 
                    id.toString() === userIdObj.toString()
                );
                
                if (!userExists) {
                    causa.userCausaIds.push(userIdObj);
                }
                
                // Actualizar o agregar entrada en userUpdatesEnabled
                const userEntryIndex = causa.userUpdatesEnabled.findIndex(entry => 
                    entry.userId && entry.userId.toString() === userIdObj.toString()
                );
                
                if (userEntryIndex !== -1) {
                    // Si el estado actual es true o hasPaidSubscription es true, mantener enabled=true
                    causa.userUpdatesEnabled[userEntryIndex].enabled = 
                        causa.userUpdatesEnabled[userEntryIndex].enabled || hasPaidSubscription;
                } else {
                    // Crear nueva entrada según la suscripción
                    causa.userUpdatesEnabled.push({
                        userId: userIdObj,
                        enabled: hasPaidSubscription
                    });
                }
                
                // Actualizar el campo update global basado en todos los usuarios
                const alMenosUnUsuarioRequiereActualizacion = causa.userUpdatesEnabled.some(entry => entry.enabled);
                causa.update = alMenosUnUsuarioRequiereActualizacion;
                
                causa.source = "app";

                await causa.save();
                
                console.log(`Causa ${causaType} actualizada con folderIds:`, causa.folderIds);
            } else {
                // Crear nuevo documento asegurando que los arrays se inicialicen correctamente
                causa = await CausaModel.create({
                    number: number,
                    year: year,
                    userCausaIds: [userIdObj],
                    folderIds: [folderIdObj],
                    source: "app",
                    verified: false,
                    update: hasPaidSubscription,
                    userUpdatesEnabled: [{
                        userId: userIdObj,
                        enabled: hasPaidSubscription
                    }]
                });
                
                console.log(`Nueva causa ${causaType} creada con folderIds:`, causa.folderIds);
            }

            // Calcular fecha más antigua si la causa está verificada y válida
            let fechaInicio = null;
            if (causa.verified && causa.isValid && causa.movimiento && Array.isArray(causa.movimiento) && causa.movimiento.length > 0) {
                const fechas = causa.movimiento
                    .filter(mov => mov.fecha)
                    .map(mov => new Date(mov.fecha))
                    .filter(fecha => !isNaN(fecha.getTime()));
                
                if (fechas.length > 0) {
                    fechaInicio = new Date(Math.min(...fechas));
                }
            }

            return {
                causaId: causa._id,
                causaType: causaType,
                verified: causa.verified || false,
                ...(causa.verified && { isValid: causa.isValid || false }),
                ...(causa.caratula && { caratula: causa.caratula }),
                ...(causa.objeto && { objeto: causa.objeto }),
                ...(causa.juzgado && { juzgado: causa.juzgado }),
                ...(causa.secretaria && { secretaria: causa.secretaria }),
                ...(fechaInicio && { fechaInicio: fechaInicio })
            };
        } catch (error) {
            console.error(`Error al procesar ${causaType}:`, error);
            return null;
        }
    },

    /**
     * Desasocia un folder de un documento de causa
     * @param {string} causaType - Tipo de causa (CausasCivil, CausasTrabajo, CausasSegSocial)
     * @param {Object} params - Parámetros para la operación
     * @param {string} params.causaId - ID del documento de causa
     * @param {string} params.folderId - ID del folder a desasociar
     * @param {string} params.userId - ID del usuario
     * @returns {Promise<boolean>} - true si la operación tuvo éxito
     */
    async dissociateFolderFromCausa(causaType, { causaId, folderId, userId }) {
        try {
            if (!mongoose.models[causaType]) {
                throw new Error(`Modelo ${causaType} no encontrado`);
            }

            const CausaModel = mongoose.model(causaType);
            
            // Aseguramos que los IDs sean ObjectId
            const causaIdObj = mongoose.Types.ObjectId.isValid(causaId) 
                ? new mongoose.Types.ObjectId(causaId) 
                : causaId;
                
            const folderIdObj = mongoose.Types.ObjectId.isValid(folderId) 
                ? new mongoose.Types.ObjectId(folderId) 
                : folderId;
                
            const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
                ? new mongoose.Types.ObjectId(userId) 
                : userId;

            // Primero obtenemos el documento para verificar la estructura
            const causa = await CausaModel.findById(causaIdObj);
            
            if (!causa) {
                console.log(`Causa ${causaType} con ID ${causaId} no encontrada`);
                return false;
            }
            
            // Aseguramos que folderIds y userCausaIds sean arrays
            if (!Array.isArray(causa.folderIds)) {
                causa.folderIds = [];
                await causa.save();
                console.log(`Campo folderIds inicializado como array en causa ${causaType}`);
            }
            
            if (!Array.isArray(causa.userCausaIds)) {
                causa.userCausaIds = [];
                await causa.save();
                console.log(`Campo userCausaIds inicializado como array en causa ${causaType}`);
            }
            
            if (!Array.isArray(causa.userUpdatesEnabled)) {
                causa.userUpdatesEnabled = [];
                await causa.save();
                console.log(`Campo userUpdatesEnabled inicializado como array en causa ${causaType}`);
            }
            
            // Eliminamos solo la referencia específica del folder que coincide con folderIdObj
            causa.folderIds = causa.folderIds.filter(id => 
                id.toString() !== folderIdObj.toString()
            );
            
            // Eliminamos solo la referencia específica del usuario que coincide con userIdObj
            causa.userCausaIds = causa.userCausaIds.filter(id => 
                id.toString() !== userIdObj.toString()
            );
            
            // Eliminamos la entrada del usuario en userUpdatesEnabled
            causa.userUpdatesEnabled = causa.userUpdatesEnabled.filter(entry => 
                entry.userId && entry.userId.toString() !== userIdObj.toString()
            );
            
            // Actualizar el campo update global basado en los usuarios restantes
            const alMenosUnUsuarioRequiereActualizacion = causa.userUpdatesEnabled.some(entry => entry.enabled);
            causa.update = alMenosUnUsuarioRequiereActualizacion;
            
            await causa.save();
            console.log(`Referencias específicas eliminadas de causa ${causaType}. FolderIds restantes:`, causa.folderIds);

            // Ya no eliminamos el documento aunque no tenga folders asociados
            
            return true;
        } catch (error) {
            console.error(`Error al desasociar folder de ${causaType}:`, error);
            return false;
        }
    },
    
    /**
     * Busca una causa que contenga un folder específico
     * @param {string} causaType - Tipo de causa (CausasCivil, CausasTrabajo, CausasSegSocial)
     * @param {string} folderId - ID del folder a buscar
     * @returns {Promise<Object|null>} - Documento de causa o null si no se encuentra
     */
    async findCausaByFolderId(causaType, folderId) {
        try {
            if (!mongoose.models[causaType]) {
                throw new Error(`Modelo ${causaType} no encontrado`);
            }

            const CausaModel = mongoose.model(causaType);
            
            // Aseguramos que el ID sea un ObjectId
            const folderIdObj = mongoose.Types.ObjectId.isValid(folderId) 
                ? new mongoose.Types.ObjectId(folderId) 
                : folderId;
            
            // Búsqueda usando diferentes métodos para mayor compatibilidad
            let causa = await CausaModel.findOne({
                folderIds: folderIdObj
            });
            
            if (!causa) {
                causa = await CausaModel.findOne({
                    folderIds: folderId.toString()
                });
            }
            
            if (!causa) {
                // Búsqueda alternativa recorriendo todos los documentos
                // Útil cuando hay problemas de tipo en los IDs almacenados
                const allCausas = await CausaModel.find({});
                causa = allCausas.find(doc => 
                    Array.isArray(doc.folderIds) && 
                    doc.folderIds.some(id => id.toString() === folderIdObj.toString())
                );
            }
            
            if (causa) {
                console.log(`Causa ${causaType} encontrada con folderIds:`, causa.folderIds);
            } else {
                console.log(`No se encontró causa ${causaType} con folderId: ${folderId}`);
            }
            
            return causa;
        } catch (error) {
            console.error(`Error al buscar causa por folderId en ${causaType}:`, error);
            return null;
        }
    },

    /**
     * Determina qué tipo de causa corresponde según el código PJN
     * @param {string} pjnCode - Código PJN
     * @returns {string|null} - Tipo de causa o null si no corresponde
     */
    getCausaTypeByPjnCode(pjnCode) {
        switch (pjnCode) {
            case "1":
                return "CausasCivil";
            case "7":
                return "CausasTrabajo";
            case "5":
                return "CausasSegSocial";
            default:
                return null;
        }
    },
    
    /**
     * Migra documentos para asegurar que folderIds y userCausaIds sean arrays
     * @param {string} causaType - Tipo de causa (CausasCivil, CausasTrabajo, CausasSegSocial)
     * @returns {Promise<{success: boolean, count: number}>} - Resultado de la migración
     */
    async migrateArrayFields(causaType) {
        try {
            if (!mongoose.models[causaType]) {
                throw new Error(`Modelo ${causaType} no encontrado`);
            }

            const CausaModel = mongoose.model(causaType);
            const causas = await CausaModel.find({});
            let updatedCount = 0;
            
            for (const causa of causas) {
                let needsUpdate = false;
                
                if (!Array.isArray(causa.folderIds)) {
                    causa.folderIds = [];
                    needsUpdate = true;
                }
                
                if (!Array.isArray(causa.userCausaIds)) {
                    causa.userCausaIds = [];
                    needsUpdate = true;
                }
                
                if (needsUpdate) {
                    await causa.save();
                    updatedCount++;
                }
            }
            
            console.log(`Migración completada para ${causaType}: ${updatedCount} documentos actualizados`);
            return { success: true, count: updatedCount };
        } catch (error) {
            console.error(`Error al migrar documentos de ${causaType}:`, error);
            return { success: false, count: 0 };
        }
    }
};

module.exports = causaService;