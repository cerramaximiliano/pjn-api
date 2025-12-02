const Server = require("../models/server");
const { logger } = require("../config/pino");

const serverController = {
  /**
   * Crear un nuevo servidor
   * POST /servers
   */
  async create(req, res) {
    try {
      const serverData = req.body;

      // Agregar usuario que crea el registro
      if (req.userId) {
        serverData.createdBy = req.userId;
      }

      const server = new Server(serverData);
      await server.save();

      logger.info(`Server created: ${server.name} (${server._id})`);

      res.status(201).json({
        success: true,
        message: "Servidor creado exitosamente",
        data: server,
      });
    } catch (error) {
      logger.error(`Error creating server: ${error.message}`);

      if (error.name === "ValidationError") {
        return res.status(400).json({
          success: false,
          message: "Error de validación",
          error: error.message,
        });
      }

      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "Ya existe un servidor con ese slug",
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error al crear servidor",
        error: error.message,
      });
    }
  },

  /**
   * Obtener todos los servidores con paginación y filtros
   * GET /servers
   */
  async findAll(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        type,
        subtype,
        status,
        tags,
        search,
        sortBy = "priority",
        sortOrder = "desc",
        isPublic,
      } = req.query;

      const query = {};

      // Filtros
      if (type) query.type = type;
      if (subtype) query.subtype = subtype;
      if (status) query.status = status;
      if (isPublic !== undefined) query.isPublic = isPublic === "true";

      // Filtro por tags (puede ser string o array)
      if (tags) {
        const tagsArray = Array.isArray(tags) ? tags : tags.split(",");
        query.tags = { $in: tagsArray };
      }

      // Búsqueda por texto en nombre y descripción
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { slug: { $regex: search, $options: "i" } },
        ];
      }

      // Ordenamiento
      const sort = {};
      sort[sortBy] = sortOrder === "asc" ? 1 : -1;

      // Paginación
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [servers, total] = await Promise.all([
        Server.find(query)
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .select("-credentials.password -credentials.apiKey -credentials.token"),
        Server.countDocuments(query),
      ]);

      const pages = Math.ceil(total / parseInt(limit));

      res.json({
        success: true,
        message: "Servidores obtenidos exitosamente",
        count: servers.length,
        total,
        page: parseInt(page),
        pages,
        data: servers,
      });
    } catch (error) {
      logger.error(`Error fetching servers: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener servidores",
        error: error.message,
      });
    }
  },

  /**
   * Obtener un servidor por ID
   * GET /servers/:id
   */
  async findById(req, res) {
    try {
      const { id } = req.params;
      const { includeCredentials } = req.query;

      let query = Server.findById(id);

      // Por defecto no incluir campos sensibles de credenciales
      if (includeCredentials !== "true") {
        query = query.select(
          "-credentials.password -credentials.apiKey -credentials.token"
        );
      }

      const server = await query;

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      res.json({
        success: true,
        message: "Servidor obtenido exitosamente",
        data: server,
      });
    } catch (error) {
      logger.error(`Error fetching server by ID: ${error.message}`);

      if (error.name === "CastError") {
        return res.status(400).json({
          success: false,
          message: "ID de servidor inválido",
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error al obtener servidor",
        error: error.message,
      });
    }
  },

  /**
   * Obtener un servidor por slug
   * GET /servers/slug/:slug
   */
  async findBySlug(req, res) {
    try {
      const { slug } = req.params;
      const { includeCredentials } = req.query;

      let query = Server.findOne({ slug: slug.toLowerCase() });

      if (includeCredentials !== "true") {
        query = query.select(
          "-credentials.password -credentials.apiKey -credentials.token"
        );
      }

      const server = await query;

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      res.json({
        success: true,
        message: "Servidor obtenido exitosamente",
        data: server,
      });
    } catch (error) {
      logger.error(`Error fetching server by slug: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener servidor",
        error: error.message,
      });
    }
  },

  /**
   * Actualizar un servidor por ID
   * PUT /servers/:id
   */
  async updateById(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      // Agregar usuario que actualiza
      if (req.userId) {
        updateData.updatedBy = req.userId;
      }

      // No permitir cambiar ciertos campos directamente
      delete updateData._id;
      delete updateData.createdAt;
      delete updateData.createdBy;

      const server = await Server.findByIdAndUpdate(
        id,
        { $set: updateData },
        { new: true, runValidators: true }
      ).select("-credentials.password -credentials.apiKey -credentials.token");

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      logger.info(`Server updated: ${server.name} (${server._id})`);

      res.json({
        success: true,
        message: "Servidor actualizado exitosamente",
        data: server,
      });
    } catch (error) {
      logger.error(`Error updating server: ${error.message}`);

      if (error.name === "ValidationError") {
        return res.status(400).json({
          success: false,
          message: "Error de validación",
          error: error.message,
        });
      }

      if (error.name === "CastError") {
        return res.status(400).json({
          success: false,
          message: "ID de servidor inválido",
          error: error.message,
        });
      }

      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "Ya existe un servidor con ese slug",
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error al actualizar servidor",
        error: error.message,
      });
    }
  },

  /**
   * Actualización parcial de un servidor (PATCH)
   * PATCH /servers/:id
   */
  async patchById(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      if (req.userId) {
        updateData.updatedBy = req.userId;
      }

      delete updateData._id;
      delete updateData.createdAt;
      delete updateData.createdBy;

      const server = await Server.findByIdAndUpdate(
        id,
        { $set: updateData },
        { new: true, runValidators: true }
      ).select("-credentials.password -credentials.apiKey -credentials.token");

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      logger.info(`Server patched: ${server.name} (${server._id})`);

      res.json({
        success: true,
        message: "Servidor actualizado exitosamente",
        data: server,
      });
    } catch (error) {
      logger.error(`Error patching server: ${error.message}`);

      if (error.name === "ValidationError") {
        return res.status(400).json({
          success: false,
          message: "Error de validación",
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error al actualizar servidor",
        error: error.message,
      });
    }
  },

  /**
   * Eliminar un servidor por ID
   * DELETE /servers/:id
   */
  async deleteById(req, res) {
    try {
      const { id } = req.params;

      const server = await Server.findByIdAndDelete(id);

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      logger.info(`Server deleted: ${server.name} (${server._id})`);

      res.json({
        success: true,
        message: "Servidor eliminado exitosamente",
        data: { id: server._id, name: server.name },
      });
    } catch (error) {
      logger.error(`Error deleting server: ${error.message}`);

      if (error.name === "CastError") {
        return res.status(400).json({
          success: false,
          message: "ID de servidor inválido",
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error al eliminar servidor",
        error: error.message,
      });
    }
  },

  /**
   * Obtener servidores por tipo
   * GET /servers/type/:type
   */
  async findByType(req, res) {
    try {
      const { type } = req.params;
      const { status = "active", limit = 50 } = req.query;

      const query = { type };
      if (status !== "all") query.status = status;

      const servers = await Server.find(query)
        .sort({ priority: -1 })
        .limit(parseInt(limit))
        .select("-credentials.password -credentials.apiKey -credentials.token");

      res.json({
        success: true,
        message: `Servidores de tipo '${type}' obtenidos exitosamente`,
        count: servers.length,
        data: servers,
      });
    } catch (error) {
      logger.error(`Error fetching servers by type: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener servidores",
        error: error.message,
      });
    }
  },

  /**
   * Obtener servidores por tags
   * GET /servers/tags/:tags
   */
  async findByTags(req, res) {
    try {
      const { tags } = req.params;
      const { status, type, limit = 50 } = req.query;

      const tagsArray = tags.split(",").map((t) => t.trim());

      const servers = await Server.findByTags(tagsArray, { status, type })
        .limit(parseInt(limit))
        .select("-credentials.password -credentials.apiKey -credentials.token");

      res.json({
        success: true,
        message: `Servidores con tags obtenidos exitosamente`,
        count: servers.length,
        tags: tagsArray,
        data: servers,
      });
    } catch (error) {
      logger.error(`Error fetching servers by tags: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener servidores",
        error: error.message,
      });
    }
  },

  /**
   * Actualizar estado de un servidor
   * PATCH /servers/:id/status
   */
  async updateStatus(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (
        !status ||
        !["active", "inactive", "maintenance", "deprecated", "error"].includes(
          status
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Estado inválido. Debe ser: active, inactive, maintenance, deprecated, error",
        });
      }

      const updateData = { status };
      if (req.userId) {
        updateData.updatedBy = req.userId;
      }

      const server = await Server.findByIdAndUpdate(
        id,
        { $set: updateData },
        { new: true }
      ).select("-credentials.password -credentials.apiKey -credentials.token");

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      logger.info(`Server status updated: ${server.name} -> ${status}`);

      res.json({
        success: true,
        message: `Estado actualizado a '${status}'`,
        data: server,
      });
    } catch (error) {
      logger.error(`Error updating server status: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al actualizar estado",
        error: error.message,
      });
    }
  },

  /**
   * Agregar credencial a un servidor
   * POST /servers/:id/credentials
   */
  async addCredential(req, res) {
    try {
      const { id } = req.params;
      const credential = req.body;

      if (!credential.label) {
        return res.status(400).json({
          success: false,
          message: "El label de la credencial es requerido",
        });
      }

      const server = await Server.findById(id);

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      server.credentials.push(credential);
      if (req.userId) {
        server.updatedBy = req.userId;
      }
      await server.save();

      logger.info(`Credential added to server: ${server.name}`);

      res.status(201).json({
        success: true,
        message: "Credencial agregada exitosamente",
        data: {
          serverId: server._id,
          credentialId: server.credentials[server.credentials.length - 1]._id,
        },
      });
    } catch (error) {
      logger.error(`Error adding credential: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al agregar credencial",
        error: error.message,
      });
    }
  },

  /**
   * Eliminar credencial de un servidor
   * DELETE /servers/:id/credentials/:credentialId
   */
  async removeCredential(req, res) {
    try {
      const { id, credentialId } = req.params;

      const server = await Server.findById(id);

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      const credIndex = server.credentials.findIndex(
        (c) => c._id.toString() === credentialId
      );

      if (credIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Credencial no encontrada",
        });
      }

      server.credentials.splice(credIndex, 1);
      if (req.userId) {
        server.updatedBy = req.userId;
      }
      await server.save();

      logger.info(`Credential removed from server: ${server.name}`);

      res.json({
        success: true,
        message: "Credencial eliminada exitosamente",
      });
    } catch (error) {
      logger.error(`Error removing credential: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al eliminar credencial",
        error: error.message,
      });
    }
  },

  /**
   * Obtener estadísticas de servidores
   * GET /servers/stats
   */
  async getStats(req, res) {
    try {
      const [byType, byStatus, total] = await Promise.all([
        Server.aggregate([
          { $group: { _id: "$type", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        Server.aggregate([
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        Server.countDocuments(),
      ]);

      res.json({
        success: true,
        message: "Estadísticas obtenidas exitosamente",
        data: {
          total,
          byType: byType.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {}),
          byStatus: byStatus.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {}),
        },
      });
    } catch (error) {
      logger.error(`Error fetching server stats: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener estadísticas",
        error: error.message,
      });
    }
  },

  /**
   * Actualizar health check de un servidor
   * PATCH /servers/:id/health
   */
  async updateHealthCheck(req, res) {
    try {
      const { id } = req.params;
      const { healthCheckResult } = req.body;

      if (
        !healthCheckResult ||
        !["healthy", "unhealthy", "unknown"].includes(healthCheckResult)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Resultado de health check inválido. Debe ser: healthy, unhealthy, unknown",
        });
      }

      const server = await Server.findByIdAndUpdate(
        id,
        {
          $set: {
            healthCheckResult,
            lastHealthCheck: new Date(),
          },
        },
        { new: true }
      ).select("-credentials.password -credentials.apiKey -credentials.token");

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      logger.info(
        `Health check updated for server: ${server.name} -> ${healthCheckResult}`
      );

      res.json({
        success: true,
        message: "Health check actualizado",
        data: server,
      });
    } catch (error) {
      logger.error(`Error updating health check: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al actualizar health check",
        error: error.message,
      });
    }
  },

  /**
   * Agregar aplicación a un servidor
   * POST /servers/:id/applications
   */
  async addApplication(req, res) {
    try {
      const { id } = req.params;
      const application = req.body;

      if (!application.name) {
        return res.status(400).json({
          success: false,
          message: "El nombre de la aplicación es requerido",
        });
      }

      const server = await Server.findById(id);

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      server.applications.push(application);
      if (req.userId) {
        server.updatedBy = req.userId;
      }
      await server.save();

      logger.info(`Application '${application.name}' added to server: ${server.name}`);

      res.status(201).json({
        success: true,
        message: "Aplicación agregada exitosamente",
        data: {
          serverId: server._id,
          applicationId: server.applications[server.applications.length - 1]._id,
          application: server.applications[server.applications.length - 1],
        },
      });
    } catch (error) {
      logger.error(`Error adding application: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al agregar aplicación",
        error: error.message,
      });
    }
  },

  /**
   * Actualizar aplicación de un servidor
   * PUT /servers/:id/applications/:appId
   */
  async updateApplication(req, res) {
    try {
      const { id, appId } = req.params;
      const updateData = req.body;

      const server = await Server.findById(id);

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      const appIndex = server.applications.findIndex(
        (app) => app._id.toString() === appId
      );

      if (appIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Aplicación no encontrada",
        });
      }

      // Actualizar campos de la aplicación
      Object.keys(updateData).forEach((key) => {
        if (key !== "_id") {
          server.applications[appIndex][key] = updateData[key];
        }
      });

      if (req.userId) {
        server.updatedBy = req.userId;
      }
      await server.save();

      logger.info(`Application updated in server: ${server.name}`);

      res.json({
        success: true,
        message: "Aplicación actualizada exitosamente",
        data: server.applications[appIndex],
      });
    } catch (error) {
      logger.error(`Error updating application: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al actualizar aplicación",
        error: error.message,
      });
    }
  },

  /**
   * Eliminar aplicación de un servidor
   * DELETE /servers/:id/applications/:appId
   */
  async removeApplication(req, res) {
    try {
      const { id, appId } = req.params;

      const server = await Server.findById(id);

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      const appIndex = server.applications.findIndex(
        (app) => app._id.toString() === appId
      );

      if (appIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Aplicación no encontrada",
        });
      }

      const removedApp = server.applications[appIndex];
      server.applications.splice(appIndex, 1);
      if (req.userId) {
        server.updatedBy = req.userId;
      }
      await server.save();

      logger.info(`Application '${removedApp.name}' removed from server: ${server.name}`);

      res.json({
        success: true,
        message: "Aplicación eliminada exitosamente",
      });
    } catch (error) {
      logger.error(`Error removing application: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al eliminar aplicación",
        error: error.message,
      });
    }
  },

  /**
   * Obtener aplicaciones de un servidor
   * GET /servers/:id/applications
   */
  async getApplications(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.query;

      const server = await Server.findById(id).select("name applications");

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      let applications = server.applications || [];

      // Filtrar por estado si se especifica
      if (status) {
        applications = applications.filter((app) => app.status === status);
      }

      res.json({
        success: true,
        message: "Aplicaciones obtenidas exitosamente",
        count: applications.length,
        data: applications,
      });
    } catch (error) {
      logger.error(`Error fetching applications: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al obtener aplicaciones",
        error: error.message,
      });
    }
  },

  /**
   * Actualizar información de red del servidor
   * PATCH /servers/:id/network
   */
  async updateNetwork(req, res) {
    try {
      const { id } = req.params;
      const networkData = req.body;

      const updateObj = {};
      Object.keys(networkData).forEach((key) => {
        updateObj[`network.${key}`] = networkData[key];
      });

      if (req.userId) {
        updateObj.updatedBy = req.userId;
      }

      const server = await Server.findByIdAndUpdate(
        id,
        { $set: updateObj },
        { new: true }
      ).select("-credentials.password -credentials.apiKey -credentials.token");

      if (!server) {
        return res.status(404).json({
          success: false,
          message: "Servidor no encontrado",
        });
      }

      logger.info(`Network info updated for server: ${server.name}`);

      res.json({
        success: true,
        message: "Información de red actualizada",
        data: server.network,
      });
    } catch (error) {
      logger.error(`Error updating network info: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Error al actualizar información de red",
        error: error.message,
      });
    }
  },
};

module.exports = serverController;
