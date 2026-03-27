'use strict';

/**
 *  Текущая метка времени ISO
 */
const ts = () => new Date().toISOString();

/**
 * 🔑 Уникальный ID
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/**
 * 🎲 Генерация 6-значного кода
 */
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

/**
 * 🖼️ Проверка на изображение
 */
const isImg = (n) => /\.(jpg|jpeg|png|gif|webp)$/i.test(n);

/**
 * 📧 Валидация email
 */
const validateEmail = (email) => {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
};

/**
 * 🔒 Очистка ввода от опасных символов
 */
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .trim()
    .slice(0, 10000);
};

module.exports = {
  ts,
  uid,
  genCode,
  isImg,
  validateEmail,
  sanitizeInput,
};