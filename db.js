'use strict';
/**
 * db.js — SQLite адаптер для BAZA v6.0
 * Автоматически создаёт все таблицы и добавляет недостающие колонки.
 */

const path    = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const IS_PG = false;

async function initDb() {
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'baza.db');

    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA synchronous  = NORMAL');
    await db.exec('PRAGMA cache_size   = -32000');
    await db.exec('PRAGMA temp_store   = MEMORY');
    await db.exec('PRAGMA foreign_keys = ON');

    // ── CORE TABLES ──────────────────────────────────────────────────────────
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            phone            TEXT PRIMARY KEY,
            nickname         TEXT NOT NULL,
            passwordHash     TEXT NOT NULL,
            socketId         TEXT,
            avatar           TEXT,
            status           TEXT DEFAULT 'offline',
            lastSeen         TEXT,
            bio              TEXT DEFAULT '',
            createdAt        TEXT DEFAULT CURRENT_TIMESTAMP,
            email            TEXT,
            isVerified       INTEGER DEFAULT 0,
            verificationCode TEXT,
            role             TEXT DEFAULT 'user',
            isBanned         INTEGER DEFAULT 0,
            isPremium        INTEGER DEFAULT 0,
            premiumUntil     TEXT,
            balance          REAL    DEFAULT 0.0,
            pin              TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id          TEXT PRIMARY KEY,
            chatId      TEXT NOT NULL,
            senderPhone TEXT NOT NULL,
            senderName  TEXT NOT NULL,
            text        TEXT,
            fileUrl     TEXT,
            audioUrl    TEXT,
            videoUrl    TEXT,
            duration    REAL,
            timestamp   TEXT NOT NULL,
            status      TEXT DEFAULT 'sent',
            isEdited    INTEGER DEFAULT 0,
            editedAt    TEXT,
            isRead      INTEGER DEFAULT 0,
            replyTo     TEXT
        );
        CREATE TABLE IF NOT EXISTS reactions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            messageId   TEXT NOT NULL,
            senderPhone TEXT NOT NULL,
            emoji       TEXT NOT NULL,
            UNIQUE(messageId, senderPhone, emoji)
        );
        CREATE TABLE IF NOT EXISTS calls (
            callId         TEXT PRIMARY KEY,
            initiatorPhone TEXT NOT NULL,
            recipientPhone TEXT NOT NULL,
            type           TEXT NOT NULL,
            startTime      TEXT,
            endTime        TEXT,
            status         TEXT DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS contacts (
            userPhone    TEXT NOT NULL,
            contactPhone TEXT NOT NULL,
            nickname     TEXT,
            PRIMARY KEY (userPhone, contactPhone)
        );
        CREATE TABLE IF NOT EXISTS blocked_users (
            userPhone    TEXT NOT NULL,
            blockedPhone TEXT NOT NULL,
            PRIMARY KEY (userPhone, blockedPhone)
        );
        CREATE TABLE IF NOT EXISTS groups (
            id        TEXT PRIMARY KEY,
            name      TEXT NOT NULL,
            avatar    TEXT,
            createdBy TEXT NOT NULL,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS group_members (
            groupId  TEXT NOT NULL,
            phone    TEXT NOT NULL,
            role     TEXT DEFAULT 'member',
            joinedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (groupId, phone)
        );
        CREATE TABLE IF NOT EXISTS ai_history (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            phone     TEXT NOT NULL,
            chatId    TEXT,
            type      TEXT NOT NULL,
            request   TEXT,
            response  TEXT,
            model     TEXT,
            timestamp TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id          TEXT PRIMARY KEY,
            actorPhone  TEXT,
            actorType   TEXT DEFAULT 'user',
            action      TEXT NOT NULL,
            targetPhone TEXT,
            severity    TEXT DEFAULT 'info',
            meta        TEXT,
            ip          TEXT,
            userAgent   TEXT,
            timestamp   TEXT NOT NULL
        );
    `);

    // ── CHANNELS ─────────────────────────────────────────────────────────────
    await db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            description     TEXT DEFAULT '',
            createdBy       TEXT NOT NULL,
            isPublic        INTEGER DEFAULT 1,
            avatar          TEXT,
            subscriberCount INTEGER DEFAULT 0,
            createdAt       TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS channel_subscribers (
            channelId TEXT NOT NULL,
            phone     TEXT NOT NULL,
            role      TEXT DEFAULT 'subscriber',
            joinedAt  TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (channelId, phone)
        );
        CREATE TABLE IF NOT EXISTS channel_posts (
            id          TEXT PRIMARY KEY,
            channelId   TEXT NOT NULL,
            authorPhone TEXT NOT NULL,
            authorName  TEXT NOT NULL,
            text        TEXT,
            fileUrl     TEXT,
            videoUrl    TEXT,
            views       INTEGER DEFAULT 0,
            timestamp   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channel_comments (
            id          TEXT PRIMARY KEY,
            postId      TEXT NOT NULL,
            channelId   TEXT NOT NULL,
            senderPhone TEXT NOT NULL,
            senderName  TEXT NOT NULL,
            text        TEXT NOT NULL,
            timestamp   TEXT NOT NULL
        );
    `);

    // ── STORIES ──────────────────────────────────────────────────────────────
    await db.exec(`
        CREATE TABLE IF NOT EXISTS stories (
            id          TEXT PRIMARY KEY,
            authorPhone TEXT NOT NULL,
            authorName  TEXT NOT NULL,
            videoUrl    TEXT,
            imageUrl    TEXT,
            text        TEXT,
            duration    REAL DEFAULT 5,
            expiresAt   TEXT NOT NULL,
            createdAt   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS story_views (
            storyId     TEXT NOT NULL,
            viewerPhone TEXT NOT NULL,
            viewedAt    TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (storyId, viewerPhone)
        );
    `);

    // ── WALLET & MARKETPLACE ─────────────────────────────────────────────────
    await db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id        TEXT PRIMARY KEY,
            fromPhone TEXT NOT NULL,
            toPhone   TEXT NOT NULL,
            amount    REAL NOT NULL,
            comment   TEXT DEFAULT '',
            type      TEXT DEFAULT 'transfer',
            status    TEXT DEFAULT 'completed',
            timestamp TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS marketplace_orders (
            id          TEXT PRIMARY KEY,
            userPhone   TEXT NOT NULL,
            serviceId   TEXT NOT NULL,
            serviceName TEXT NOT NULL,
            amount      REAL NOT NULL,
            status      TEXT DEFAULT 'pending',
            details     TEXT,
            timestamp   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_services (
            id          TEXT PRIMARY KEY,
            ownerPhone  TEXT NOT NULL,
            ownerName   TEXT NOT NULL,
            name        TEXT NOT NULL,
            description TEXT DEFAULT '',
            icon        TEXT DEFAULT '🔧',
            category    TEXT DEFAULT 'other',
            price       REAL DEFAULT 0,
            isActive    INTEGER DEFAULT 1,
            createdAt   TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // ── МИГРАЦИИ — добавляем колонки в существующую БД ───────────────────────
    const migrations = [
        "ALTER TABLE users ADD COLUMN bio              TEXT    DEFAULT ''",
        "ALTER TABLE users ADD COLUMN role             TEXT    DEFAULT 'user'",
        "ALTER TABLE users ADD COLUMN isBanned         INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN email            TEXT",
        "ALTER TABLE users ADD COLUMN isVerified       INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN verificationCode TEXT",
        "ALTER TABLE users ADD COLUMN isPremium        INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN premiumUntil     TEXT",
        "ALTER TABLE users ADD COLUMN balance          REAL    DEFAULT 0.0",
        "ALTER TABLE users ADD COLUMN pin              TEXT",
        "ALTER TABLE messages ADD COLUMN isRead        INTEGER DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN replyTo       TEXT",
        "ALTER TABLE messages ADD COLUMN isEdited      INTEGER DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN editedAt      TEXT",
        "ALTER TABLE channels ADD COLUMN avatar          TEXT",
        "ALTER TABLE channels ADD COLUMN subscriberCount INTEGER DEFAULT 0",
        "ALTER TABLE channel_posts ADD COLUMN videoUrl   TEXT",
    ];
    for (const sql of migrations) {
        try { await db.run(sql); } catch (_) { /* already exists */ }
    }

    // ── db.transaction() — которого нет в пакете sqlite ─────────────────────
    if (typeof db.transaction !== 'function') {
        db.transaction = async function(fn) {
            await db.run('BEGIN');
            try {
                const tx = {
                    run: (sql, p) => db.run(sql, p),
                    get: (sql, p) => db.get(sql, p),
                    all: (sql, p) => db.all(sql, p),
                };
                await fn(tx);
                await db.run('COMMIT');
            } catch (e) {
                await db.run('ROLLBACK');
                throw e;
            }
        };
    }

    console.log(`✅ BAZA DB готова → SQLite (${dbPath})`);
    return db;
}

module.exports = { initDb, IS_PG };