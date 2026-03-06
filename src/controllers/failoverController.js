/**
 * Controller para el estado del sistema de failover cloud
 */
const mongoose = require("mongoose");
const { logger } = require("../config/pino");

// GET /api/failover/status
exports.getStatus = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const [state, leaderLock, managerStatus, cloudStatus] = await Promise.all([
      db.collection("scraping-failover-state").findOne({ _id: "state" }),
      db.collection("scraping-failover-state").findOne({ _id: "leader-lock" }),
      db.collection("scraping-manager-state").findOne({ _id: "manager-status" }),
      db.collection("scraping-manager-state").findOne({ _id: "cloud-status" }),
    ]);

    const msSinceLastPoll = managerStatus?.lastPoll
      ? Date.now() - new Date(managerStatus.lastPoll).getTime()
      : null;

    res.json({
      success: true,
      data: {
        cloudActive: state?.cloudActive ?? false,
        activatedAt: state?.activatedAt ?? null,
        deactivatedAt: state?.deactivatedAt ?? null,
        reason: state?.reason ?? null,
        updatedAt: state?.updatedAt ?? null,
        leaderLock: leaderLock
          ? {
              lockedBy: leaderLock.lockedBy,
              acquiredAt: leaderLock.acquiredAt,
              expiresAt: leaderLock.expiresAt,
              priority: leaderLock.priority,
            }
          : null,
        heartbeat: {
          lastPoll: managerStatus?.lastPoll ?? null,
          msSinceLastPoll,
          alive: msSinceLastPoll !== null && msSinceLastPoll < 5 * 60 * 1000,
        },
        cloudTasks: cloudStatus?.runningTasks ?? [],
        cloudTasksTotal: cloudStatus?.totalTasks ?? 0,
        cloudStatusUpdatedAt: cloudStatus?.updatedAt ?? null,
      },
    });
  } catch (error) {
    logger.error(`Error obteniendo estado de failover: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/failover/history
exports.getHistory = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const state = await db
      .collection("scraping-failover-state")
      .findOne({ _id: "state" }, { projection: { history: 1 } });

    const history = (state?.history ?? []).slice().reverse();
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error(`Error obteniendo historial de failover: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
