const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { logger } = require('../config/pino');

// Nombre de la cookie para compatibilidad con servidor B
const TOKEN_COOKIE_NAME = 'auth_token';

// Middleware para verificar autenticación mediante cookies
const verifyToken = async (req, res, next) => {
  try {
    // Obtener token de acceso de las cookies
    const token = req.cookies?.[TOKEN_COOKIE_NAME];
    
    if (!token) {
      logger.warn(`Middleware auth: Token no encontrado`);
      return res.status(401).json({
        status: 'error',
        message: "No token, authorization denied",
        needRefresh: true  // Esta flag le indica al cliente que debe renovar el token
      });
    }
    
    try {
      // Verificar token con algoritmo específico para compatibilidad con B
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"]
      });
      
      // Buscar usuario (compatible con ambos formatos: userId o id)
      const userId = decoded.id || decoded.userId;
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(401).json({ 
          status: 'error',
          message: "User no longer exists" 
        });
      }
      
      if (!user.isActive) {
        return res.status(403).json({
          status: 'error',
          message: 'Esta cuenta ha sido desactivada',
          accountDeactivated: true,
          requireLogin: true
        });
      }
      
      // Guardar el usuario en req para usarlo en rutas posteriores
      req.user = user;
      req.userId = userId;
      
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          status: 'error',
          message: "Token has expired",
          needRefresh: true  // Esta flag le indica al cliente que debe renovar el token
        });
      }
      
      return res.status(401).json({
        status: 'error',
        message: "Token is not valid",
        needRefresh: true  // Esta flag le indica al cliente que debe renovar el token
      });
    }
  } catch (error) {
    logger.error(`Error general en middleware auth: ${error.message}`);
    return res.status(500).json({
      status: 'error',
      message: 'Error en la autenticación'
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