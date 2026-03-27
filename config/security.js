'use strict';
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

/**
 * 🛡️ Helmet конфигурация
 */
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "", "blob:", "https:"],
      connectSrc: ["'self'", "wss:", "https://api.mistral.ai", "https://api.groq.com"],
      mediaSrc: ["'self'", "blob:", ""],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
});

/**
 * ⚡ Rate Limiter для API
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Слишком много запросов' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 🔐 Строгий лимитер для auth/wallet
 */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Превышено количество попыток' },
  skipSuccessfulRequests: false,
});

/**
 * 🔍 Валидация phone
 */
const validatePhone = (phone) => {
  const regex = /^\+?[1-9]\d{6,14}$/;
  return regex.test(phone.replace(/[\s\-\(\)]/g, ''));
};

/**
 * 🔑 Валидация публичного E2EE ключа
 */
const validatePublicKey = (key) => {
  if (!key || typeof key !== 'string') return false;
  try {
    let base64 = key.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad) base64 += '='.repeat(4 - pad);
    const raw = Buffer.from(base64, 'base64');
    return raw.length === 32;
  } catch {
    return false;
  }
};

module.exports = {
  helmetConfig,
  apiLimiter,
  strictLimiter,
  validatePhone,
  validatePublicKey,
};