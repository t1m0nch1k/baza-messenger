import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { env } from '../config/env';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;

  db = await open({
    filename: env.dbPath,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      tokenHash TEXT NOT NULL,
      userAgent TEXT,
      ip TEXT,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      revokedAt TEXT
    )
  `);

  return db;
}

