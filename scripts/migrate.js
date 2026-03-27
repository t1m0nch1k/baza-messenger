#!/usr/bin/env node
'use strict';
/**
 * 🔄 Скрипт миграции БД
 * Запуск: node scripts/migrate.js
 */

const { initDb } = require('../db');

const migrations = [
  // E2EE поля
  "ALTER TABLE users ADD COLUMN publicKey TEXT",
  "ALTER TABLE users ADD COLUMN walletPinHash TEXT",
  "ALTER TABLE users ADD COLUMN walletSalt TEXT",
  
  // Сообщения E2EE
  "ALTER TABLE messages ADD COLUMN encrypted INTEGER DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN encPayload TEXT",
  "ALTER TABLE messages ADD COLUMN encIv TEXT",
  "ALTER TABLE messages ADD COLUMN encKeyId TEXT",
  
  // Новые таблицы
  "CREATE TABLE IF NOT EXISTS user_keys (userId TEXT PRIMARY KEY, publicKey TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pinned_messages (chatId TEXT PRIMARY KEY, messageId TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS drafts (phone TEXT NOT NULL, chatId TEXT NOT NULL, text TEXT, PRIMARY KEY(phone, chatId))",
];

async function run() {
  console.log('🔄 Запуск миграции...');
  global.db = await initDb();
  
  for (const sql of migrations) {
    try {
      await global.db.run(sql);
      console.log(`✅ ${sql.slice(0, 60)}...`);
    } catch (e) {
      console.log(`⚠️  Пропущено (уже существует): ${sql.slice(0, 40)}...`);
    }
  }
  
  console.log('✅ Миграция завершена!');
  process.exit(0);
}

run().catch(e => {
  console.error('❌ Ошибка миграции:', e.message);
  process.exit(1);
});