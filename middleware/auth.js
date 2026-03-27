'use strict';

/**
 * 🔐 Middleware для проверки авторизации в Socket.IO
 */
const socketAuth = async (socket, next) => {
  const phone = socket.handshake.auth?.phone;
  
  if (!phone) {
    return next(new Error('AUTH_REQUIRED'));
  }
  
  if (global.db) {
    try {
      const user = await global.db.get('SELECT isBanned FROM users WHERE phone=?', [phone]);
      if (user?.isBanned) {
        return next(new Error('BANNED'));
      }
    } catch (e) {
      console.error('Socket auth error:', e.message);
    }
  }
  
  next();
};

/**
 * 🔑 Middleware для HTTP API
 */
const requireAuth = (req, res, next) => {
  const phone = req.headers['x-user-phone'];
  
  if (!phone) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  
  req.userPhone = phone;
  next();
};

module.exports = {
  socketAuth,
  requireAuth,
};