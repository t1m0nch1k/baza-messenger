'use strict';
const argon2 = require('argon2');

/**
 * 🔐 Хеширование PIN кошелька (Argon2id)
 */
const hashWalletPin = async (pin) => {
  return argon2.hash(String(pin), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 2,
  });
};

/**
 * 🔓 Проверка PIN
 */
const verifyWalletPin = async (pin, hash) => {
  return argon2.verify(hash, String(pin));
};

/**
 * 🔑 Валидация публичного ключа
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
  hashWalletPin,
  verifyWalletPin,
  validatePublicKey,
};