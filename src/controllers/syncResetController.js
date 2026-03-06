/**
 * Controller para Reset de Sincronizacion PJN
 * Permite resetear los datos de sincronizacion de un usuario desde la UI de admin
 */
const mongoose = require('mongoose');
const { logger } = require('../config/pino');

// Mapping causaType (del folder) -> coleccion MongoDB
const CAUSA_TYPE_TO_COLLECTION = {
  CausasCivil: "causas-civil",
  CausasComercial: "causas-comercial",
  CausasTrabajo: "causas-trabajo",
  CausasSegSocial: "causas-segsocial",
  CausasSegSoc: "causas-segsocial",
  CausasCAF: "causas_caf",
  CausasCCF: "causas_ccf",
  CausasCPE: "causas_cpe",
  CausasCFP: "causas_cfp",
  CausasCSJ: "causas_csj",
  CausasCCC: "causas_ccc",
  CausasCNE: "causas_cne",
  MEV: "causas-mev"
};

const FOLDER_LINKED_SIZE = 51200; // 50 KB por folder vinculado

/**
 * Analiza los datos de sync del usuario sin modificar nada
 */
async function analyzeSyncData(db, userId, credId) {
  const pjnFolders = await db.collection("folders").find(
    { userId, source: "pjn-login" },
    { projection: { _id: 1, causaId: 1, causaType: 1, archived: 1 } }
  ).toArray();

  const activeFolders = pjnFolders.filter(f => !f.archived).length;
  const archivedFolders = pjnFolders.filter(f => f.archived).length;
  const folderIds = pjnFolders.map(f => f._id);

  const toDelete = {};
  const toUnlink = {};
  let skipped = 0;

  for (const folder of pjnFolders) {
    if (!folder.causaId || !folder.causaType) { skipped++; continue; }
    const collName = CAUSA_TYPE_TO_COLLECTION[folder.causaType];
    if (!collName) { skipped++; continue; }

    const causa = await db.collection(collName).findOne(
      { _id: folder.causaId },
      { projection: { source: 1, linkedCredentials: 1, folderIds: 1 } }
    );
    if (!causa) { skipped++; continue; }

    const otherCreds = (causa.linkedCredentials || []).filter(
      lc => lc.credentialsId?.toString() !== credId.toString()
    );
    const otherFolderIds = (causa.folderIds || []).filter(
      fId => !folderIds.some(pf => pf.toString() === fId.toString())
    );

    const createdBySync = causa.source === "pjn-login";
    const hasOtherLinks = otherCreds.length > 0 || otherFolderIds.length > 0;

    if (createdBySync && !hasOtherLinks) {
      if (!toDelete[collName]) toDelete[collName] = [];
      toDelete[collName].push(folder.causaId);
    } else {
      if (!toUnlink[collName]) toUnlink[collName] = [];
      toUnlink[collName].push(folder.causaId);
    }
  }

  const syncsCount = await db.collection("mis-causas-syncs").countDocuments({ userId });
  const storageDelta = -(pjnFolders.length * FOLDER_LINKED_SIZE);
  const totalToDelete = Object.values(toDelete).reduce((sum, arr) => sum + arr.length, 0);
  const totalToUnlink = Object.values(toUnlink).reduce((sum, arr) => sum + arr.length, 0);

  return {
    credId,
    folders: { total: pjnFolders.length, active: activeFolders, archived: archivedFolders, ids: folderIds },
    causas: { toDelete, toUnlink, totalToDelete, totalToUnlink, skipped },
    syncsCount,
    userStats: { activeFoldersDelta: -activeFolders, totalFoldersDelta: -pjnFolders.length, storageDeltaBytes: storageDelta }
  };
}

/**
 * Ejecuta el reset completo
 */
