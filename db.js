'use strict';
/**
 * db.js — PostgreSQL адаптер для BAZA v6.0
 * Автоматически создаёт все таблицы и добавляет недостающие колонки.
 */

const { Pool } = require('pg');

const IS_PG = true;

let pool;

async function initDb() {
    const connectionString = process.env.DATABASE_URL || 
        `postgres://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'baza'}`;

    pool = new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });

    // Проверка подключения
    const client = await pool.connect();
    try {
        await client.query('SELECT NOW()');
        console.log(`✅ BAZA DB готова → PostgreSQL`);
    } finally {
        client.release();
    }

    // ── CORE TABLES ──────────────────────────────────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            phone            TEXT PRIMARY KEY,
            nickname         TEXT NOT NULL,
            passwordHash     TEXT NOT NULL,
            socketId         TEXT,
            avatar           TEXT,
            status           TEXT DEFAULT 'offline',
            lastSeen         TEXT,
            bio              TEXT DEFAULT '',
            createdAt        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            email            TEXT,
            isVerified       BOOLEAN DEFAULT FALSE,
            verificationCode TEXT,
            role             TEXT DEFAULT 'user',
            isBanned         BOOLEAN DEFAULT FALSE,
            isPremium        BOOLEAN DEFAULT FALSE,
            premiumUntil     TIMESTAMPTZ,
            balance          NUMERIC    DEFAULT 0.0,
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
            timestamp   TIMESTAMPTZ NOT NULL,
            status      TEXT DEFAULT 'sent',
            isEdited    BOOLEAN DEFAULT FALSE,
            editedAt    TIMESTAMPTZ,
            isRead      BOOLEAN DEFAULT FALSE,
            replyTo     TEXT
        );
        CREATE TABLE IF NOT EXISTS reactions (
            id          SERIAL PRIMARY KEY,
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
            startTime      TIMESTAMPTZ,
            endTime        TIMESTAMPTZ,
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
            createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS group_members (
            groupId  TEXT NOT NULL,
            phone    TEXT NOT NULL,
            role     TEXT DEFAULT 'member',
            joinedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (groupId, phone)
        );
        CREATE TABLE IF NOT EXISTS ai_history (
            id        SERIAL PRIMARY KEY,
            phone     TEXT NOT NULL,
            chatId    TEXT,
            type      TEXT NOT NULL,
            request   TEXT,
            response  TEXT,
            model     TEXT,
            timestamp TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id          TEXT PRIMARY KEY,
            actorPhone  TEXT,
            actorType   TEXT DEFAULT 'user',
            action      TEXT NOT NULL,
            targetPhone TEXT,
            severity    TEXT DEFAULT 'info',
            meta        JSONB,
            ip          TEXT,
            userAgent   TEXT,
            timestamp   TIMESTAMPTZ NOT NULL
        );
    `);

    // ── CHANNELS ─────────────────────────────────────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS channels (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            description     TEXT DEFAULT '',
            createdBy       TEXT NOT NULL,
            isPublic        BOOLEAN DEFAULT TRUE,
            avatar          TEXT,
            subscriberCount INTEGER DEFAULT 0,
            createdAt       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS channel_subscribers (
            channelId TEXT NOT NULL,
            phone     TEXT NOT NULL,
            role      TEXT DEFAULT 'subscriber',
            joinedAt  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
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
            timestamp   TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channel_comments (
            id          TEXT PRIMARY KEY,
            postId      TEXT NOT NULL,
            channelId   TEXT NOT NULL,
            senderPhone TEXT NOT NULL,
            senderName  TEXT NOT NULL,
            text        TEXT NOT NULL,
            timestamp   TIMESTAMPTZ NOT NULL
        );
    `);

    // ── STORIES ──────────────────────────────────────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS stories (
            id          TEXT PRIMARY KEY,
            authorPhone TEXT NOT NULL,
            authorName  TEXT NOT NULL,
            videoUrl    TEXT,
            imageUrl    TEXT,
            text        TEXT,
            duration    REAL DEFAULT 5,
            expiresAt   TIMESTAMPTZ NOT NULL,
            createdAt   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS story_views (
            storyId     TEXT NOT NULL,
            viewerPhone TEXT NOT NULL,
            viewedAt    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (storyId, viewerPhone)
        );
    `);

    // ── WALLET & MARKETPLACE ─────────────────────────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id        TEXT PRIMARY KEY,
            fromPhone TEXT NOT NULL,
            toPhone   TEXT NOT NULL,
            amount    NUMERIC NOT NULL,
            comment   TEXT DEFAULT '',
            type      TEXT DEFAULT 'transfer',
            status    TEXT DEFAULT 'completed',
            timestamp TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS marketplace_orders (
            id          TEXT PRIMARY KEY,
            userPhone   TEXT NOT NULL,
            serviceId   TEXT NOT NULL,
            serviceName TEXT NOT NULL,
            amount      NUMERIC NOT NULL,
            status      TEXT DEFAULT 'pending',
            details     TEXT,
            timestamp   TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_services (
            id          TEXT PRIMARY KEY,
            ownerPhone  TEXT NOT NULL,
            ownerName   TEXT NOT NULL,
            name        TEXT NOT NULL,
            description TEXT DEFAULT '',
            icon        TEXT DEFAULT '🔧',
            category    TEXT DEFAULT 'other',
            price       NUMERIC DEFAULT 0,
            isActive    BOOLEAN DEFAULT TRUE,
            createdAt   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // ── ИНДЕКСЫ для производительности ───────────────────────────────────────
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_senderPhone ON messages(senderPhone);
        CREATE INDEX IF NOT EXISTS idx_reactions_messageId ON reactions(messageId);
        CREATE INDEX IF NOT EXISTS idx_stories_expiresAt ON stories(expiresAt);
        CREATE INDEX IF NOT EXISTS idx_channel_posts_channelId ON channel_posts(channelId);
        CREATE INDEX IF NOT EXISTS idx_ai_history_phone ON ai_history(phone);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
    `);

    console.log(`✅ Все таблицы и индексы созданы`);
    
    return dbProxy;
}

// Обёртка для совместимости с старым API
const dbProxy = {
    transaction: async (fn) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const tx = {
                run: async (sql, params) => await client.query(sql, params),
                get: async (sql, params) => (await client.query(sql, params)).rows[0],
                all: async (sql, params) => (await client.query(sql, params)).rows,
            };
            await fn(tx);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    },
    run: async (sql, params) => await pool.query(sql, params),
    get: async (sql, params) => (await pool.query(sql, params)).rows[0],
    all: async (sql, params) => (await pool.query(sql, params)).rows,
};

module.exports = { initDb, IS_PG, getDb: () => pool, db: dbProxy };