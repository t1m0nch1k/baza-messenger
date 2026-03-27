'use strict';
const { validatePublicKey } = require('../config/encryption');

/**
 * 🔐 Проверка E2EE заголовков
 */
const requireE2EE = (req, res, next) => {
  if (!req.path.startsWith('/api/messages') && !req.path.startsWith('/api/wallet')) {
    return next();
  }
  
  if (req.body?.encrypted === true) {
    const headers = req.headers;
    const required = ['x-client-public-key', 'x-encryption-algorithm'];
    
    const missing = required.filter(h => !headers[h]);
    if (missing.length) {
      return res.status(400).json({
        error: 'E2EE_MISSING_HEADERS',
        missing,
      });
    }
    
    if (!validatePublicKey(headers['x-client-public-key'])) {
      return res.status(400).json({
        error: 'E2EE_INVALID_PUBLIC_KEY',
      });
    }
  }
  
  next();
};

module.exports = { requireE2EE };