async function executeReset(db, userId, credId, analysis) {
  const results = { causasUnlinked: 0, causasDeleted: 0, foldersDeleted: 0, syncsDeleted: 0, credentialsReset: false, userStatsAdjusted: false };

  // 1. Desvincular linkedCredentials
  for (const [collName, causaIds] of Object.entries(analysis.causas.toUnlink)) {
    if (causaIds.length === 0) continue;
    const r = await db.collection(collName).updateMany(
      { _id: { $in: causaIds } },
      { $pull: { linkedCredentials: { credentialsId: credId } } }
    );
    results.causasUnlinked += r.modifiedCount;
  }

  // 2. Limpiar folderIds
  const allCausasByCollection = {};
  for (const [collName, ids] of Object.entries(analysis.causas.toDelete)) {
    if (!allCausasByCollection[collName]) allCausasByCollection[collName] = [];
    allCausasByCollection[collName].push(...ids);
  }
  for (const [collName, ids] of Object.entries(analysis.causas.toUnlink)) {
    if (!allCausasByCollection[collName]) allCausasByCollection[collName] = [];
    allCausasByCollection[collName].push(...ids);
  }
  for (const [collName, causaIds] of Object.entries(allCausasByCollection)) {
    if (causaIds.length === 0) continue;
    await db.collection(collName).updateMany(
      { _id: { $in: causaIds } },
      { $pull: { folderIds: { $in: analysis.folders.ids } } }
    );
  }

  // 3. Eliminar causas creadas por sync
  for (const [collName, causaIds] of Object.entries(analysis.causas.toDelete)) {
    if (causaIds.length === 0) continue;
    const r = await db.collection(collName).deleteMany({ _id: { $in: causaIds } });
    results.causasDeleted += r.deletedCount;
  }

  // 4. Eliminar folders
  const foldersResult = await db.collection("folders").deleteMany({ userId, source: "pjn-login" });
  results.foldersDeleted = foldersResult.deletedCount;

  // 5. Eliminar sync records
  const syncsResult = await db.collection("mis-causas-syncs").deleteMany({ userId });
  results.syncsDeleted = syncsResult.deletedCount;

  // 6. Resetear credenciales
  await db.collection("pjn-credentials").updateOne(
    { _id: credId },
    {
      $set: {
        syncStatus: "idle", lastSync: null, lastSyncAttempt: null,
        consecutiveErrors: 0, successfulSyncs: 0, lastError: null,
        currentSyncProgress: null, syncMetadata: null, simulationData: null,
        verified: false, verifiedAt: null, isValid: false, isValidAt: null,
        expectedCausasCount: 0, processedCausasCount: 0, foldersCreatedCount: 0,
        stats: { totalCausasFound: 0, newCausasCreated: 0, foldersCreated: 0, lastCausasCount: 0, byFuero: {}, fromCache: 0, fromScraping: 0 },
        syncHistory: []
      }
    }
  );
  results.credentialsReset = true;

  // 7. Ajustar UserStats
  if (analysis.folders.total > 0) {
    await db.collection("userstats").updateOne(
      { userId },
      [{
        $set: {
          "counts.folders": { $max: [0, { $add: [{ $ifNull: ["$counts.folders", 0] }, analysis.userStats.activeFoldersDelta] }] },
          "counts.foldersTotal": { $max: [0, { $add: [{ $ifNull: ["$counts.foldersTotal", 0] }, analysis.userStats.totalFoldersDelta] }] },
          "storage.total": { $max: [0, { $add: [{ $ifNull: ["$storage.total", 0] }, analysis.userStats.storageDeltaBytes] }] },
          "storage.folders": { $max: [0, { $add: [{ $ifNull: ["$storage.folders", 0] }, analysis.userStats.storageDeltaBytes] }] },
          lastUpdated: new Date()
        }
      }]
    );
    results.userStatsAdjusted = true;
  }

  return results;
}

// ==================== API Controller ====================

const syncResetController = {
  /**
   * POST /api/sync-reset/:userId
   * Body: { dryRun: true|false }
   */
  async resetUserSync(req, res) {
    try {
      const { userId } = req.params;
      const dryRun = req.body.dryRun !== false; // default true

      if (!userId || !/^[a-f\d]{24}$/i.test(userId)) {
        return res.status(400).json({ success: false, message: "userId invalido" });
      }

      const db = mongoose.connection.db;
      const userOid = new mongoose.Types.ObjectId(userId);

      const creds = await db.collection("pjn-credentials").findOne({ userId: userOid });
      if (!creds) {
        return res.status(404).json({ success: false, message: "No se encontraron credenciales PJN para este usuario" });
      }

      const analysis = await analyzeSyncData(db, userOid, creds._id);

      if (dryRun) {
        logger.info(`Sync reset preview para usuario ${userId}: ${analysis.folders.total} folders, ${analysis.causas.totalToDelete} causas a eliminar, ${analysis.causas.totalToUnlink} a desvincular`);

        return res.json({
          success: true,
          message: "Preview del reset de sincronizacion",
          data: {
            userId,
            credentialsId: creds._id.toString(),
            dryRun: true,
            syncStatus: creds.syncStatus,
            folders: { total: analysis.folders.total, active: analysis.folders.active, archived: analysis.folders.archived },
            causas: {
              toDelete: analysis.causas.totalToDelete,
              toUnlink: analysis.causas.totalToUnlink,
              deleteByCollection: Object.fromEntries(Object.entries(analysis.causas.toDelete).map(([k, v]) => [k, v.length])),
              unlinkByCollection: Object.fromEntries(Object.entries(analysis.causas.toUnlink).map(([k, v]) => [k, v.length]))
            },
            syncsToDelete: analysis.syncsCount,
            userStatsAdjustment: analysis.userStats
          }
        });
      }

      // Ejecutar reset
      logger.info(`Ejecutando sync reset para usuario ${userId} (admin: ${req.userId})`);
      const results = await executeReset(db, userOid, creds._id, analysis);

      logger.info(`Sync reset completado para ${userId}: ${results.foldersDeleted} folders, ${results.causasDeleted} causas eliminadas, ${results.causasUnlinked} desvinculadas`);

      res.json({
        success: true,
        message: "Reset de sincronizacion completado",
        data: {
          userId,
          dryRun: false,
          ...results,
          executedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error(`Error en sync reset: ${error.message}`);
      res.status(500).json({ success: false, message: "Error al resetear sincronizacion", error: error.message });
    }
  }
};

module.exports = syncResetController;
