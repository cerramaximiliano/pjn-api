const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { logger } = require('../config/pino');
const moment = require('moment'); // Agregar esta dependencia

// Cambiar nombre de la cookie para que coincida
const TOKEN_COOKIE_NAME = 'auth_token';

// Middleware para verificar autenticación mediante cookies
const verifyToken = async (req, res, next) => {
  try {
    // Cambiar para usar el mismo nombre de cookie que el servidor B
    const token = req.cookies?.[TOKEN_COOKIE_NAME];
    
    if (!token) {
      return res.status(401).json({
        status: 'error',
        message: 'No token, authorization denied',
        needRefresh: true // Agregar flag para frontend
      });
    }
    
    // Especificar el algoritmo como lo hace el servidor B
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"]
    });
    
    // Verificar que el usuario existe en la base de datos
    const user = await User.findById(decoded.id || decoded.userId)
      .select("-password"); // Quitar contraseña de la respuesta como en B
    
    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'User no longer exists',
        needRefresh: true
      });
    }
    
    if (!user.isActive) {
      return res.status(403).json({
        message: 'Esta cuenta ha sido desactivada',
        accountDeactivated: true,
        requireLogin: true
      });
    }
    
    // Simplificar - eliminar verificación de sesiones activas para compatibilidad con B
    // Solo asignar el usuario y el ID, sin actualizar lastActivity
    req.user = user;
    req.userId = decoded.id || decoded.userId;
    
    next();
  } catch (error) {
    logger.error(`Error de autenticación: ${error.message}`);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'error',
        message: 'Token has expired',
        needRefresh: true
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'error',
        message: 'Token is not valid',
        needRefresh: true
      });
    }
    
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