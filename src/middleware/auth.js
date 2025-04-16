const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { logger } = require('../config/pino');

// Middleware para verificar autenticación mediante cookies
const verifyToken = async (req, res, next) => {
  try {
    const token = req.cookies.token;
    
    if (!token) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Acceso denegado, token no proporcionado' 
      });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verificar que el usuario existe en la base de datos
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Usuario no encontrado' 
      });
    }
    
    if (!user.isActive) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Usuario desactivado' 
      });
    }
    
    // Verificar si el token pertenece a una sesión activa
    const sessionExists = user.activeSessions.some(session => session.token === token);
    
    if (!sessionExists) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Sesión inválida o expirada' 
      });
    }
    
    // Agregar el usuario a la solicitud para uso en otros middlewares o controladores
    req.user = user;
    req.token = token;
    
    // Actualizar la actividad de la sesión
    const sessionIndex = user.activeSessions.findIndex(session => session.token === token);
    if (sessionIndex !== -1) {
      user.activeSessions[sessionIndex].lastActivity = new Date();
      await user.save();
    }
    
    next();
  } catch (error) {
    logger.error(`Error de autenticación: ${error.message}`);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        status: 'error',
        message: 'Token expirado, inicie sesión nuevamente' 
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        status: 'error',
        message: 'Token inválido' 
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
      message: 'Autenticación requerida' 
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