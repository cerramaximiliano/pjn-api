const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { logger } = require('../config/pino');
const moment = require('moment');

// Nombre de la cookie para compatibilidad con servidor B
const TOKEN_COOKIE_NAME = 'auth_token';

// Middleware para verificar autenticación mediante cookies
const verifyToken = async (req, res, next) => {
  // Obtener token de la cookie, encabezado Authorization o query param
  const tokenFromCookie = req.cookies?.[TOKEN_COOKIE_NAME];
  const tokenFromHeader = req.headers.authorization?.split(' ')[1]; // "Bearer TOKEN"
  const tokenFromQuery = req.query?.token;

  const token = tokenFromCookie || tokenFromHeader || tokenFromQuery;

  if (!token) {
    logger.info(`Middleware auth: Verificando token para ruta ${req.originalUrl}`);
    logger.warn(`Middleware auth: Token no encontrado`);
    return res.status(401).json({
      message: "No token, authorization denied",
      needRefresh: true
    });
  }

  try {
    // Verificar token con el secreto JWT (usando SEED como fallback si JWT_SECRET no está definido)
    const jwtSecret = process.env.JWT_SECRET || process.env.SEED;
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"]
    });

    if (decoded.id) {
      logger.info(`Token recibido correctamente - Creación: ${moment.unix(decoded.iat).format('DD/MM/YYYY HH:mm:ss')} - Expiración: ${moment.unix(decoded.exp).format('DD/MM/YYYY HH:mm:ss')}`);
    }

    // Verificar expiración
    const currentTime = Math.floor(Date.now() / 1000);
    if (decoded.exp < currentTime) {
      logger.warn(`Middleware auth: Token expirado`);
      return res.status(401).json({
        message: "Token has expired",
        needRefresh: true
      });
    }

    // En este microservicio solo verificamos el token y extraemos el ID de usuario
    // No verificamos la suscripción ni cargamos el usuario completo
    req.userId = decoded.id;

    // Si hay información adicional en el payload, también la añadimos
    if (decoded.userData) {
      req.userData = decoded.userData;
    }

    // Continuar con el siguiente middleware
    next();
  } catch (error) {
    logger.error(`Middleware auth: Error de verificación de token: ${error.message}`);

    // Determinar el tipo de error para mensajes más específicos
    let message = "Token is not valid";
    if (error.name === 'TokenExpiredError') {
      message = "Token has expired";
    } else if (error.name === 'JsonWebTokenError') {
      message = error.message;
    }

    res.status(401).json({
      message: message,
      needRefresh: true
    });
  }
};

// Middleware para verificar rol de administrador
const verifyAdmin = async (req, res, next) => {
  try {
    if (!req.userId) {
      return res.status(401).json({
        status: 'error',
        message: 'Autenticación requerida',
        needRefresh: true
      });
    }

    // Buscar el usuario en la base de datos por _id
    const user = await User.findById(req.userId).select('role');
    
    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'Usuario no encontrado',
        needRefresh: true
      });
    }

    // Verificar que el rol sea ADMIN_ROLE
    if (user.role !== 'ADMIN_ROLE') {
      return res.status(403).json({
        status: 'error',
        message: 'Acceso denegado, se requiere rol de administrador'
      });
    }

    // Agregar el usuario a la request para uso posterior
    req.user = user;
    next();
  } catch (error) {
    logger.error(`Error verificando rol de administrador: ${error.message}`);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor'
    });
  }
};

// Middleware para verificar API KEY
const verifyApiKey = (req, res, next) => {
  // Obtener API key del header, query param o body
  const apiKeyFromHeader = req.headers['x-api-key'] || req.headers['api-key'];
  const apiKeyFromQuery = req.query?.apiKey;
  const apiKeyFromBody = req.body?.apiKey;

  const apiKey = apiKeyFromHeader || apiKeyFromQuery || apiKeyFromBody;

  if (!apiKey) {
    logger.warn(`Middleware auth: API Key no encontrada para ruta ${req.originalUrl}`);
    return res.status(401).json({
      success: false,
      message: "API Key no proporcionada",
      error: "Authentication required"
    });
  }

  // Verificar que la API key coincida con la configurada
  const validApiKey = process.env.API_KEY;
  
  if (!validApiKey) {
    logger.error('API_KEY no configurada en las variables de entorno');
    return res.status(500).json({
      success: false,
      message: "Error de configuración del servidor",
      error: "Internal server error"
    });
  }

  if (apiKey !== validApiKey) {
    logger.warn(`Middleware auth: API Key inválida proporcionada: ${apiKey.substring(0, 10)}...`);
    return res.status(401).json({
      success: false,
      message: "API Key inválida",
      error: "Invalid authentication"
    });
  }

  logger.info(`Middleware auth: API Key verificada correctamente para ruta ${req.originalUrl}`);
  next();
};

module.exports = {
  verifyToken,
  verifyAdmin,
  verifyApiKey
};