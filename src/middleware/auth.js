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
const verifyAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      status: 'error',
      message: 'Autenticación requerida',
      needRefresh: true
    });
  }

  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({
      status: 'error',
      message: 'Acceso denegado, se requiere rol de administrador'
    });
  }

  next();
};

module.exports = {
  verifyToken,
  verifyAdmin
};