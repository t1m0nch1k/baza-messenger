'use strict';
require('dotenv').config();

// ── IMPORTS ───────────────────────────────────────────────────────────────────
const express    = require('express');
const http       = require('http');
const socketIo   = require('socket.io');
const path       = require('path');
const fs         = require('fs').promises;
const bcrypt     = require('bcrypt');
const nodemailer = require('nodemailer');
const axios      = require('axios');
const { initDb, IS_PG } = require('./db');

// ── APP SETUP ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
server.timeout = 180000;
server.keepAliveTimeout = 180000;
const io     = socketIo(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e8 });

const PORT        = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VOICE_DIR   = path.join(__dirname, 'voice');
const VIDEO_DIR   = path.join(__dirname, 'videos');
const STICKER_DIR = path.join(__dirname, 'stickerpack');

// ── KEYS ──────────────────────────────────────────────────────────────────────
const ADMIN_KEY   = process.env.BAZA_ADMIN_KEY  || 'adminmmnnoomm12';
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';  // https://console.mistral.ai (primary)
const GROQ_KEY    = process.env.GROQ_API_KEY    || '';  // https://console.groq.com  (fallback)
const SMTP_USER   = process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASS || '';

// ════════════════════════════════════════════════════════════════════════════════
// 🤖 AI ENGINE — Mistral AI (primary) + Groq (fallback)
//
// Приоритет: MISTRAL_API_KEY → GROQ_API_KEY
// Groq использует OpenAI-совместимый API — интеграция идентична Mistral.
// Модели:
//   Mistral: mistral-small-latest   (1M токенов/месяц бесплатно)
//   Groq:    llama-3.1-8b-instant   (14 400 req/day бесплатно)
// ════════════════════════════════════════════════════════════════════════════════

function getAiProvider() {
    if (MISTRAL_KEY) return {
        name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions',
        key: MISTRAL_KEY, model: 'mistral-small-latest'
    };
    if (GROQ_KEY) return {
        name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions',
        key: GROQ_KEY, model: 'llama-3.1-8b-instant'
    };
    return null;
}

/**
 * Единая AI Chat функция — Mistral или Groq (оба OpenAI-совместимы)
 * @param {Array}  messages - [{role, content}, ...]
 * @param {Object} opts     - { maxTokens, temperature, model }
 * @returns {Promise<{text, provider, model}>}
 */
async function aiChat(messages, { maxTokens = 500, temperature = 0.7, model } = {}) {
    const provider = getAiProvider();
    if (!provider) throw new Error('Нет AI ключа. Добавьте MISTRAL_API_KEY или GROQ_API_KEY в .env');
    const useModel = model || provider.model;
    try {
        const resp = await axios.post(
            provider.url,
            { model: useModel, messages, max_tokens: maxTokens, temperature },
            {
                headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
                timeout: 30000
            }
        );
        return { text: resp.data.choices[0].message.content, provider: provider.name, model: useModel };
    } catch (e) {
        const status = e?.response?.status;
        const body   = e?.response?.data?.message || e?.response?.data?.error?.message || e.message;
        if (status === 401) throw new Error(`AI (${provider.name}): неверный API ключ`);
        if (status === 429) throw new Error(`AI (${provider.name}): превышен лимит запросов`);
        if (status === 422) throw new Error(`AI (${provider.name}): некорректный запрос`);
        throw new Error(`AI (${provider.name}) недоступен: ${body}`);
    }
}

// Обратная совместимость — возвращает только текст
async function mistralChat(messages, opts = {}) {
    const result = await aiChat(messages, opts);
    return result.text;
}

/**
 * Транскрипция голоса — Mistral Voxtral API (voxtral-mini-2507)
 * Voxtral принимает ТОЛЬКО multipart/form-data.
 * Собираем boundary вручную через Buffer — без npm зависимостей, Windows совместимо.
 */
async function transcribeAudio(filePath) {
    if (!MISTRAL_KEY) throw new Error('MISTRAL_API_KEY не задан в .env');

    const fsSync = require('fs');
    if (!fsSync.existsSync(filePath))
        throw new Error('Аудиофайл не найден: ' + filePath);

    const fileBuffer = fsSync.readFileSync(filePath);
    const fileName   = require('path').basename(filePath);
    const ext        = require('path').extname(filePath).toLowerCase().replace('.', '');
    const mimeMap    = { webm:'audio/webm', mp3:'audio/mpeg', mp4:'audio/mp4',
                         wav:'audio/wav',   ogg:'audio/ogg',  m4a:'audio/mp4', flac:'audio/flac' };
    const mimeType   = mimeMap[ext] || 'audio/webm';

    const boundary = 'VoxtralBnd' + Date.now().toString(36);
    const NL = '\r\n';

    const body = Buffer.concat([
        // поле: file
        Buffer.from(`--${boundary}${NL}Content-Disposition: form-data; name="file"; filename="${fileName}"${NL}Content-Type: ${mimeType}${NL}${NL}`),
        fileBuffer,
        Buffer.from(NL),
        // поле: model
        Buffer.from(`--${boundary}${NL}Content-Disposition: form-data; name="model"${NL}${NL}voxtral-mini-2507${NL}`),
        // поле: language
        Buffer.from(`--${boundary}${NL}Content-Disposition: form-data; name="language"${NL}${NL}ru${NL}`),
        // закрывающая граница
        Buffer.from(`--${boundary}--${NL}`),
    ]);

    const resp = await axios.post(
        'https://api.mistral.ai/v1/audio/transcriptions',
        body,
        {
            headers: {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Authorization':  `Bearer ${MISTRAL_KEY}`,
                'Content-Length': String(body.length),
            },
            timeout: 120000,
            maxBodyLength: 50 * 1024 * 1024,
        }
    );

    const text = (resp.data?.text || '').trim();
    if (!text) throw new Error('Voxtral вернул пустую транскрипцию');
    return text;
}

// ── NODEMAILER ────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
});

async function sendVerificationEmail(email, code) {
    if (!SMTP_USER) { console.warn('⚠️  SMTP_USER не задан — письмо не отправлено'); return false; }
    try {
        await transporter.sendMail({
            from: `"БАЗА Мессенджер" <${SMTP_USER}>`,
            to: email,
            subject: 'Подтверждение регистрации в БАЗА',
            html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;background:#111318;color:#e8eaf0;padding:32px;border-radius:16px">
                <div style="text-align:center;font-size:28px;font-weight:800;letter-spacing:2px;color:#7c8bff;margin-bottom:6px">БАЗА</div>
                <p style="text-align:center;color:#8b8fa8;margin-bottom:24px">Super App · Защищённая коммуникация</p>
                <p>Для завершения регистрации введите код:</p>
                <div style="text-align:center;font-size:36px;font-weight:800;letter-spacing:8px;color:#5c6ef8;background:#191c24;border-radius:12px;padding:20px;margin:20px 0">${code}</div>
                <p style="color:#8b8fa8;font-size:12px">Код действителен 15 минут. Не передавайте его никому.</p>
            </div>`
        });
        return true;
    } catch (e) { console.error('❌ Email error:', e.message); return false; }
}

/**
 * Отправка письма для сброса пароля
 * @param {string} email - адрес получателя
 * @param {string} resetLink - ссылка для сброса пароля
 */
async function sendPasswordResetEmail(email, resetLink) {
    if (!SMTP_USER) { console.warn('⚠️  SMTP_USER не задан — письмо не отправлено'); return false; }
    try {
        await transporter.sendMail({
            from: `"БАЗА Мессенджер" <${SMTP_USER}>`,
            to: email,
            subject: 'Восстановление пароля — БАЗА',
            html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;background:#111318;color:#e8eaf0;padding:32px;border-radius:16px">
                <div style="text-align:center;font-size:28px;font-weight:800;letter-spacing:2px;color:#7c8bff;margin-bottom:6px">БАЗА</div>
                <p style="text-align:center;color:#8b8fa8;margin-bottom:24px">Super App · Защищённая коммуникация</p>
                <p>Вы запросили восстановление пароля. Нажмите на кнопку ниже, чтобы установить новый пароль:</p>
                <div style="text-align:center;margin:28px 0">
                    <a href="${resetLink}" style="display:inline-block;background:#5c6ef8;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px">Сбросить пароль</a>
                </div>
                <p style="color:#8b8fa8;font-size:13px">Или скопируйте ссылку:</p>
                <div style="background:#191c24;padding:12px;border-radius:6px;word-break:break-all;color:#a0a8c0;font-size:12px">${resetLink}</div>
                <p style="color:#8b8fa8;font-size:12px;margin-top:20px">Ссылка действительна 15 минут. Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо.</p>
                <p style="color:#8b8fa8;font-size:12px">В целях безопасности не передавайте эту ссылку никому.</p>
            </div>`
        });
        return true;
    } catch (e) { console.error('❌ Password reset email error:', e.message); return false; }
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString();
const uid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const isImg = n  => /\.(jpg|jpeg|png|gif|webp)$/i.test(n);
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

// ИСПРАВЛЕНО: emitToChat теперь безопасно обрабатывает отсутствие db и ошибки парсинга chatId
async function emitToChat(chatId, event, data) {
    if (!global.db || !chatId) return;
    try {
        let phones;
        if (chatId.startsWith('g_')) {
            const rows = await global.db.all('SELECT phone FROM group_members WHERE groupId=$1', [chatId]);
            phones = rows.map(r => r.phone);
        } else {
            phones = chatId.split('_').filter(Boolean);
        }
        phones.forEach(p => {
            const sid = socketsByPhone[p];
            if (sid) io.to(sid).emit(event, data);
        });
    } catch (e) { console.error('emitToChat error:', e.message); }
}

function buildMsg(senderPhone, senderName, chatId, extras = {}) {
    return {
        id: uid(), chatId,
        senderPhone, senderName,
        timestamp: ts(), reactions: [],
        isRead: 0, isEdited: 0, replyTo: null,
        ...extras
    };
}

// ИСПРАВЛЕНО: saveMsg теперь явно перечисляет все поля, не зависит от порядка в extras
async function saveMsg(m) {
    await global.db.run(
        `INSERT INTO messages (id,chatId,senderPhone,senderName,text,fileUrl,audioUrl,videoUrl,duration,timestamp,replyTo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [m.id, m.chatId, m.senderPhone, m.senderName,
         m.text || null, m.fileUrl || null, m.audioUrl || null, m.videoUrl || null,
         m.duration || null, m.timestamp, m.replyTo || null]
    );
}

function generateAvatar(name) {
    const initials = (name || '$1').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F'];
    const color = colors[initials.charCodeAt(0) % colors.length];
    return `<svg width="40" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="${color}" rx="8"/><text x="20" y="25" font-size="16" font-weight="bold" text-anchor="middle" fill="white">${initials}</text></svg>`;
}

// parseMsg: rxns — строка JSON (SQLite) или массив (PG json_agg)
const parseMsg = m => {
    let reactions = [];
    if (m.rxns) {
        if (Array.isArray(m.rxns)) {
            // PostgreSQL: json_agg уже вернул массив объектов
            reactions = m.rxns.filter(Boolean);
        } else {
            // SQLite: строка JSON
            try { reactions = JSON.parse(m.rxns); } catch (_) {}
        }
    }
    return {
        ...m,
        reactions,
        isRead:   m.isRead   ? 1 : 0,
        isEdited: m.isEdited ? 1 : 0,
        replyTo:  m.replyTo  || null,
        rxns:     undefined,   // убираем из объекта
    };
};

// ── DB INIT ───────────────────────────────────────────────────────────────────
(async () => {
    await Promise.all([UPLOADS_DIR, VOICE_DIR, VIDEO_DIR, STICKER_DIR].map(d => fs.mkdir(d, { recursive: true })));

    global.db = await initDb();

    // ── Миграции новых таблиц ──────────────────────────────────────────────────
    if (!IS_PG) {
        await global.db.run(`CREATE TABLE IF NOT EXISTS pinned_messages (
            chatId TEXT PRIMARY KEY, messageId TEXT NOT NULL,
            pinnedBy TEXT, pinnedAt TEXT)`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS drafts (
            phone TEXT NOT NULL, chatId TEXT NOT NULL, text TEXT, updatedAt TEXT,
            PRIMARY KEY(phone, chatId))`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS message_reads (
            messageId TEXT NOT NULL, chatId TEXT NOT NULL,
            readerPhone TEXT NOT NULL, readAt TEXT,
            PRIMARY KEY(messageId, readerPhone))`).catch(()=>{});
        await global.db.run(`ALTER TABLE users ADD COLUMN autoReply INTEGER DEFAULT 0`).catch(()=>{});
        await global.db.run(`ALTER TABLE users ADD COLUMN autoReplyText TEXT DEFAULT ''`).catch(()=>{});
        await global.db.run(`ALTER TABLE users ADD COLUMN premiumUntil TEXT DEFAULT NULL`).catch(()=>{});

        // ── Таблица для токенов сброса пароля ─────────────────────────────────────
        await global.db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token TEXT PRIMARY KEY,
            phone TEXT NOT NULL,
            expiresAt TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`).catch(()=>{});

        await global.db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
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
        )`).catch(()=>{});

        // ── Таблицы каналов (создаём если нет — безопасно при любом db.js) ─────────
        await global.db.run(`CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
            avatar TEXT, createdBy TEXT NOT NULL, isPublic INTEGER DEFAULT 1,
            subscriberCount INTEGER DEFAULT 0, createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_subscribers (
            channelId TEXT NOT NULL, phone TEXT NOT NULL, role TEXT DEFAULT 'subscriber',
            notifications INTEGER DEFAULT 1,
            joinedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(channelId, phone)
        )`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_posts (
            id TEXT PRIMARY KEY, channelId TEXT NOT NULL, authorPhone TEXT NOT NULL,
            authorName TEXT NOT NULL, text TEXT, fileUrl TEXT, videoUrl TEXT,
            views INTEGER DEFAULT 0, timestamp TEXT NOT NULL
        )`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_comments (
            id TEXT PRIMARY KEY, postId TEXT NOT NULL, channelId TEXT NOT NULL,
            senderPhone TEXT NOT NULL, senderName TEXT NOT NULL,
            text TEXT NOT NULL, timestamp TEXT NOT NULL
        )`).catch(()=>{});
        // Миграция: добавить поле notifications если его нет
        await global.db.run(`ALTER TABLE channel_subscribers ADD COLUMN notifications INTEGER DEFAULT 1`).catch(()=>{});
        // Реакции на посты канала
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_post_reactions (
            postId TEXT NOT NULL, phone TEXT NOT NULL, emoji TEXT NOT NULL,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(postId, phone, emoji)
        )`).catch(()=>{});
        // Аватар канала (миграция поля)
        await global.db.run(`ALTER TABLE channels ADD COLUMN avatar TEXT DEFAULT NULL`).catch(()=>{});
        // Инвайт-токен для приватных каналов
        await global.db.run(`ALTER TABLE channels ADD COLUMN inviteToken TEXT DEFAULT NULL`).catch(()=>{});
    } else {
        // PostgreSQL версии таблиц с правильными типами
        await global.db.run(`CREATE TABLE IF NOT EXISTS pinned_messages (
            chatId TEXT PRIMARY KEY, "messageId" TEXT NOT NULL,
            "pinnedBy" TEXT, "pinnedAt" TIMESTAMPTZ)`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS drafts (
            phone TEXT NOT NULL, "chatId" TEXT NOT NULL, text TEXT, "updatedAt" TIMESTAMPTZ,
            PRIMARY KEY(phone, "chatId"))`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS message_reads (
            "messageId" TEXT NOT NULL, "chatId" TEXT NOT NULL,
            "readerPhone" TEXT NOT NULL, "readAt" TIMESTAMPTZ,
            PRIMARY KEY("messageId", "readerPhone"))`).catch(()=>{});
        await global.db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "autoReply" BOOLEAN DEFAULT FALSE`).catch(()=>{});
        await global.db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "autoReplyText" TEXT DEFAULT ''`).catch(()=>{});

        await global.db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token TEXT PRIMARY KEY,
            phone TEXT NOT NULL,
            "expiresAt" TIMESTAMPTZ NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`).catch(()=>{});

        await global.db.run(`CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
            avatar TEXT, "createdBy" TEXT NOT NULL, "isPublic" BOOLEAN DEFAULT TRUE,
            "subscriberCount" INTEGER DEFAULT 0, "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_subscribers (
            "channelId" TEXT NOT NULL, phone TEXT NOT NULL, role TEXT DEFAULT 'subscriber',
            notifications BOOLEAN DEFAULT TRUE,
            "joinedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY("channelId", phone)
        )`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_posts (
            id TEXT PRIMARY KEY, "channelId" TEXT NOT NULL, "authorPhone" TEXT NOT NULL,
            "authorName" TEXT NOT NULL, text TEXT, "fileUrl" TEXT, "videoUrl" TEXT,
            views INTEGER DEFAULT 0, timestamp TIMESTAMPTZ NOT NULL
        )`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_comments (
            id TEXT PRIMARY KEY, "postId" TEXT NOT NULL, "channelId" TEXT NOT NULL,
            "senderPhone" TEXT NOT NULL, "senderName" TEXT NOT NULL,
            text TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL
        )`).catch(()=>{});
        await global.db.run(`ALTER TABLE channel_subscribers ADD COLUMN IF NOT EXISTS notifications BOOLEAN DEFAULT TRUE`).catch(()=>{});
        await global.db.run(`CREATE TABLE IF NOT EXISTS channel_post_reactions (
            "postId" TEXT NOT NULL, phone TEXT NOT NULL, emoji TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY("postId", phone, emoji)
        )`).catch(()=>{});
        await global.db.run(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT NULL`).catch(()=>{});
        await global.db.run(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS "inviteToken" TEXT DEFAULT NULL`).catch(()=>{});
    }

    // ── Таблицы ботов ──────────────────────────────────────────────────────────
    await global.db.run(`CREATE TABLE IF NOT EXISTS bots (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        username    TEXT NOT NULL UNIQUE,
        ownerId     TEXT NOT NULL,
        token       TEXT NOT NULL UNIQUE,
        avatarEmoji TEXT DEFAULT '🤖',
        description TEXT DEFAULT '',
        webhookUrl  TEXT DEFAULT '',
        isActive    INTEGER DEFAULT 1,
        miniAppUrl  TEXT DEFAULT '',
        miniAppTitle TEXT DEFAULT '',
        createdAt   TEXT NOT NULL
    )`).catch(()=>{});
    await global.db.run(`CREATE TABLE IF NOT EXISTS bot_commands (
        id          TEXT PRIMARY KEY,
        botId       TEXT NOT NULL,
        command     TEXT NOT NULL,
        description TEXT DEFAULT ''
    )`).catch(()=>{});

    const aiP = getAiProvider();
    console.log(`🤖 AI провайдер: ${aiP ? '✅ ' + aiP.name + ' (' + aiP.model + ')' : '❌ нет ключей MISTRAL_API_KEY / GROQ_API_KEY'}`);
    console.log(`📧 SMTP: ${SMTP_USER ? '✅ ' + SMTP_USER : '⚠️  не настроен'}`);
    console.log(`🗄️  БД: ${IS_PG ? 'PostgreSQL' : 'SQLite'}`);
})();

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/uploads',     express.static(UPLOADS_DIR));
app.use('/voice',       express.static(VOICE_DIR));
app.use('/videos',      express.static(VIDEO_DIR));
app.use('/stickerpack', express.static(STICKER_DIR));
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/premium', (req, res) => res.sendFile(path.join(__dirname, 'premium.html')));

// ── STICKER PACKS API ─────────────────────────────────────────────────────────
app.get('/api/stickerpacks', async (req, res) => {
    try {
        const IMG_RE = /\.(png|jpg|jpeg|gif|webp|apng|avif)$/i;
        const entries = await fs.readdir(STICKER_DIR, { withFileTypes: true });
        const packs = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const packPath = path.join(STICKER_DIR, entry.name);
            let files;
            try { files = await fs.readdir(packPath); } catch { continue; }
            const stickers = files
                .filter(f => IMG_RE.test(f))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                .map(f => ({
                    name: path.basename(f, path.extname(f)),
                    url: `/stickerpack/${encodeURIComponent(entry.name)}/${encodeURIComponent(f)}`
                }));
            if (stickers.length > 0) packs.push({ name: entry.name, stickers, preview: stickers[0].url });
        }
        packs.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        res.json({ packs });
    } catch (e) { console.error('Sticker API:', e); res.json({ packs: [] }); }
});

// ── ОНЛАЙН-СЧЁТЧИК ────────────────────────────────────────────────────────────
app.get('/api/stats/online', async (req, res) => {
    try {
        const row   = await global.db.get("SELECT COUNT(*) c FROM users WHERE status='online'");
        const total = await global.db.get('SELECT COUNT(*) c FROM users');
        res.json({ online: row.c, total: total.c });
    } catch { res.json({ online: 0, total: 0 }); }
});

// ── ЭКСПОРТ ЧАТА ──────────────────────────────────────────────────────────────
app.get('/api/chat/export', async (req, res) => {
    const { phone, chatId } = req.query;
    if (!phone || !chatId) return res.status(400).json({ error: 'Нужны phone и chatId' });
    const isParticipant = chatId.includes(phone) ||
        await global.db.get('SELECT 1 FROM group_members WHERE groupId=$1 AND phone=$2', [chatId, phone]).catch(()=>null);
    if (!isParticipant) return res.status(403).json({ error: 'Нет доступа' });
    const msgs = await global.db.all(
        'SELECT senderName,text,timestamp,audioUrl,videoUrl,fileUrl FROM messages WHERE chatId=$1 ORDER BY timestamp ASC',
        [chatId]
    );
    const lines = msgs.map(m => {
        const time    = new Date(m.timestamp).toLocaleString('ru-RU');
        const content = m.text || (m.audioUrl?'[Голосовое]':m.videoUrl$1'[Видео]':m.fileUrl$1'[Файл]':'');
        return `[${time}] ${m.senderName}: ${content}`;
    });
    const out = `БАЗА Мессенджер — история чата\nЭкспорт: ${new Date().toLocaleString('ru-RU')}\n${'─'.repeat(50)}\n${lines.join('\n')}`;
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="baza_chat.txt"');
    res.send(out);
});

app.get('/api/stats/online', async (req, res) => {
    try {
        const row = await global.db.get("SELECT COUNT(*) c FROM users WHERE status='online'");
        const total = await global.db.get('SELECT COUNT(*) c FROM users');
        res.json({ online: row.c, total: total.c });
    } catch { res.json({ online: 0, total: 0 }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// 🤖 AI API — Mistral AI
// ════════════════════════════════════════════════════════════════════════════════

// Вспомогательная: проверить доступ к AI
async function checkAiAccess(phone) {
    if (!global.db) return { error: 'Сервер запускается, подождите несколько секунд', status: 503 };
    if (!phone) return { error: 'Не передан phone', status: 400 };
    try {
        const user = await global.db.get('SELECT isPremium FROM users WHERE phone=$1', [phone]);
        if (!user) return { error: 'Пользователь не найден', status: 404 };
        if (!user.isPremium) return { error: 'Функция доступна только в БАЗА Плюс', status: 403 };
    } catch(e) {
        return { error: 'Ошибка БД: ' + e.message, status: 500 };
    }
    if (!getAiProvider()) return { error: 'AI не настроен. Добавьте MISTRAL_API_KEY или GROQ_API_KEY в .env', status: 503 };
    return null;
}

// 1. Быстрые ответы (Mistral)
app.post('/api/ai/smart-reply', async (req, res) => {
    try {
        const { phone, chatId, messages } = req.body;
        if (!phone || !chatId) return res.status(400).json({ error: 'Нет параметров' });
        const err = await checkAiAccess(phone);
        if (err) return res.status(err.status).json({ error: err.error });

        const lastMsgs = (messages || []).slice(-6)
            .map(m => `${m.senderName}: ${m.text || '[медиа]'}`)
            .join('\n');

        const raw = await mistralChat([
            {
                role: 'system',
                content: 'Ты помощник в мессенджере. На основе последних сообщений предложи ровно 3 коротких варианта ответа на русском. Верни ТОЛЬКО JSON массив строк без пояснений и без markdown-блоков: ["вариант1","вариант2","вариант3"]'
            },
            { role: 'user', content: `Сообщения:\n${lastMsgs}\n\nПредложи 3 варианта ответа.` }
        ], { maxTokens: 200, temperature: 0.7 });

        let replies = ['Понял', 'Хорошо!', 'Спасибо'];
        try {
            const clean = raw.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(clean);
            if (Array.isArray(parsed) && parsed.length) replies = parsed.slice(0, 3);
        } catch (_) {}

        await global.db.run(
            'INSERT INTO ai_history (phone,chatId,type,request,response,model,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [phone, chatId, 'smart_reply', lastMsgs.slice(0, 500), JSON.stringify(replies), getAiProvider()$1.name||'ai', ts()]
        ).catch(() => {});

        res.json({ replies });
    } catch (e) {
        console.error('smart-reply error:', e.message);
        res.json({ replies: ['Понял', 'Хорошо!', 'Спасибо'], warning: e.message });
    }
});

// 2. Транскрипция голоса — Mistral Voxtral
app.post('/api/ai/transcribe', async (req, res) => {
    try {
        const { phone, audioUrl } = req.body;
        if (!phone || !audioUrl) return res.status(400).json({ error: 'Нет параметров' });
        const err = await checkAiAccess(phone);
        if (err) return res.status(err.status).json({ error: err.error });

        const cleanUrl = audioUrl.replace(/\.\./g, '').replace(/^\//, '');
        const filePath = path.join(__dirname, cleanUrl);

        const text = await transcribeAudio(filePath);

        await global.db.run(
            'INSERT INTO ai_history (phone,type,request,response,model,timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
            [phone, 'transcribe', audioUrl, text.slice(0, 1000), 'voxtral-mini-2507', ts()]
        ).catch(() => {});

        res.json({ text, engine: 'voxtral-mini-2507' });
    } catch (e) {
        console.error('Transcribe error:', e.message);
        res.status(500).json({ error: 'Ошибка транскрипции: ' + e.message });
    }
});

// ── Бан-кэш по хостам (429 / 403 / 503) ────────────────────────────────────
const _hostBan = {};
function isHostBanned(host) { return (_hostBan[host] || 0) > Date.now(); }
function banHost(host, ms) {
    _hostBan[host] = Date.now() + ms;
    console.warn(`⛔ [sticker] ${host} пауза ${Math.round(ms / 1000)}с`);
}

// ── GET картинка по URL → Buffer ─────────────────────────────────────────────
async function fetchImage(url, timeoutMs = 40000) {
    const host = new URL(url).hostname;
    if (isHostBanned(host)) throw Object.assign(new Error(`${host} на паузе`), { code: 'BANNED' });
    const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxRedirects: 6,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/png,image/jpeg,image/webp,image/*,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://pollinations.ai/',
        },
        validateStatus: st => {
            if (st === 429) { banHost(host, 90000);  return false; }
            if (st === 403) { banHost(host, 120000); return false; }
            if (st === 500) { banHost(host, 15000);  return false; }
            if (st === 503) { banHost(host, 15000);  return false; }
            return st >= 200 && st < 300;
        }
    });
    const ct = (resp.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('image') && !ct.includes('octet-stream'))
        throw new Error(`Не изображение: ${ct.slice(0, 40)}`);
    const buf = Buffer.from(resp.data);
    if (buf.length < 500) throw new Error(`Файл слишком мал: ${buf.length}б`);
    return buf;
}

// 3. AI стикеры — gen.pollinations.ai (новый unified endpoint 2026)
app.post('/api/ai/sticker', async (req, res) => {
    try {
        const { phone, prompt } = req.body;
        if (!phone || !prompt) return res.status(400).json({ error: 'Нет параметров' });
        const err = await checkAiAccess(phone);
        if (err) return res.status(err.status).json({ error: err.error });

        // Шаг 1: AI переводит промпт на английский
        let ep = prompt.trim();
        try {
            const improved = await mistralChat([
                { role: 'system', content: 'Translate to English for image generation. Reply ONLY with English words, max 8 words, no punctuation, no quotes.' },
                { role: 'user', content: prompt }
            ], { maxTokens: 25, temperature: 0.1 });
            const t = (improved || '').trim().replace(/["'.!,]/g, '').trim();
            if (t.length > 3 && t.length < 120) ep = t;
        } catch (_) {}

        console.log(`🎨 Стикер: "${prompt}" → "${ep}"`);

        const stickerDir = path.join(STICKER_DIR, 'AI Стикеры');
        await fs.mkdir(stickerDir, { recursive: true });

        const seed = Math.floor(Math.random() * 9999999);
        const stPrompt = `cute cartoon sticker, ${ep}, white background, flat design, high quality`;

        // gen.pollinations.ai — новый unified endpoint (2026), бесплатно без ключа
        const pFull  = encodeURIComponent(stPrompt.slice(0, 200));
        const pShort = encodeURIComponent(`${ep} sticker cartoon`.slice(0, 100));

        const providers = [
            // 1. gen.pollinations.ai / flux — новый endpoint, лучшее качество
            {
                name: 'gen-flux', host: 'gen.pollinations.ai', ext: 'jpg',
                fetch: () => fetchImage(
                    `https://gen.pollinations.ai/image/${pFull}$1width=512&height=512&model=flux&nologo=true&seed=${seed}`,
                    60000
                )
            },
            // 2. gen.pollinations.ai / turbo
            {
                name: 'gen-turbo', host: 'gen.pollinations.ai', ext: 'jpg',
                fetch: () => fetchImage(
                    `https://gen.pollinations.ai/image/${pShort}$1width=512&height=512&model=turbo&nologo=true&seed=${seed+1}`,
                    45000
                )
            },
            // 3. gen.pollinations.ai / nanobanana — лёгкая быстрая модель
            {
                name: 'gen-nano', host: 'gen.pollinations.ai', ext: 'jpg',
                fetch: () => fetchImage(
                    `https://gen.pollinations.ai/image/${pShort}$1width=512&height=512&model=nanobanana&nologo=true&seed=${seed+2}`,
                    40000
                )
            },
            // 4. image.pollinations.ai — старый endpoint как резерв
            {
                name: 'img-pollinations', host: 'image.pollinations.ai', ext: 'jpg',
                fetch: () => fetchImage(
                    `https://image.pollinations.ai/prompt/${pShort}$1width=512&height=512&model=flux&nologo=true&seed=${seed+3}`,
                    55000
                )
            },
            // 5. loremflickr — случайное фото по ключевым словам (без AI, надёжно)
            {
                name: 'loremflickr', host: 'loremflickr.com', ext: 'jpg',
                fetch: () => fetchImage(
                    `https://loremflickr.com/512/512/${encodeURIComponent(ep.split(' ').slice(0,3).join(','))}$1lock=${seed % 9999}`,
                    20000
                )
            },
        ];

        let lastError = null;
        for (const prov of providers) {
            if (isHostBanned(prov.host)) {
                console.log(`⏭  [${prov.name}] пропускаем (бан)`);
                continue;
            }
            try {
                console.log(`🎨 [${prov.name}] запрос...`);
                const buf = await prov.fetch();
                const fileName = `ai_${Date.now()}.${prov.ext}`;
                await fs.writeFile(path.join(stickerDir, fileName), buf);
                console.log(`✅ [${prov.name}] OK — ${fileName} (${(buf.length/1024).toFixed(0)}кб)`);
                return res.json({
                    url: `/stickerpack/AI Стикеры/${fileName}`,
                    prompt, enhancedPrompt: ep, fileName,
                    provider: prov.name
                });
            } catch (e) {
                lastError = e;
                console.warn(`⚠️  [${prov.name}] ${e.message.slice(0, 80)}`);
                await new Promise(r => setTimeout(r, 800));
            }
        }

        const reason = lastError?.response?.status
            ? `HTTP ${lastError.response.status}`
            : (lastError?.code === 'ECONNABORTED' $1 'таймаут'
            :  lastError?.code === 'ENOTFOUND'    $1 'нет сети'
            :  lastError?.message?.slice(0, 60)   || 'неизвестно');
        console.error('🎨 Все провайдеры упали:', lastError?.message);
        res.status(503).json({
            error: `Не удалось сгенерировать стикер (${reason}). Попробуйте ещё раз.`
        });

    } catch (e) {
        console.error('AI sticker error:', e.message);
        res.status(500).json({ error: 'Ошибка: ' + e.message });
    }
});

// 4. НОВЫЙ: Чат с БАЗА ИИ (Mistral)
app.post('/api/ai/chat', async (req, res) => {
    try {
        const { phone, message, context } = req.body;
        if (!phone || !message) return res.status(400).json({ error: 'Нет параметров' });
        const err = await checkAiAccess(phone);
        if (err) return res.status(err.status).json({ error: err.error });

        const ctxStr = (context || []).slice(-8)
            .map(m => `${m.senderName}: ${m.text || '[медиа]'}`)
            .join('\n');

        const reply = await mistralChat([
            {
                role: 'system',
                content: `Ты БАЗА ИИ — умный ассистент в мессенджере БАЗА. Отвечай кратко, по-русски, дружелюбно.${ctxStr $1 `\n\nКонтекст диалога:\n${ctxStr}` : ''}`
            },
            { role: 'user', content: message }
        ], { maxTokens: 600, temperature: 0.75 });

        await global.db.run(
            'INSERT INTO ai_history (phone,type,request,response,model,timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
            [phone, 'chat', message.slice(0, 500), reply.slice(0, 1000), getAiProvider()$1.name||'ai', ts()]
        ).catch(() => {});

        res.json({ reply });
    } catch (e) {
        console.error('AI chat error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 5. НОВЫЙ: Суммаризация переписки (Mistral)
app.post('/api/ai/summarize', async (req, res) => {
    try {
        const { phone, chatId } = req.body;
        if (!phone || !chatId) return res.status(400).json({ error: 'Нет параметров' });
        const err = await checkAiAccess(phone);
        if (err) return res.status(err.status).json({ error: err.error });

        const msgs = await global.db.all(
            'SELECT senderName, text FROM messages WHERE chatId=$1 AND text IS NOT NULL ORDER BY timestamp DESC LIMIT 30',
            [chatId]
        );
        if (!msgs.length) return res.json({ summary: 'Нет сообщений для анализа' });

        const dialog = msgs.reverse().map(m => `${m.senderName}: ${m.text}`).join('\n');
        const summary = await mistralChat([
            { role: 'system', content: 'Кратко суммаризируй переписку на русском. Выдели ключевые темы и решения. Максимум 4 предложения.' },
            { role: 'user', content: dialog }
        ], { maxTokens: 300, temperature: 0.4 });

        res.json({ summary });
    } catch (e) {
        console.error('Summarize error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
// ИСПРАВЛЕНО: socketsByPhone определён до io.on('connection')
const socketsByPhone = {};
const activeCall     = {};
if (!global.groupCalls) global.groupCalls = {};
const groupCalls = global.groupCalls;

// Ban middleware
io.use(async (socket, next) => {
    const phone = socket.handshake.auth?.phone;
    if (!phone) return next();
    try {
        const user = await global.db?.get('SELECT isBanned FROM users WHERE phone=$1', [phone]);
        if (user?.isBanned) return next(new Error('BANNED'));
    } catch (_) {}
    next();
});

function isAdmin(key) { return key === ADMIN_KEY; }

async function auditLog({ actorPhone = null, actorType = 'user', action, targetPhone = null, severity = 'info', meta = null, ip = null, userAgent = null }) {
    if (!global.db) return;
    try {
        const id = 'log_' + uid();
        await global.db.run(
            'INSERT INTO audit_logs (id,actorPhone,actorType,action,targetPhone,severity,meta,ip,userAgent,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
                id,
                actorPhone,
                actorType,
                String(action || '').slice(0, 120),
                targetPhone,
                String(severity || 'info').slice(0, 20),
                meta ? JSON.stringify(meta).slice(0, 20000) : null,
                ip ? String(ip).slice(0, 80) : null,
                userAgent ? String(userAgent).slice(0, 240) : null,
                ts(),
            ]
        );
    } catch (_) {}
}

async function getDirSize(dir) {
    let total = 0;
    try {
        const files = await fs.readdir(dir);
        for (const f of files) {
            try { const s = await (require('fs').promises).stat(path.join(dir, f)); total += s.size; } catch (_) {}
        }
    } catch (_) {}
    return total;
}

async function getDirFiles(dir) {
    try {
        const fsSync = require('fs').promises;
        const files = await fsSync.readdir(dir);
        const result = [];
        for (const f of files) {
            try {
                const s = await fsSync.stat(path.join(dir, f));
                if (s.isFile()) result.push({ name: f, size: s.size, mtime: s.mtime });
            } catch (_) {}
        }
        return result.sort((a, b) => b.mtime - a.mtime).slice(0, 60);
    } catch (_) { return []; }
}

io.on('connection', socket => {

    // ══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════════════
    socket.on('admin:auth', ({ key }) => {
        if (!isAdmin(key)) return socket.emit('admin:auth:error', 'Неверный Admin Key');
        socket.isAdmin = true;
        socket.emit('admin:auth:ok');
    });

    socket.on('admin:get_stats', async ({ key }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const totalUsers    = (await global.db.get('SELECT COUNT(*) c FROM users')).c;
            const onlineUsers   = (await global.db.get("SELECT COUNT(*) c FROM users WHERE status='online'")).c;
            const todayStart    = new Date(); todayStart.setHours(0, 0, 0, 0);
            const messagesToday = (await global.db.get('SELECT COUNT(*) c FROM messages WHERE timestamp >= $1', [todayStart.toISOString()])).c;
            const diskUsage     = (await getDirSize(UPLOADS_DIR)) + (await getDirSize(VOICE_DIR)) + (await getDirSize(VIDEO_DIR));
            const hourlyRows = await global.db.all(
                IS_PG
                  ? `SELECT EXTRACT(HOUR FROM timestamp::timestamptz)::int AS hr, COUNT(*)::int AS cnt
                     FROM messages WHERE timestamp::timestamptz >= NOW() - INTERVAL '24 hours'
                     GROUP BY hr ORDER BY hr`
                  : `SELECT strftime('%H', timestamp) hr, COUNT(*) cnt FROM messages
                     WHERE timestamp >= datetime('now','-24 hours') GROUP BY hr ORDER BY hr`
            );
            const hourlyMap = Object.fromEntries(hourlyRows.map(r => [parseInt(r.hr), r.cnt]));
            const hourlyActivity = Array.from({ length: 24 }, (_, i) => hourlyMap[i] || 0);
            socket.emit('admin:stats:result', { totalUsers, onlineUsers, messagesToday, diskUsage, hourlyActivity });
        } catch (e) { socket.emit('admin:error', 'Ошибка статистики'); }
    });

    socket.on('admin:get_users', async ({ key }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const users = await global.db.all(
                'SELECT phone,nickname,role,isBanned,isPremium,status,lastSeen,createdAt FROM users ORDER BY createdAt DESC'
            );
            socket.emit('admin:users:result', users);
        } catch (e) { socket.emit('admin:error', 'Ошибка'); }
    });

    socket.on('admin:ban_user', async ({ key, phone, ban }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            await global.db.run('UPDATE users SET isBanned=$1 WHERE phone=$2', [ban ? 1 : 0, phone]);
            socket.emit('admin:ban:ok', { phone, isBanned: ban ? 1 : 0 });
            await auditLog({
                actorType: 'admin_key',
                action: ban ? 'admin.ban_user' : 'admin.unban_user',
                targetPhone: phone,
                severity: 'warn',
                meta: { ban: !!ban },
            });
            if (ban) {
                const sid = socketsByPhone[phone];
                if (sid) {
                    const t = io.sockets.sockets.get(sid);
                    if (t) { t.emit('auth:banned', 'Ваш аккаунт заблокирован'); t.disconnect(true); }
                }
            }
        } catch (e) { socket.emit('admin:error', 'Ошибка'); }
    });

    socket.on('admin:set_premium', async ({ key, phone, isPremium, premium, plan }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const newVal = (isPremium !== undefined ? isPremium : premium) ? 1 : 0;
            const until = newVal ? (plan?.until || null) : null;
            await global.db.run('UPDATE users SET isPremium=$1, premiumUntil=$2 WHERE phone=$3', [newVal, until, phone]);
            socket.emit('admin:premium:ok', { phone, isPremium: newVal, plan });
            await auditLog({
                actorType: 'admin_key',
                action: newVal ? 'admin.set_premium_on' : 'admin.set_premium_off',
                targetPhone: phone,
                severity: 'info',
                meta: { isPremium: newVal, plan },
            });
            const sid = socketsByPhone[phone];
            if (sid) io.to(sid).emit('premium:status', { isPremium: newVal, plan });
        } catch (e) { socket.emit('admin:error', 'Ошибка'); }
    });

    socket.on('admin:get_logs', async ({ key, limit, offset, action, actorPhone, targetPhone, severity, since, until }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const lim = Math.max(1, Math.min(parseInt(limit || 50, 10), 200));
            const off = Math.max(0, parseInt(offset || 0, 10));
            const where = [];
            const params = [];

            if (action) { where.push('action LIKE $1'); params.push(`%${String(action).trim()}%`); }
            if (severity) { where.push('severity = $1'); params.push(String(severity).trim()); }
            if (actorPhone) { where.push('actorPhone = $1'); params.push(String(actorPhone).trim()); }
            if (targetPhone) { where.push('targetPhone = $1'); params.push(String(targetPhone).trim()); }
            if (since) { where.push('timestamp >= $1'); params.push(String(since).trim()); }
            if (until) { where.push('timestamp <= $1'); params.push(String(until).trim()); }

            const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';
            const totalRow = await global.db.get(`SELECT COUNT(*) c FROM audit_logs ${w}`, params);
            const rows = await global.db.all(
                `SELECT id,actorPhone,actorType,action,targetPhone,severity,meta,ip,userAgent,timestamp
                 FROM audit_logs ${w}
                 ORDER BY timestamp DESC
                 LIMIT ? OFFSET ?`,
                [...params, lim, off]
            );
            socket.emit('admin:logs:result', { total: totalRow?.c || 0, limit: lim, offset: off, logs: rows });
        } catch (e) { socket.emit('admin:error', 'Ошибка логов'); }
    });

    socket.on('admin:delete_user', async ({ key, phone }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const sid = socketsByPhone[phone];
            if (sid) { const t = io.sockets.sockets.get(sid); if (t) t.disconnect(true); }
            await global.db.run('DELETE FROM reactions WHERE messageId IN (SELECT id FROM messages WHERE senderPhone=$1)', [phone]);
            await global.db.run('DELETE FROM messages WHERE senderPhone=$1', [phone]);
            await global.db.run('DELETE FROM contacts WHERE userPhone=$1 OR contactPhone=$2', [phone, phone]);
            await global.db.run('DELETE FROM blocked_users WHERE userPhone=$1 OR blockedPhone=$2', [phone, phone]);
            await global.db.run('DELETE FROM group_members WHERE phone=$1', [phone]);
            await global.db.run('DELETE FROM users WHERE phone=$1', [phone]);
            delete socketsByPhone[phone];
            socket.emit('admin:delete_user:ok', { phone });
        } catch (e) { socket.emit('admin:error', 'Ошибка удаления'); }
    });

    socket.on('admin:delete_message', async ({ key, messageId }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const m = await global.db.get('SELECT chatId FROM messages WHERE id=$1', [messageId]);
            if (!m) return socket.emit('admin:error', 'Сообщение не найдено');
            await global.db.run('DELETE FROM reactions WHERE messageId=$1', [messageId]);
            await global.db.run('DELETE FROM messages WHERE id=$1', [messageId]);
            await emitToChat(m.chatId, 'message:deleted', { messageId, chatId: m.chatId });
            socket.emit('admin:delete_message:ok', { messageId });
        } catch (e) { socket.emit('admin:error', 'Ошибка'); }
    });

    socket.on('admin:get_content', async ({ key }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        try {
            const [uploads, voice, videos] = await Promise.all([getDirFiles(UPLOADS_DIR), getDirFiles(VOICE_DIR), getDirFiles(VIDEO_DIR)]);
            socket.emit('admin:content:result', { uploads, voice, videos });
        } catch (e) { socket.emit('admin:error', 'Ошибка'); }
    });

    socket.on('admin:delete_file', async ({ key, folder, name }) => {
        if (!isAdmin(key)) return socket.emit('admin:error', 'Нет прав');
        const ALLOWED = { uploads: UPLOADS_DIR, voice: VOICE_DIR, videos: VIDEO_DIR };
        if (!ALLOWED[folder]) return socket.emit('admin:error', 'Неверная папка');
        const safeName = path.basename(name); // ИСПРАВЛЕНО: path traversal защита
        try {
            await fs.unlink(path.join(ALLOWED[folder], safeName));
            socket.emit('admin:delete_file:ok', { folder, name: safeName });
        } catch (e) { socket.emit('admin:error', 'Файл не найден'); }
    });

    // ══════════════════════════════════════════════════════════════════════
    // РЕГИСТРАЦИЯ / АВТОРИЗАЦИЯ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('register', async ({ phone, nickname, password, email }) => {
        try {
            const p = (phone || '').trim();
            const e = (email || '').trim().toLowerCase();
            if (!p || !nickname || !password || !e) return socket.emit('register:error', 'Email обязателен для регистрации');
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return socket.emit('register:error', 'Некорректный формат email');
            if (await global.db.get('SELECT 1 FROM users WHERE phone=$1', [p]))
                return socket.emit('register:error', 'Этот номер уже занят!');
            if (await global.db.get('SELECT 1 FROM users WHERE email=$1', [e]))
                return socket.emit('register:error', 'Email уже используется!');

            const code = genCode();
            await global.db.run(
                'INSERT INTO users (phone,nickname,passwordHash,avatar,status,email,isVerified,verificationCode,isPremium,balance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0.0)',
                [p, nickname, await bcrypt.hash(password, 10), generateAvatar(nickname), 'offline', e, 0, code]
            );
            console.log(`\n🔑 КОД ВЕРИФИКАЦИИ для ${p}: ${code}\n`);

            const sent = await sendVerificationEmail(e, code);
            socket.emit('register:needs_verification', { phone: p, email: e, emailFailed: !sent });
        } catch (err) { console.error(err); socket.emit('register:error', 'Ошибка сервера'); }
    });

    socket.on('auth:resend_code', async ({ phone }) => {
        try {
            const p = (phone || '').trim();
            const user = await global.db.get('SELECT email,isVerified FROM users WHERE phone=$1', [p]);
            if (!user) return socket.emit('verify:error', 'Пользователь не найден');
            if (user.isVerified) return socket.emit('verify:success', { phone: p });
            const code = genCode();
            await global.db.run('UPDATE users SET verificationCode=$1 WHERE phone=$2', [code, p]);
            console.log(`\n🔑 НОВЫЙ КОД для ${p}: ${code}\n`);
            if (user.email) {
                const sent = await sendVerificationEmail(user.email, code);
                socket.emit('verify:resent', { sent, email: user.email });
            } else {
                socket.emit('verify:error', 'Email не указан');
            }
        } catch (err) { socket.emit('verify:error', 'Ошибка'); }
    });

    socket.on('auth:verify_email', async ({ phone, code }) => {
        try {
            const p = (phone || '').trim();
            const user = await global.db.get('SELECT verificationCode,isVerified FROM users WHERE phone=$1', [p]);
            if (!user) return socket.emit('verify:error', 'Пользователь не найден');
            if (user.isVerified) return socket.emit('verify:success', { phone: p });
            if (user.verificationCode !== String(code).trim())
                return socket.emit('verify:error', 'Неверный код. Попробуйте ещё раз.');
            await global.db.run('UPDATE users SET isVerified=1, verificationCode=NULL WHERE phone=$1', [p]);
            socket.emit('verify:success', { phone: p });
        } catch (err) { socket.emit('verify:error', 'Ошибка подтверждения'); }
    });

    // ── ВОССТАНОВЛЕНИЕ ПАРОЛЯ ЧЕРЕЗ EMAIL ─────────────────────────────────────
    /**
     * Шаг 1: Запрос на сброс пароля — генерация токена и отправка email
     */
    socket.on('password:forgot', async ({ phone }) => {
        try {
            const p = (phone || '').trim();
            const user = await global.db.get('SELECT email, isVerified FROM users WHERE phone=$1', [p]);
            
            if (!user) {
                // Не раскрываем, существует ли пользователь — для безопасности
                return socket.emit('password:forgot:sent', { phone: p });
            }
            
            if (!user.email) {
                return socket.emit('password:forgot:error', 'Email не привязан к этому аккаунту');
            }
            
            // Генерируем токен сброса
            const token = require('crypto').randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 минут
            
            // Сохраняем токен в БД
            await global.db.run(
                'INSERT INTO password_reset_tokens (token, phone, expiresAt) VALUES ($1, $2, $3)',
                [token, p, expiresAt]
            );
            
            // Отправляем email со ссылкой
            const resetLink = `http://${process.env.HOST || 'localhost'}:${PORT}/reset-password.html$1token=${token}`;
            const sent = await sendPasswordResetEmail(user.email, resetLink);
            
            socket.emit('password:forgot:sent', { phone: p, emailSent: sent });
            
            if (!sent) {
                console.warn('⚠️  Письмо со сбросом пароля не отправлено (SMTP не настроен)');
            }
        } catch (err) {
            console.error('password:forgot error:', err);
            socket.emit('password:forgot:error', 'Ошибка сервера при запросе сброса пароля');
        }
    });
    
    /**
     * Шаг 2: Проверка токена (при загрузке страницы сброса)
     */
    socket.on('password:check_token', async ({ token }) => {
        try {
            if (!token) return socket.emit('password:token:invalid');
            
            const record = await global.db.get(
                'SELECT phone, expiresAt, used FROM password_reset_tokens WHERE token=$1',
                [token]
            );
            
            if (!record) return socket.emit('password:token:invalid');
            if (record.used) return socket.emit('password:token:used');
            if (new Date(record.expiresAt) < new Date()) {
                // Токен истёк — удаляем
                await global.db.run('DELETE FROM password_reset_tokens WHERE token=$1', [token]);
                return socket.emit('password:token:expired');
            }
            
            socket.emit('password:token:valid', { phone: record.phone });
        } catch (err) {
            console.error('password:check_token error:', err);
            socket.emit('password:token:invalid');
        }
    });
    
    /**
     * Шаг 3: Установка нового пароля
     */
    socket.on('password:reset', async ({ token, newPassword }) => {
        try {
            if (!token || !newPassword) {
                return socket.emit('password:reset:error', 'Токен и новый пароль обязательны');
            }
            
            if (newPassword.length < 6) {
                return socket.emit('password:reset:error', 'Пароль должен быть не менее 6 символов');
            }
            
            const record = await global.db.get(
                'SELECT phone, expiresAt, used FROM password_reset_tokens WHERE token=$1',
                [token]
            );
            
            if (!record) return socket.emit('password:reset:error', 'Неверный токен');
            if (record.used) return socket.emit('password:reset:error', 'Токен уже использован');
            if (new Date(record.expiresAt) < new Date()) {
                await global.db.run('DELETE FROM password_reset_tokens WHERE token=$1', [token]);
                return socket.emit('password:reset:error', 'Токен истёк');
            }
            
            // Хешируем новый пароль
            const passwordHash = await bcrypt.hash(newPassword, 10);
            
            // Обновляем пароль в БД
            await global.db.run('UPDATE users SET passwordHash=$1 WHERE phone=$2', [passwordHash, record.phone]);
            
            // Помечаем токен как использованный
            await global.db.run('UPDATE password_reset_tokens SET used=1 WHERE token=$1', [token]);
            
            // Логируем событие
            await auditLog({
                actorPhone: record.phone,
                actorType: 'user',
                action: 'password.reset',
                targetPhone: record.phone,
                severity: 'warning'
            });
            
            socket.emit('password:reset:success', { phone: record.phone });
        } catch (err) {
            console.error('password:reset error:', err);
            socket.emit('password:reset:error', 'Ошибка сервера при сбросе пароля');
        }
    });

    socket.on('auth', async ({ phone, password }) => {
        try {
            const p = (phone || '').trim();
            let user = await global.db.get('SELECT * FROM users WHERE phone=$1', [p]);
            if (!user || !(await bcrypt.compare(password, user.passwordHash)))
                return socket.emit('auth:error', 'Неверный номер или пароль');
            if (user.isBanned) return socket.emit('auth:error', 'Ваш аккаунт заблокирован.');
            if (!user.isVerified) return socket.emit('auth:error', 'Сначала подтвердите почту.');

            // Premium expiry check (best-effort)
            if (user.isPremium && user.premiumUntil) {
                const exp = Date.parse(user.premiumUntil);
                if (!Number.isNaN(exp) && exp <= Date.now()) {
                    await global.db.run('UPDATE users SET isPremium=0, premiumUntil=NULL WHERE phone=$1', [p]).catch(()=>{});
                    user = { ...user, isPremium: 0, premiumUntil: null };
                }
            }

            await global.db.run('UPDATE users SET socketId=$1,status=$2 WHERE phone=$3', [socket.id, 'online', p]);
            socket.phone    = p;
            socket.nickname = user.nickname;
            socket.avatar   = user.avatar;
            socket.isPremium = user.isPremium || 0;
            socketsByPhone[p] = socket.id;

            socket.emit('auth:success', { phone: p, nickname: user.nickname, avatar: user.avatar, isPremium: socket.isPremium });
            await auditLog({ actorPhone: p, actorType: 'user', action: 'auth.login', targetPhone: p, severity: 'info' });

            // История сообщений (личные + группы)
            const msgQ = `SELECT m.*,(SELECT json_group_array(json_object('emoji',emoji,'senderPhone',senderPhone)) FROM reactions WHERE messageId=m.id) as rxns FROM messages m`;
            const direct = await global.db.all(msgQ + ` WHERE m.chatId LIKE $1 ORDER BY m.id DESC LIMIT 200`, [`%${p}%`]);
            const groups  = await global.db.all(`SELECT g.* FROM groups g JOIN group_members gm ON gm.groupId=g.id WHERE gm.phone=$1`, [p]);
            let groupMsgs = [];
            for (const g of groups) {
                const gm = await global.db.all(msgQ + ` WHERE m.chatId=$1 ORDER BY m.id DESC LIMIT 100`, [g.id]);
                groupMsgs.push(...gm);
            }
            const allMsgs = [...direct, ...groupMsgs].map(parseMsg).sort((a, b) => a.id < b.id ? -1 : 1);

            socket.emit('chat:history', allMsgs);
            socket.emit('groups:list', groups);

            const myChannels = await global.db.all(
                `SELECT c.*,cs.role as myRole FROM channels c
                 JOIN channel_subscribers cs ON cs.channelId=c.id WHERE cs.phone=?`, [p]
            );
            socket.emit('channel:my:list', myChannels);

            const nowTs = new Date().toISOString();
            const stories = await global.db.all(
                `SELECT s.*,
                    (SELECT COUNT(*) FROM story_views WHERE storyId=s.id) as viewCount,
                    (SELECT 1 FROM story_views WHERE storyId=s.id AND viewerPhone=?) as viewed
                 FROM stories s WHERE s.expiresAt>? ORDER BY s.createdAt DESC LIMIT 100`,
                [p, nowTs]
            );
            socket.emit('stories:list', stories);
            io.emit('user:status', { phone: p, status: 'online' });
        } catch (err) { console.error(err); socket.emit('auth:error', 'Ошибка сервера'); }
    });

    // ── МУЛЬТИАККАУНТ: проверить второй аккаунт (без смены сессии) ──────────
    socket.on('auth:add_account', async ({ phone, password }) => {
        try {
            const p = (phone || '').trim();
            const user = await global.db.get('SELECT * FROM users WHERE phone=$1', [p]);
            if (!user || !(await bcrypt.compare(password, user.passwordHash)))
                return socket.emit('auth:add_account:error', 'Неверный номер или пароль');
            if (user.isBanned) return socket.emit('auth:add_account:error', 'Аккаунт заблокирован');
            if (!user.isVerified) return socket.emit('auth:add_account:error', 'Сначала подтвердите почту');
            socket.emit('auth:add_account:ok', { phone: p, nickname: user.nickname });
        } catch (e) { socket.emit('auth:add_account:error', 'Ошибка сервера'); }
    });

    // ── МУЛЬТИАККАУНТ: переключить активный аккаунт в той же сессии ─────────
    socket.on('auth:switch', async ({ phone, password }) => {
        try {
            const p = (phone || '').trim();
            const user = await global.db.get('SELECT * FROM users WHERE phone=$1', [p]);
            if (!user || !(await bcrypt.compare(password, user.passwordHash)))
                return socket.emit('auth:switch:error', 'Неверные данные');
            if (user.isBanned) return socket.emit('auth:switch:error', 'Аккаунт заблокирован');
            if (!user.isVerified) return socket.emit('auth:switch:error', 'Сначала подтвердите почту');

            // Обновить старый аккаунт — offline
            if (socket.phone && socket.phone !== p) {
                await global.db.run('UPDATE users SET status=$1,lastSeen=$2 WHERE phone=$3', ['offline', ts(), socket.phone]);
                delete socketsByPhone[socket.phone];
                io.emit('user:status', { phone: socket.phone, status: 'offline', lastSeen: ts() });
            }

            // Активировать новый
            await global.db.run('UPDATE users SET socketId=$1,status=$2 WHERE phone=$3', [socket.id, 'online', p]);
            socket.phone     = p;
            socket.nickname  = user.nickname;
            socket.avatar    = user.avatar;
            socket.isPremium = user.isPremium || 0;
            socketsByPhone[p] = socket.id;

            socket.emit('auth:switch:ok', { phone: p, nickname: user.nickname, avatar: user.avatar, isPremium: socket.isPremium });

            // Перезагружаем чаты, группы, каналы для нового аккаунта
            const msgQ = `SELECT m.*,(SELECT json_group_array(json_object('emoji',emoji,'senderPhone',senderPhone)) FROM reactions WHERE messageId=m.id) as rxns FROM messages m`;
            const direct = await global.db.all(msgQ + ` WHERE m.chatId LIKE $1 ORDER BY m.id DESC LIMIT 200`, [`%${p}%`]);
            const groups  = await global.db.all(`SELECT g.* FROM groups g JOIN group_members gm ON gm.groupId=g.id WHERE gm.phone=$1`, [p]);
            let groupMsgs = [];
            for (const g of groups) {
                const gm = await global.db.all(msgQ + ` WHERE m.chatId=$1 ORDER BY m.id DESC LIMIT 100`, [g.id]);
                groupMsgs.push(...gm);
            }
            const allMsgs = [...direct, ...groupMsgs].map(parseMsg).sort((a, b) => a.id < b.id ? -1 : 1);
            socket.emit('chat:history', allMsgs);
            socket.emit('groups:list', groups);

            const myChannels = await global.db.all(
                `SELECT c.*,cs.role as myRole FROM channels c JOIN channel_subscribers cs ON cs.channelId=c.id WHERE cs.phone=$1`, [p]
            );
            socket.emit('channel:my:list', myChannels);
            io.emit('user:status', { phone: p, status: 'online' });
        } catch (e) { console.error('auth:switch error:', e); socket.emit('auth:switch:error', 'Ошибка сервера'); }
    });

    socket.on('profile:update', async ({ nickname, bio }) => {
        if (!socket.phone) return;
        const n = (nickname || '').trim();
        const b = (bio || '').trim();
        if (n) {
            await global.db.run('UPDATE users SET nickname=$1,bio=$2 WHERE phone=$3', [n, b, socket.phone]);
            socket.nickname = n;
        }
        socket.emit('profile:updated', { nickname: n, bio: b });
    });

    socket.on('avatar:update', async ({ avatarData }) => {
        if (!socket.phone || !avatarData) return;
        await global.db.run('UPDATE users SET avatar=$1 WHERE phone=$2', [avatarData, socket.phone]);
        socket.avatar = avatarData;
        socket.emit('avatar:updated', { avatar: avatarData });
    });

    socket.on('profile:get', async ({ phone }) => {
        if (!socket.phone) return;
        const u = await global.db.get(
            'SELECT phone,nickname,avatar,status,bio,isPremium,lastSeen FROM users WHERE phone=$1',
            [phone || socket.phone]
        );
        if (u) socket.emit('profile:data', u);
    });

    // ══════════════════════════════════════════════════════════════════════
    // КОНТАКТЫ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('contact:add', async phone => {
        try {
            const p = (phone || '').trim();
            if (p === socket.phone) return socket.emit('contact:add:error', 'Нельзя добавить себя');
            const user = await global.db.get('SELECT phone,nickname,avatar FROM users WHERE phone=$1', [p]);
            if (!user) return socket.emit('contact:add:error', 'Пользователь не найден');
            await global.db.run('INSERT OR IGNORE INTO contacts (userPhone,contactPhone,nickname) VALUES ($1,$2,$3)',
                [socket.phone, p, user.nickname]);
            const chatId = [socket.phone, p].sort().join('_');
            socket.emit('chat:created', { id: chatId, name: user.nickname, phone: user.phone, avatar: user.avatar });
        } catch (_) { socket.emit('contact:add:error', 'Ошибка'); }
    });

    socket.on('contact:search', async query => {
        const q = (query || '').trim();
        const r = await global.db.all(
            'SELECT phone,nickname,avatar,status FROM users WHERE (phone LIKE $1 OR nickname LIKE $2) AND phone!=$3 LIMIT 20',
            [q ? `%${q}%` : '%', q $1 `%${q}%` : '%', socket.phone]
        );
        socket.emit('contact:search:results', r);
    });

    // ══════════════════════════════════════════════════════════════════════
    // СООБЩЕНИЯ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('message:send', async ({ chatId, text, replyTo }) => {
        if (!socket.phone || !text?.trim()) return;
        const msg = buildMsg(socket.phone, socket.nickname, chatId, { text: text.trim(), replyTo: replyTo || null });
        await saveMsg(msg);

        // ── @упоминания ────────────────────────────────────────────────────────
        const mentions = (text.match(/@([a-zA-Zа-яА-ЯёЁ0-9_]+)/g) || []).map(m => m.slice(1));
        for (const nick of mentions) {
            const mentioned = await global.db.get('SELECT phone FROM users WHERE nickname=$1', [nick]).catch(()=>null);
            if (mentioned && mentioned.phone !== socket.phone) {
                const sid = socketsByPhone[mentioned.phone];
                if (sid) io.to(sid).emit('mention:received', {
                    chatId, messageId: msg.id,
                    from: socket.nickname, text: text.trim().slice(0, 80)
                });
            }
        }

        // ── Автоответ «Не в сети» ──────────────────────────────────────────────
        if (!chatId.startsWith('g_')) {
            const recipientPhone = chatId.split('_').find(p => p !== socket.phone);
            if (recipientPhone) {
                const recip = await global.db.get(
                    'SELECT autoReply,autoReplyText,status FROM users WHERE phone=$1', [recipientPhone]
                ).catch(()=>null);
                if (recip?.autoReply && recip.status !== 'online') {
                    const replyText = recip.autoReplyText || '🤖 Сейчас не в сети. Отвечу позже!';
                    const autoMsg = buildMsg(recipientPhone, '🤖 Автоответ', chatId, { text: replyText });
                    await global.db.run(
                        'INSERT INTO messages (id,chatId,senderPhone,senderName,text,timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
                        [autoMsg.id, chatId, recipientPhone, '🤖 Автоответ', replyText, autoMsg.timestamp]
                    ).catch(()=>{});
                    await emitToChat(chatId, 'message:receive', { chatId, message: autoMsg });
                }
            }
        }

        // @бот — БАЗА ИИ на Mistral (только для Плюс)
        if (text.trim().startsWith('@бот') && getAiProvider()) {
            const userRow = await global.db.get('SELECT isPremium FROM users WHERE phone=$1', [socket.phone]).catch(() => null);
            if (userRow?.isPremium) {
                (async () => {
                    try {
                        const recent = await global.db.all(
                            'SELECT senderName,text FROM messages WHERE chatId=$1 AND text IS NOT NULL ORDER BY timestamp DESC LIMIT 10',
                            [chatId]
                        );
                        const ctx = recent.reverse().map(m => `${m.senderName}: ${m.text}`).join('\n');
                        const prompt = text.slice(4).trim() || 'Помоги с этим разговором';

                        const aiText = await mistralChat([
                            { role: 'system', content: `Ты БАЗА ИИ — ассистент в мессенджере. Отвечай кратко по-русски.\n\nКонтекст:\n${ctx}` },
                            { role: 'user', content: prompt }
                        ], { maxTokens: 500 });

                        const botMsg = buildMsg('ai_bot', '🤖 БАЗА ИИ', chatId, { text: aiText, replyTo: msg.id });
                        await global.db.run(
                            'INSERT INTO messages (id,chatId,senderPhone,senderName,text,timestamp,replyTo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                            [botMsg.id, chatId, 'ai_bot', '🤖 БАЗА ИИ', aiText, botMsg.timestamp, msg.id]
                        );
                        await emitToChat(chatId, 'message:receive', { chatId, message: botMsg });
                    } catch (e) { console.error('AI bot error:', e.message); }
                })();
            }
        }

        await emitToChat(chatId, 'message:receive', { chatId, message: msg });
    });

    socket.on('voice:send', async ({ chatId, audioData, duration }) => {
        if (!chatId || !audioData) return;
        const name = `${uid()}-${socket.phone}.webm`;
        await fs.writeFile(path.join(VOICE_DIR, name), Buffer.from(audioData));
        const msg = buildMsg(socket.phone, socket.nickname, chatId, { text: '🎤 Голосовое', audioUrl: `/voice/${name}`, duration: duration || 0 });
        await saveMsg(msg);
        await emitToChat(chatId, 'message:receive', { chatId, message: msg });
    });

    socket.on('video:send', async ({ chatId, videoData, duration }) => {
        if (!chatId || !videoData) return;
        const name = `${uid()}-${socket.phone}.webm`;
        await fs.writeFile(path.join(VIDEO_DIR, name), Buffer.from(videoData));
        const msg = buildMsg(socket.phone, socket.nickname, chatId, { text: '🎬 Видео', videoUrl: `/videos/${name}`, duration: duration || 0 });
        await saveMsg(msg);
        await emitToChat(chatId, 'message:receive', { chatId, message: msg });
    });

    socket.on('file:send', async ({ chatId, fileName, fileData }) => {
        if (!chatId || !fileName || !fileData) return;
        const safe = `${Date.now()}-${path.basename(fileName)}`;
        await fs.writeFile(path.join(UPLOADS_DIR, safe), Buffer.from(fileData));
        const msg = buildMsg(socket.phone, socket.nickname, chatId, {
            text: isImg(fileName) ? `🖼️ ${fileName}` : `📁 ${fileName}`,
            fileUrl: `/uploads/${safe}`
        });
        await saveMsg(msg);
        await emitToChat(chatId, 'message:receive', { chatId, message: msg });
    });

    socket.on('sticker:send', async ({ chatId, stickerUrl }) => {
        if (!chatId || !stickerUrl) return;
        const msg = buildMsg(socket.phone, socket.nickname, chatId, { text: '🎭 Стикер', fileUrl: stickerUrl, isSticker: true });
        await global.db.run(
            'INSERT INTO messages (id,chatId,senderPhone,senderName,text,fileUrl,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [msg.id, msg.chatId, msg.senderPhone, msg.senderName, msg.text, msg.fileUrl, msg.timestamp]
        );
        await emitToChat(chatId, 'message:receive', { chatId, message: msg });
    });

    socket.on('message:edit', async ({ messageId, newText }) => {
        if (!newText?.trim()) return;
        const m = await global.db.get('SELECT * FROM messages WHERE id=$1', [messageId]);
        if (!m || m.senderPhone !== socket.phone) return;
        const editedAt = ts();
        await global.db.run('UPDATE messages SET text=$1,isEdited=1,editedAt=$2 WHERE id=$3', [newText.trim(), editedAt, messageId]);
        await emitToChat(m.chatId, 'message:updated', { messageId, chatId: m.chatId, newText: newText.trim(), isEdited: 1, editedAt });
    });

    socket.on('message:delete', async ({ messageId, deleteForAll }) => {
        const m = await global.db.get('SELECT * FROM messages WHERE id=$1', [messageId]);
        if (!m) return;
        if (deleteForAll && m.senderPhone === socket.phone) {
            await global.db.run('DELETE FROM reactions WHERE messageId=$1', [messageId]);
            await global.db.run('DELETE FROM messages WHERE id=$1', [messageId]);
            await emitToChat(m.chatId, 'message:deleted', { messageId, chatId: m.chatId });
        } else {
            socket.emit('message:deleted', { messageId, chatId: m.chatId });
        }
    });

    socket.on('message:forward', async ({ messageId, toChatId }) => {
        if (!socket.phone || !messageId || !toChatId) return;
        const orig = await global.db.get(
            'SELECT text,fileUrl,audioUrl,videoUrl,senderName FROM messages WHERE id=$1',
            [messageId]
        );
        if (!orig) return socket.emit('error', 'Сообщение не найдено');
 
        const fwdText = orig.text
            ? `↩ Переслано от ${orig.senderName}:\n${orig.text}`
            : `↩ Переслано от ${orig.senderName}`;
 
        const msg = buildMsg(socket.phone, socket.nickname, toChatId, {
            text: fwdText,
            fileUrl: orig.fileUrl || null,
            audioUrl: orig.audioUrl || null,
            videoUrl: orig.videoUrl || null,
            isForwarded: 1
        });
        await global.db.run(
            `INSERT INTO messages (id,chatId,senderPhone,senderName,text,fileUrl,audioUrl,videoUrl,timestamp,replyTo)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [msg.id, toChatId, socket.phone, socket.nickname,
             msg.text, msg.fileUrl||null, msg.audioUrl||null, msg.videoUrl||null,
             msg.timestamp, null]
        );
        await emitToChat(toChatId, 'message:receive', { chatId: toChatId, message: msg });
        socket.emit('message:forwarded', { messageId, toChatId });
    });

    socket.on('message:pin', async ({ messageId, chatId }) => {
        if (!socket.phone || !messageId || !chatId) return;
        // Только admin группы или участник личного чата
        const msg = await global.db.get('SELECT id,text,senderName FROM messages WHERE id=$1 AND chatId=$2', [messageId, chatId]);
        if (!msg) return;
        await global.db.run(
            'INSERT OR REPLACE INTO pinned_messages (chatId,messageId,pinnedBy,pinnedAt) VALUES ($1,$2,$3,$4)',
            [chatId, messageId, socket.phone, ts()]
        );
        await emitToChat(chatId, 'message:pinned', { chatId, messageId, text: msg.text, senderName: msg.senderName, pinnedBy: socket.nickname });
    });
 
    socket.on('message:unpin', async ({ chatId }) => {
        if (!socket.phone || !chatId) return;
        await global.db.run('DELETE FROM pinned_messages WHERE chatId=$1', [chatId]);
        await emitToChat(chatId, 'message:unpinned', { chatId });
    });
 
    socket.on('message:get_pinned', async ({ chatId }) => {
        if (!socket.phone || !chatId) return;
        const row = await global.db.get(
            `SELECT pm.*,m.text,m.senderName FROM pinned_messages pm
             JOIN messages m ON m.id=pm.messageId WHERE pm.chatId=?`, [chatId]
        );
        socket.emit('message:pinned:data', { chatId, pinned: row || null });
    });

    socket.on('message:read', async ({ chatId }) => {
        if (!chatId || !socket.phone) return;
        await global.db.run('UPDATE messages SET isRead=1 WHERE chatId=$1 AND senderPhone!=$2 AND isRead=0', [chatId, socket.phone]);
        const senders = chatId.startsWith('g_')
            ? (await global.db.all('SELECT phone FROM group_members WHERE groupId=$1', [chatId])).map(r => r.phone).filter(p => p !== socket.phone)
            : chatId.split('_').filter(p => p !== socket.phone);
        senders.forEach(p => { const s = socketsByPhone[p]; if (s) io.to(s).emit('message:read:ack', { chatId, readerPhone: socket.phone }); });
    });

    socket.on('reaction:toggle', async ({ messageId, emoji }) => {
        const m = await global.db.get('SELECT chatId FROM messages WHERE id=$1', [messageId]);
        if (!m) return;
        const has = await global.db.get('SELECT 1 FROM reactions WHERE messageId=$1 AND senderPhone=$2 AND emoji=$3', [messageId, socket.phone, emoji]);
        if (has) await global.db.run('DELETE FROM reactions WHERE messageId=$1 AND senderPhone=$2 AND emoji=$3', [messageId, socket.phone, emoji]);
        else     await global.db.run('INSERT OR IGNORE INTO reactions (messageId,senderPhone,emoji) VALUES ($1,$2,$3)', [messageId, socket.phone, emoji]);
        const reactions = await global.db.all('SELECT emoji,senderPhone FROM reactions WHERE messageId=$1', [messageId]);
        await emitToChat(m.chatId, 'reaction:update', { messageId, reactions });
    });

    // ══════════════════════════════════════════════════════════════════════
    // ЧАТЫ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('chat:load', async ({ chatId }) => {
        if (!socket.phone || !chatId) return;
        try {
            const msgs = (await global.db.all(
                `SELECT m.*,(SELECT json_group_array(json_object('emoji',emoji,'senderPhone',senderPhone)) FROM reactions WHERE messageId=m.id) as rxns
                 FROM messages m WHERE m.chatId=? ORDER BY m.id ASC LIMIT 200`, [chatId]
            )).map(parseMsg);
            socket.emit('chat:load:result', { chatId, messages: msgs });

            if (!chatId.startsWith('g_')) {
                const phones = chatId.split('_').filter(p => p !== socket.phone);
                if (phones.length > 0) {
                    const other = await global.db.get('SELECT phone,nickname,avatar,status,isPremium FROM users WHERE phone=$1', [phones[0]]);
                    if (other) socket.emit('chat:user:info', { chatId, user: other });
                }
            }
        } catch (e) { console.error('chat:load error', e); }
    });

    socket.on('chat:clear', async ({ chatId }) => {
        await global.db.run('DELETE FROM reactions WHERE messageId IN (SELECT id FROM messages WHERE chatId=$1)', [chatId]);
        await global.db.run('DELETE FROM messages WHERE chatId=$1', [chatId]);
        await emitToChat(chatId, 'chat:cleared', { chatId });
    });

    socket.on('chat:delete', async ({ chatId }) => {
        await global.db.run('DELETE FROM reactions WHERE messageId IN (SELECT id FROM messages WHERE chatId=$1)', [chatId]);
        await global.db.run('DELETE FROM messages WHERE chatId=$1', [chatId]);
        if (!chatId.startsWith('g_')) {
            const other = chatId.split('_').find(p => p !== socket.phone);
            if (other) await global.db.run(
                'DELETE FROM contacts WHERE (userPhone=$1 AND contactPhone=$2) OR (userPhone=$3 AND contactPhone=$4)',
                [socket.phone, other, other, socket.phone]
            );
        }
        socket.emit('chat:deleted', { chatId });
    });

    socket.on('user:block', async ({ targetPhone }) => {
        await global.db.run('INSERT OR IGNORE INTO blocked_users (userPhone,blockedPhone) VALUES ($1,$2)', [socket.phone, targetPhone]);
        socket.emit('user:blocked', { targetPhone });
    });

    socket.on('user:unblock', async ({ targetPhone }) => {
        await global.db.run('DELETE FROM blocked_users WHERE userPhone=$1 AND blockedPhone=$2', [socket.phone, targetPhone]);
        socket.emit('user:unblocked', { targetPhone });
    });

    socket.on('chat:files', async ({ chatId }) => {
        const files = await global.db.all(
            `SELECT id,fileUrl,audioUrl,videoUrl,text,timestamp,senderName FROM messages
             WHERE chatId=? AND (fileUrl IS NOT NULL OR audioUrl IS NOT NULL OR videoUrl IS NOT NULL)
             ORDER BY timestamp DESC LIMIT 300`, [chatId]
        );
        socket.emit('chat:files:result', { chatId, files });
    });

    socket.on('typing', ({ chatId, isTyping }) => {
        if (!chatId) return;
        const data = { phone: socket.phone, nickname: socket.nickname, chatId, isTyping };
        if (chatId.startsWith('g_')) {
            emitToChat(chatId, 'user:typing', data);
        } else {
            const p = chatId.split('_').find(x => x !== socket.phone);
            const s = socketsByPhone[p]; if (s) io.to(s).emit('user:typing', data);
        }
    });

    socket.on('draft:save', async ({ chatId, text }) => {
        if (!socket.phone || !chatId) return;
        if (!text?.trim()) {
            await global.db.run('DELETE FROM drafts WHERE phone=$1 AND chatId=$2', [socket.phone, chatId]).catch(() => {});
        } else {
            await global.db.run(
                'INSERT OR REPLACE INTO drafts (phone,chatId,text,updatedAt) VALUES ($1,$2,$3,$4)',
                [socket.phone, chatId, text.trim().slice(0, 4000), ts()]
            ).catch(() => {});
        }
    });
 
    socket.on('draft:get', async ({ chatId }) => {
        if (!socket.phone || !chatId) return;
        const row = await global.db.get(
            'SELECT text FROM drafts WHERE phone=$1 AND chatId=$2', [socket.phone, chatId]
        ).catch(() => null);
        socket.emit('draft:data', { chatId, text: row$1.text || '' });
    });
 
    socket.on('draft:get_all', async () => {
        if (!socket.phone) return;
        const rows = await global.db.all(
            'SELECT chatId,text,updatedAt FROM drafts WHERE phone=$1 ORDER BY updatedAt DESC',
            [socket.phone]
        ).catch(() => []);
        socket.emit('draft:all', rows);
    });

    socket.on('user:status:request', async phones => {
        if (!Array.isArray(phones) || !phones.length) return;
        // Динамический IN() — генерируем плейсхолдеры (? для SQLite, $1,$2 для PG)
        const ph = IS_PG
            ? phones.map((_, i) => `$${i + 1}`).join(',')
            : phones.map(() => '$1').join(',');
        const rows = await global.db.all(
            `SELECT phone,status,"lastSeen" FROM users WHERE phone IN (${ph})`, phones
        );
        rows.forEach(r => socket.emit('user:status', { phone: r.phone, status: r.status, lastSeen: r.lastSeen }));
    });

    // ══════════════════════════════════════════════════════════════════════
    // ГРУППЫ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('group:create', async ({ name, memberPhones }) => {
        try {
            if (!name?.trim()) return socket.emit('group:error', 'Введите название');
            const id = 'g_' + uid();
            const members = [...new Set([socket.phone, ...(memberPhones || [])])];
            await global.db.run('INSERT INTO groups (id,name,avatar,createdBy) VALUES ($1,$2,$3,$4)',
                [id, name.trim(), generateAvatar(name), socket.phone]);
            for (const p of members)
                await global.db.run('INSERT OR IGNORE INTO group_members (groupId,phone,role) VALUES ($1,$2,$3)',
                    [id, p, p === socket.phone ? 'admin' : 'member']);
            const info = { id, name: name.trim(), avatar: generateAvatar(name), createdBy: socket.phone, isGroup: true, members };
            members.forEach(p => { const s = socketsByPhone[p]; if (s) io.to(s).emit('group:created', info); });
        } catch (e) { socket.emit('group:error', 'Ошибка создания'); }
    });

    socket.on('group:leave', async ({ groupId }) => {
        await global.db.run('DELETE FROM group_members WHERE groupId=$1 AND phone=$2', [groupId, socket.phone]);
        await emitToChat(groupId, 'group:member:left', { groupId, phone: socket.phone });
        socket.emit('chat:deleted', { chatId: groupId });
    });

    // ══════════════════════════════════════════════════════════════════════
    // WebRTC ЗВОНКИ 1:1
    // ══════════════════════════════════════════════════════════════════════
    socket.on('videocall:initiate', ({ callId, targetPhone, callerName, offer }) => {
        const s = socketsByPhone[targetPhone];
        if (!s) return socket.emit('videocall:error', 'Пользователь не в сети');
        activeCall[callId] = { callId, initiatorSocket: socket.id, initiatorPhone: socket.phone, recipientSocket: s, recipientPhone: targetPhone, type: 'video', startTime: ts() };
        io.to(s).emit('webrtc:offer', { callId, sdp: offer, callerName, isAudio: false });
        socket.emit('videocall:initiated', { callId });
    });

    socket.on('voicecall:initiate', ({ callId, targetPhone, callerName, offer }) => {
        const s = socketsByPhone[targetPhone];
        if (!s) return socket.emit('voicecall:error', 'Пользователь не в сети');
        activeCall[callId] = { callId, initiatorSocket: socket.id, initiatorPhone: socket.phone, recipientSocket: s, recipientPhone: targetPhone, type: 'audio', startTime: ts() };
        io.to(s).emit('webrtc:offer', { callId, sdp: offer, callerName, isAudio: true });
        socket.emit('voicecall:initiated', { callId });
    });

    socket.on('webrtc:answer', ({ callId, sdp }) => {
        const c = activeCall[callId]; if (c) io.to(c.initiatorSocket).emit('webrtc:answer', { callId, sdp });
    });

    socket.on('webrtc:ice-candidate', ({ callId, candidate }) => {
        const c = activeCall[callId]; if (!c) return;
        io.to(socket.id === c.initiatorSocket ? c.recipientSocket : c.initiatorSocket)
            .emit('webrtc:ice-candidate', { callId, candidate });
    });

    socket.on('videocall:reject', ({ callId }) => {
        const c = activeCall[callId]; if (!c) return;
        io.to(c.initiatorSocket).emit('videocall:rejected', { callId }); delete activeCall[callId];
    });

    socket.on('voicecall:reject', ({ callId }) => {
        const c = activeCall[callId]; if (!c) return;
        io.to(c.initiatorSocket).emit('voicecall:rejected', { callId }); delete activeCall[callId];
    });

    socket.on('videocall:end', ({ callId }) => {
        const c = activeCall[callId]; if (!c) return;
        [c.initiatorSocket, c.recipientSocket].forEach(s => io.to(s).emit('videocall:ended', { callId }));
        global.db.run('INSERT OR IGNORE INTO calls (callId,initiatorPhone,recipientPhone,type,startTime,endTime,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [callId, c.initiatorPhone, c.recipientPhone, c.type, c.startTime, ts(), 'completed']).catch(() => {});
        delete activeCall[callId];
    });

    // ══════════════════════════════════════════════════════════════════════
    // ГРУППОВЫЕ ЗВОНКИ (Mesh WebRTC)
    // ══════════════════════════════════════════════════════════════════════
    socket.on('gcall:start', async ({ callId, groupId }) => {
        if (!socket.phone) return;
        groupCalls[callId] = { groupId, members: new Set([socket.phone]), mediaStatus: new Map() };
        try {
            const chat = await global.db.get('SELECT name FROM groups WHERE id=$1', [groupId]);
            const groupName = chat?.name || 'Группа';
            const dbMembers = await global.db.all('SELECT phone FROM group_members WHERE groupId=$1', [groupId]);
            dbMembers.forEach(m => {
                if (m.phone === socket.phone) return;
                const sid = socketsByPhone[m.phone];
                if (sid) io.to(sid).emit('gcall:active', { callId, groupId, groupName, memberCount: 1, members: [socket.phone] });
            });
        } catch (e) { console.error('gcall:start', e); }
    });

    socket.on('gcall:join', ({ callId, groupId }) => {
        if (!socket.phone) return;
        let gc = groupCalls[callId];
        if (!gc) {
            gc = { groupId, members: new Set([socket.phone]), mediaStatus: new Map() };
            groupCalls[callId] = gc;
            socket.emit('gcall:joined', { callId, members: [] });
            return;
        }
        const existing = Array.from(gc.members);
        socket.emit('gcall:joined', { callId, members: existing });
        gc.members.add(socket.phone);
        const allMembers = Array.from(gc.members);
        existing.forEach(phone => {
            const sid = socketsByPhone[phone];
            if (sid) io.to(sid).emit('gcall:user_joined', { callId, phone: socket.phone, members: allMembers });
        });
    });

    socket.on('gcall:offer',  ({ callId, targetPhone, sdp }) => { const s = socketsByPhone[targetPhone]; if (s) io.to(s).emit('gcall:offer',  { callId, fromPhone: socket.phone, sdp }); });
    socket.on('gcall:answer', ({ callId, targetPhone, sdp }) => { const s = socketsByPhone[targetPhone]; if (s) io.to(s).emit('gcall:answer', { callId, fromPhone: socket.phone, sdp }); });
    socket.on('gcall:ice',    ({ callId, targetPhone, candidate }) => { const s = socketsByPhone[targetPhone]; if (s) io.to(s).emit('gcall:ice', { callId, fromPhone: socket.phone, candidate }); });

    socket.on('gcall:leave', ({ callId }) => {
        const gc = groupCalls[callId];
        if (!gc || !socket.phone) return;
        gc.members.delete(socket.phone);
        if (gc.mediaStatus) gc.mediaStatus.delete(socket.phone);
        const remaining = Array.from(gc.members);
        remaining.forEach(phone => { const sid = socketsByPhone[phone]; if (sid) io.to(sid).emit('gcall:user_left', { callId, phone: socket.phone, members: remaining }); });
        if (gc.members.size === 0) delete groupCalls[callId];
    });

    socket.on('gcall:media_status', ({ callId, audio, video, screen }) => {
        const gc = groupCalls[callId]; if (!gc || !socket.phone) return;
        gc.mediaStatus.set(socket.phone, { audio, video, screen });
        Array.from(gc.members).forEach(phone => {
            const sid = socketsByPhone[phone];
            if (sid && phone !== socket.phone) io.to(sid).emit('gcall:media_status', { callId, phone: socket.phone, audio, video, screen });
        });
    });

    socket.on('gcall:get_active', () => {
        if (!socket.phone) return;
        for (const [callId, gc] of Object.entries(groupCalls)) {
            if (gc.members.has(socket.phone))
                socket.emit('gcall:rejoined', { callId, groupId: gc.groupId, members: Array.from(gc.members) });
        }
    });

    socket.on('gcall:screen_share', ({ callId, active, isPremium }) => {
        const gc = groupCalls[callId]; if (!gc || !socket.phone) return;
        Array.from(gc.members).forEach(phone => {
            const sid = socketsByPhone[phone];
            if (sid && phone !== socket.phone) io.to(sid).emit('gcall:screen_share', { callId, phone: socket.phone, active, isPremium });
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // КАНАЛЫ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('channel:my', async () => {
        if (!socket.phone) return;
        const channels = await global.db.all(
            `SELECT c.*,cs.role as myRole,(SELECT COUNT(*) FROM channel_subscribers WHERE channelId=c.id) as subscriberCount
             FROM channels c JOIN channel_subscribers cs ON cs.channelId=c.id WHERE cs.phone=?`, [socket.phone]
        );
        socket.emit('channel:my:list', channels);
    });

    socket.on('channel:search', async ({ query }) => {
        if (!query?.trim()) return;
        const q = '%' + query.trim() + '%';
        const channels = await global.db.all(
            `SELECT c.*,(SELECT COUNT(*) FROM channel_subscribers WHERE channelId=c.id) as subscriberCount
             FROM channels c WHERE c.isPublic=1 AND (c.name LIKE ? OR c.description LIKE ?) LIMIT 20`, [q, q]
        );
        socket.emit('channel:search:results', channels);
    });

    socket.on('channel:create', async ({ name, description, isPublic, avatarData }) => {
        if (!socket.phone || !name?.trim()) return socket.emit('channel:error', 'Введите название');
        try {
            const id = 'ch_' + uid();
            // Сохранить аватарку если передана
            let avatarUrl = null;
            if (avatarData?.startsWith('data:')) {
                const ext = avatarData.includes('png') $1 'png' : 'jpg';
                const fname = 'ch-avatar-' + id + '.' + ext;
                await fs.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(avatarData.split(',')[1], 'base64'));
                avatarUrl = '/uploads/' + fname;
            }
            // Генерировать inviteToken для приватных каналов
            const inviteToken = (isPublic !== false && isPublic !== 0) ? null : require('crypto').randomBytes(12).toString('hex');
            await global.db.run(
                'INSERT INTO channels (id,name,description,createdBy,isPublic,avatar,inviteToken) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                [id, name.trim(), description || '', socket.phone, isPublic !== false ? 1 : 0, avatarUrl, inviteToken]
            );
            await global.db.run('INSERT INTO channel_subscribers (channelId,phone,role) VALUES ($1,$2,$3)', [id, socket.phone, 'owner']);
            const ch = await global.db.get('SELECT * FROM channels WHERE id=$1', [id]);
            socket.emit('channel:created', { ...ch, myRole: 'owner', subscriberCount: 1 });
        } catch (e) { console.error('channel:create', e); socket.emit('channel:error', 'Ошибка создания'); }
    });

    socket.on('channel:subscribe', async ({ channelId }) => {
        if (!socket.phone) return;
        const existing = await global.db.get('SELECT 1 FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [channelId, socket.phone]);
        if (existing) {
            await global.db.run('DELETE FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [channelId, socket.phone]);
            await global.db.run('UPDATE channels SET subscriberCount=MAX(0,subscriberCount-1) WHERE id=$1', [channelId]);
            socket.emit('channel:subscribed', { channelId, subscribed: false });
        } else {
            await global.db.run('INSERT OR IGNORE INTO channel_subscribers (channelId,phone,role) VALUES ($1,$2,$3)', [channelId, socket.phone, 'subscriber']);
            await global.db.run('UPDATE channels SET subscriberCount=subscriberCount+1 WHERE id=$1', [channelId]);
            socket.emit('channel:subscribed', { channelId, subscribed: true, role: 'subscriber' });
        }
    });

    socket.on('channel:posts', async ({ channelId, offset }) => {
        const posts = await global.db.all(
            `SELECT p.*,(SELECT COUNT(*) FROM channel_comments WHERE postId=p.id) as commentCount
             FROM channel_posts p WHERE p.channelId=? ORDER BY p.timestamp DESC LIMIT 20 OFFSET ?`,
            [channelId, offset || 0]
        );
        socket.emit('channel:posts:list', { channelId, posts, offset: offset || 0 });
    });

    socket.on('channel:post:create', async ({ channelId, text, fileData, videoData }) => {
        if (!socket.phone) return;
        try {
            const sub = await global.db.get('SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [channelId, socket.phone]);
            if (!sub || !['admin', 'editor'].includes(sub.role)) return socket.emit('channel:error', 'Нет прав для публикации');
            let fileUrl = null, videoUrl = null;
            if (fileData?.startsWith('data:')) {
                const ext = fileData.includes('png') $1 'png' : fileData.includes('gif') $1 'gif' : 'jpg';
                const fname = 'post-' + uid() + '.' + ext;
                await fs.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(fileData.split(',')[1], 'base64'));
                fileUrl = '/uploads/' + fname;
            }
            if (videoData?.startsWith('data:')) {
                const fname = 'post-video-' + uid() + '.mp4';
                await fs.writeFile(path.join(VIDEO_DIR, fname), Buffer.from(videoData.split(',')[1], 'base64'));
                videoUrl = '/videos/' + fname;
            }
            const id = 'cp_' + uid();
            const post = { id, channelId, authorPhone: socket.phone, authorName: socket.nickname, text: text || null, fileUrl, videoUrl, views: 0, timestamp: ts(), commentCount: 0 };
            await global.db.run('INSERT INTO channel_posts (id,channelId,authorPhone,authorName,text,fileUrl,videoUrl,views,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)',
                [id, channelId, socket.phone, socket.nickname, text || null, fileUrl, videoUrl, ts()]);
            const subs = await global.db.all('SELECT phone, notifications FROM channel_subscribers WHERE channelId=$1', [channelId]);
            subs.forEach(s => {
                const sid = socketsByPhone[s.phone];
                if (sid) {
                    // Всегда шлём пост в ленту; уведомление (звук/бейдж) только если notifications=1
                    io.to(sid).emit('channel:post:new', { channelId, post, notify: s.notifications !== 0 });
                }
            });
        } catch (e) { socket.emit('channel:error', 'Ошибка публикации'); }
    });

    socket.on('channel:comments', async ({ postId }) => {
        const rows = await global.db.all('SELECT * FROM channel_comments WHERE postId=$1 ORDER BY timestamp ASC LIMIT 200', [postId]);
        socket.emit('channel:comments:list', { postId, comments: rows });
    });

    socket.on('channel:comment:add', async ({ postId, text }) => {
        if (!socket.phone || !text?.trim()) return;
        const post = await global.db.get('SELECT channelId FROM channel_posts WHERE id=$1', [postId]);
        if (!post) return;
        const sub = await global.db.get('SELECT 1 FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [post.channelId, socket.phone]);
        if (!sub) return socket.emit('channel:error', 'Нужно подписаться на канал');
        const id = 'cc_' + uid();
        const comment = { id, postId, channelId: post.channelId, senderPhone: socket.phone, senderName: socket.nickname, text: text.trim(), timestamp: ts() };
        await global.db.run('INSERT INTO channel_comments (id,postId,channelId,senderPhone,senderName,text,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, postId, post.channelId, socket.phone, socket.nickname, text.trim(), ts()]);
        const subs = await global.db.all('SELECT phone FROM channel_subscribers WHERE channelId=$1', [post.channelId]);
        subs.forEach(s => { const sid = socketsByPhone[s.phone]; if (sid) io.to(sid).emit('channel:comment:new', { postId, channelId: post.channelId, comment }); });
    });

    socket.on('channel:post:view', async ({ postId }) => {
        await global.db.run('UPDATE channel_posts SET views=views+1 WHERE id=$1', [postId]).catch(() => {});
    });

    // ── РЕАКЦИИ НА ПОСТЫ ─────────────────────────────────────────────────────
    socket.on('channel:post:react', async ({ postId, emoji }) => {
        if (!socket.phone || !postId || !emoji) return;
        try {
            const post = await global.db.get('SELECT channelId FROM channel_posts WHERE id=$1', [postId]);
            if (!post) return;
            // Проверяем подписку
            const sub = await global.db.get('SELECT 1 FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [post.channelId, socket.phone]);
            if (!sub) return socket.emit('channel:error', 'Нужно подписаться на канал');

            const existing = await global.db.get(
                'SELECT 1 FROM channel_post_reactions WHERE postId=$1 AND phone=$2 AND emoji=$3',
                [postId, socket.phone, emoji]
            );
            if (existing) {
                await global.db.run('DELETE FROM channel_post_reactions WHERE postId=$1 AND phone=$2 AND emoji=$3', [postId, socket.phone, emoji]);
            } else {
                await global.db.run('INSERT OR IGNORE INTO channel_post_reactions (postId,phone,emoji) VALUES ($1,$2,$3)', [postId, socket.phone, emoji]);
            }
            // Агрегируем реакции
            const reactions = await global.db.all(
                `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(phone) as phones
                 FROM channel_post_reactions WHERE postId=? GROUP BY emoji ORDER BY count DESC`,
                [postId]
            );
            const reactionList = reactions.map(r => ({
                emoji: r.emoji, count: r.count,
                mine: (r.phones || '').split(',').includes(socket.phone)
            }));
            // Рассылаем всем подписчикам
            const subs = await global.db.all('SELECT phone FROM channel_subscribers WHERE channelId=$1', [post.channelId]);
            subs.forEach(s => {
                const sid = socketsByPhone[s.phone];
                if (sid) io.to(sid).emit('channel:post:reactions:update', { postId, reactions: reactionList, myPhone: s.phone });
            });
        } catch (e) { console.error('channel:post:react', e); }
    });

    socket.on('channel:post:reactions', async ({ postId }) => {
        if (!postId) return;
        try {
            const reactions = await global.db.all(
                `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(phone) as phones
                 FROM channel_post_reactions WHERE postId=? GROUP BY emoji ORDER BY count DESC`,
                [postId]
            );
            socket.emit('channel:post:reactions:list', {
                postId,
                reactions: reactions.map(r => ({
                    emoji: r.emoji, count: r.count,
                    mine: (r.phones || '').split(',').includes(socket.phone)
                }))
            });
        } catch (e) {}
    });

    // ── УПРАВЛЕНИЕ КАНАЛОМ (АДМИНЫ) ───────────────────────────────────────────
    // Список участников канала
    socket.on('channel:members', async ({ channelId }) => {
        if (!socket.phone) return;
        try {
            const myRole = await global.db.get(
                'SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
                [channelId, socket.phone]
            );
            if (!myRole || !['owner','admin'].includes(myRole.role))
                return socket.emit('channel:error', 'Нет прав');
            const members = await global.db.all(
                `SELECT cs.phone, cs.role, cs.joinedAt, u.nickname, u.avatar, u.status
                 FROM channel_subscribers cs JOIN users u ON u.phone=cs.phone
                 WHERE cs.channelId=? ORDER BY
                   CASE cs.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cs.joinedAt ASC`,
                [channelId]
            );
            socket.emit('channel:members:list', { channelId, members, myRole: myRole.role });
        } catch (e) { console.error('channel:members', e); }
    });

    // Назначить/снять администратора
    socket.on('channel:admin:set', async ({ channelId, targetPhone, role }) => {
        if (!socket.phone) return;
        try {
            // Только владелец может управлять ролями
            const myRow = await global.db.get(
                'SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
                [channelId, socket.phone]
            );
            if (!myRow || myRow.role !== 'owner')
                return socket.emit('channel:error', 'Только владелец может назначать администраторов');
            // Нельзя изменить роль владельца
            const targetRow = await global.db.get(
                'SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
                [channelId, targetPhone]
            );
            if (!targetRow) return socket.emit('channel:error', 'Пользователь не является подписчиком');
            if (targetRow.role === 'owner') return socket.emit('channel:error', 'Нельзя изменить роль владельца');

            const newRole = role === 'admin' $1 'admin' : 'subscriber';
            await global.db.run(
                'UPDATE channel_subscribers SET role=$1 WHERE channelId=$2 AND phone=$3',
                [newRole, channelId, targetPhone]
            );
            // Уведомляем назначенного пользователя
            const chInfo = await global.db.get('SELECT name FROM channels WHERE id=$1', [channelId]);
            const sid = socketsByPhone[targetPhone];
            if (sid) io.to(sid).emit('channel:role:changed', {
                channelId,
                channelName: chInfo?.name || '',
                newRole,
                byPhone: socket.phone,
                byName: socket.nickname
            });
            socket.emit('channel:admin:updated', { channelId, targetPhone, newRole });
        } catch (e) { console.error('channel:admin:set', e); socket.emit('channel:error', 'Ошибка изменения роли'); }
    });

    // Исключить участника из канала
    socket.on('channel:member:kick', async ({ channelId, targetPhone }) => {
        if (!socket.phone) return;
        try {
            const myRow = await global.db.get(
                'SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
                [channelId, socket.phone]
            );
            if (!myRow || !['owner','admin'].includes(myRow.role))
                return socket.emit('channel:error', 'Нет прав');
            const targetRow = await global.db.get(
                'SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
                [channelId, targetPhone]
            );
            if (targetRow?.role === 'owner') return socket.emit('channel:error', 'Нельзя исключить владельца');
            await global.db.run('DELETE FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [channelId, targetPhone]);
            await global.db.run('UPDATE channels SET subscriberCount=MAX(0,subscriberCount-1) WHERE id=$1', [channelId]);
            // Уведомляем исключённого
            const sid = socketsByPhone[targetPhone];
            if (sid) io.to(sid).emit('channel:kicked', { channelId });
            socket.emit('channel:member:kicked', { channelId, targetPhone });
        } catch (e) { console.error('channel:member:kick', e); }
    });

    // Получить/сгенерировать инвайт-ссылку (только для приватных каналов, только для owner/admin)
    socket.on('channel:invite:get', async ({ channelId }) => {
        if (!socket.phone) return;
        try {
            const myRow = await global.db.get(
                'SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
                [channelId, socket.phone]
            );
            if (!myRow || !['owner','admin'].includes(myRow.role))
                return socket.emit('channel:error', 'Нет прав');
            let ch = await global.db.get('SELECT id,name,isPublic,inviteToken FROM channels WHERE id=$1', [channelId]);
            if (!ch) return socket.emit('channel:error', 'Канал не найден');
            if (!ch.inviteToken) {
                const token = require('crypto').randomBytes(12).toString('hex');
                await global.db.run('UPDATE channels SET inviteToken=$1 WHERE id=$2', [token, channelId]);
                ch.inviteToken = token;
            }
            socket.emit('channel:invite:link', { channelId, token: ch.inviteToken });
        } catch (e) { console.error('channel:invite:get', e); }
    });

    // Вступить по инвайт-ссылке
    socket.on('channel:invite:join', async ({ token }) => {
        if (!socket.phone || !token) return;
        try {
            const ch = await global.db.get('SELECT * FROM channels WHERE inviteToken=$1', [token]);
            if (!ch) return socket.emit('channel:error', 'Ссылка недействительна');
            const existing = await global.db.get('SELECT 1 FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [ch.id, socket.phone]);
            if (!existing) {
                await global.db.run('INSERT OR IGNORE INTO channel_subscribers (channelId,phone,role) VALUES ($1,$2,$3)', [ch.id, socket.phone, 'subscriber']);
                await global.db.run('UPDATE channels SET subscriberCount=subscriberCount+1 WHERE id=$1', [ch.id]);
            }
            const sub = await global.db.get('SELECT role FROM channel_subscribers WHERE channelId=$1 AND phone=$2', [ch.id, socket.phone]);
            const subCount = await global.db.get('SELECT COUNT(*) as c FROM channel_subscribers WHERE channelId=$1', [ch.id]);
            socket.emit('channel:invite:joined', { ...ch, myRole: sub.role, subscriberCount: subCount.c });
        } catch (e) { console.error('channel:invite:join', e); }
    });

    // ── ЛЕНТА РЕКОМЕНДАЦИЙ ────────────────────────────────────────────────────
    socket.on('feed:get', async ({ offset } = {}) => {
        if (!socket.phone) return;
        try {
            const off = parseInt(offset) || 0;
            // Посты из каналов на которые подписан пользователь (уведомления включены или выключены — всё равно в ленте)
            const myPosts = await global.db.all(
                `SELECT p.*, c.name as channelName, c.id as channelId, c.avatar as channelAvatar,
                    cs.notifications as notifEnabled,
                    (SELECT COUNT(*) FROM channel_comments WHERE postId=p.id) as commentCount
                 FROM channel_posts p
                 JOIN channels c ON c.id = p.channelId
                 JOIN channel_subscribers cs ON cs.channelId = p.channelId AND cs.phone = ?
                 ORDER BY p.timestamp DESC LIMIT 20 OFFSET ?`,
                [socket.phone, off]
            );
            // Рекомендации: публичные каналы с наибольшим числом подписчиков, на которые НЕ подписан
            const recommended = await global.db.all(
                `SELECT c.*, (SELECT COUNT(*) FROM channel_subscribers WHERE channelId=c.id) as subCount,
                    (SELECT p2.text FROM channel_posts p2 WHERE p2.channelId=c.id ORDER BY p2.timestamp DESC LIMIT 1) as latestPost,
                    (SELECT p2.timestamp FROM channel_posts p2 WHERE p2.channelId=c.id ORDER BY p2.timestamp DESC LIMIT 1) as latestPostAt
                 FROM channels c
                 WHERE c.isPublic=1
                   AND c.id NOT IN (SELECT channelId FROM channel_subscribers WHERE phone=?)
                   AND (SELECT COUNT(*) FROM channel_posts WHERE channelId=c.id) > 0
                 ORDER BY subCount DESC LIMIT 5`,
                [socket.phone]
            );
            socket.emit('feed:data', { posts: myPosts, recommended, offset: off });
        } catch (e) { console.error('feed:get error:', e.message); socket.emit('feed:data', { posts: [], recommended: [], offset: 0 }); }
    });

    // ── НАСТРОЙКИ УВЕДОМЛЕНИЙ КАНАЛА ─────────────────────────────────────────
    socket.on('channel:notifications:set', async ({ channelId, enabled }) => {
        if (!socket.phone) return;
        try {
            await global.db.run(
                'UPDATE channel_subscribers SET notifications=$1 WHERE channelId=$2 AND phone=$3',
                [enabled ? 1 : 0, channelId, socket.phone]
            );
            socket.emit('channel:notifications:updated', { channelId, enabled: !!enabled });
        } catch (e) { console.error('channel:notifications:set error:', e.message); }
    });

    // Включить/выключить уведомления при получении нового поста
    // (Переопределяем channel:post:create чтобы учитывать настройки уведомлений)
    // Уже определён выше — только добавляем отдельное событие channel:notifications:get
    socket.on('channel:notifications:get', async ({ channelId }) => {
        if (!socket.phone) return;
        const row = await global.db.get(
            'SELECT notifications FROM channel_subscribers WHERE channelId=$1 AND phone=$2',
            [channelId, socket.phone]
        );
        socket.emit('channel:notifications:state', { channelId, enabled: row ? !!row.notifications : true });
    });

    // ══════════════════════════════════════════════════════════════════════
    // ИСТОРИИ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('stories:load', async () => {
        if (!socket.phone) return;
        try {
            const nowTs = new Date().toISOString();
            const stories = await global.db.all(
                `SELECT s.*,
                    (SELECT COUNT(*) FROM story_views WHERE storyId=s.id) as viewCount,
                    (SELECT 1 FROM story_views WHERE storyId=s.id AND viewerPhone=?) as viewed
                 FROM stories s WHERE s.expiresAt>? ORDER BY s.createdAt DESC LIMIT 100`,
                [socket.phone, nowTs]
            );
            socket.emit('stories:list', stories);
        } catch (e) { console.error('stories:load', e); }
    });

    socket.on('story:create', async ({ videoData, imageData, text, duration }) => {
        if (!socket.phone) return;
        try {
            let videoUrl = null, imageUrl = null;
            if (videoData?.startsWith('data:')) {
                const fname = 'story-' + uid() + '.mp4';
                await fs.writeFile(path.join(VIDEO_DIR, fname), Buffer.from(videoData.split(',')[1], 'base64'));
                videoUrl = '/videos/' + fname;
            }
            if (imageData?.startsWith('data:')) {
                const ext = imageData.includes('png') $1 'png' : 'jpg';
                const fname = 'story-' + uid() + '.' + ext;
                await fs.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(imageData.split(',')[1], 'base64'));
                imageUrl = '/uploads/' + fname;
            }
            if (!videoUrl && !imageUrl && !text) return socket.emit('story:error', 'Нет контента');
            const id = 'st_' + uid();
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            const story = { id, authorPhone: socket.phone, authorName: socket.nickname, videoUrl, imageUrl, text: text || null, duration: duration || 15, expiresAt, createdAt: ts(), viewCount: 0, viewed: 0 };
            await global.db.run('INSERT INTO stories (id,authorPhone,authorName,videoUrl,imageUrl,text,duration,expiresAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [id, socket.phone, socket.nickname, videoUrl, imageUrl, text || null, duration || 15, expiresAt]);
            io.emit('story:new', story);
        } catch (e) { socket.emit('story:error', 'Ошибка загрузки'); }
    });

    socket.on('story:view', async ({ storyId }) => {
        if (!socket.phone) return;
        await global.db.run('INSERT OR IGNORE INTO story_views (storyId,viewerPhone) VALUES ($1,$2)', [storyId, socket.phone]);
        const v = await global.db.get('SELECT COUNT(*) as c FROM story_views WHERE storyId=$1', [storyId]);
        const story = await global.db.get('SELECT authorPhone FROM stories WHERE id=$1', [storyId]);
        if (story) {
            const sid = socketsByPhone[story.authorPhone];
            if (sid) io.to(sid).emit('story:viewed', { storyId, viewCount: v.c, viewerPhone: socket.phone });
        }
    });

    // ══════════════════════════════════════════════════════════════════════
    // ГЛОБАЛЬНЫЙ ПОИСК
    // ══════════════════════════════════════════════════════════════════════
    socket.on('global:search', async ({ query }) => {
        if (!socket.phone || !query?.trim()) return;
        const q = '%' + query.trim() + '%';
        const users = await global.db.all(
            'SELECT phone,nickname,avatar,status FROM users WHERE (phone LIKE $1 OR nickname LIKE $2) AND phone!=$3 LIMIT 10', [q, q, socket.phone]
        );
        const channels = await global.db.all(
            `SELECT c.*,(SELECT COUNT(*) FROM channel_subscribers WHERE channelId=c.id) as subscriberCount
             FROM channels c WHERE c.isPublic=1 AND (c.name LIKE ? OR c.description LIKE ?) LIMIT 10`, [q, q]
        );
        socket.emit('global:search:results', { users, channels });
    });

    socket.on('message:search', async ({ query, chatId }) => {
        if (!socket.phone || !query?.trim()) return;
        const q = '%' + query.trim() + '%';
        let rows;
        if (chatId) {
            // Поиск в конкретном чате
            rows = await global.db.all(
                `SELECT id,chatId,senderName,text,timestamp FROM messages
                 WHERE chatId=? AND text LIKE ? ORDER BY timestamp DESC LIMIT 30`,
                [chatId, q]
            );
        } else {
            // Глобальный поиск по всем чатам пользователя
            rows = await global.db.all(
                `SELECT id,chatId,senderName,text,timestamp FROM messages
                 WHERE (chatId LIKE ? OR chatId IN (SELECT id FROM groups g JOIN group_members gm ON gm.groupId=g.id WHERE gm.phone=?))
                 AND text LIKE ? ORDER BY timestamp DESC LIMIT 50`,
                [`%${socket.phone}%`, socket.phone, q]
            );
        }
        socket.emit('message:search:results', { query: query.trim(), results: rows });
    });

    // ══════════════════════════════════════════════════════════════════════
    // 🤖 АВТООТВЕТ
    // ══════════════════════════════════════════════════════════════════════
    socket.on('autoreply:set', async ({ enabled, text }) => {
        if (!socket.phone) return;
        await global.db.run(
            'UPDATE users SET autoReply=$1,autoReplyText=$2 WHERE phone=$3',
            [enabled ? 1 : 0,
             (text || '').trim().slice(0, 200) || '🤖 Сейчас не в сети. Отвечу позже!',
             socket.phone]
        ).catch(()=>{});
        socket.emit('autoreply:saved', { enabled, text });
    });

    socket.on('autoreply:get', async () => {
        if (!socket.phone) return;
        const u = await global.db.get(
            'SELECT autoReply,autoReplyText FROM users WHERE phone=$1', [socket.phone]
        ).catch(()=>null);
        socket.emit('autoreply:data', { enabled: !!u$1.autoReply, text: u$2.autoReplyText || '' });
    });

    // ══════════════════════════════════════════════════════════════════════
    // 👁 КТО ПРОЧИТАЛ (группы)
    // ══════════════════════════════════════════════════════════════════════
    socket.on('message:read:group', async ({ chatId, messageId }) => {
        if (!socket.phone || !chatId || !messageId) return;
        await global.db.run(
            'INSERT OR IGNORE INTO message_reads (messageId,chatId,readerPhone,readAt) VALUES ($1,$2,$3,$4)',
            [messageId, chatId, socket.phone, ts()]
        ).catch(()=>{});
        const readers = await global.db.all(
            'SELECT readerPhone FROM message_reads WHERE messageId=$1', [messageId]
        ).catch(()=>[]);
        await emitToChat(chatId, 'message:read:group:update', {
            messageId, chatId, readers: readers.map(r => r.readerPhone)
        });
    });

    socket.on('message:read:who', async ({ messageId }) => {
        if (!socket.phone) return;
        const readers = await global.db.all(
            `SELECT mr.readerPhone, u.nickname FROM message_reads mr
             JOIN users u ON u.phone=mr.readerPhone WHERE mr.messageId=?`, [messageId]
        ).catch(()=>[]);
        socket.emit('message:read:who:result', { messageId, readers });
    });

    // ══════════════════════════════════════════════════════════════════════
    // 💰 КОШЕЛЁК
    // ══════════════════════════════════════════════════════════════════════
    socket.on('кошелёк:баланс', async () => {
        if (!socket.phone) return;
        const user = await global.db.get('SELECT balance FROM users WHERE phone=$1', [socket.phone]);
        const txns = await global.db.all(
            'SELECT * FROM transactions WHERE fromPhone=$1 OR toPhone=$2 ORDER BY timestamp DESC LIMIT 50',
            [socket.phone, socket.phone]
        );
        socket.emit('кошелёк:данные', { balance: user?.balance || 0, transactions: txns, hasPin: !!(user?.pin) });
    });

    socket.on('кошелёк:установить-пин', async ({ pin }) => {
        if (!socket.phone) return;
        if (!pin || !/^\d{4}$/.test(String(pin))) return socket.emit('кошелёк:ошибка', 'ПИН — ровно 4 цифры');
        const hashed = await bcrypt.hash(String(pin), 10);
        await global.db.run('UPDATE users SET pin=$1 WHERE phone=$2', [hashed, socket.phone]);
        socket.emit('кошелёк:пин-установлен');
    });

    // Проверка PIN при входе в кошелёк (lock screen)
    socket.on('кошелёк:проверить-пин', async ({ pin }) => {
        if (!socket.phone) return;
        if (!pin || !/^\d{4}$/.test(String(pin))) {
            return socket.emit('кошелёк:пин-неверный');
        }
        const user = await global.db.get('SELECT pin FROM users WHERE phone=$1', [socket.phone]);
        if (!user?.pin) {
            // PIN не установлен — пропускаем
            return socket.emit('кошелёк:пин-верный');
        }
        const ok = await bcrypt.compare(String(pin), user.pin);
        socket.emit(ok ? 'кошелёк:пин-верный' : 'кошелёк:пин-неверный');
    });

    socket.on('wallet:transfer', async ({ toPhone, amount, comment, pin }) => {
        if (!socket.phone) return;
        try {
            const amt = parseFloat(amount);
            if (!amt || amt <= 0 || amt > 1_000_000) return socket.emit('кошелёк:ошибка', 'Неверная сумма');
            if (!toPhone || toPhone === socket.phone) return socket.emit('кошелёк:ошибка', 'Неверный получатель');

            const sender = await global.db.get('SELECT balance,pin,nickname FROM users WHERE phone=$1', [socket.phone]);
            if (!sender) return socket.emit('кошелёк:ошибка', 'Пользователь не найден');
            if (!sender.pin) return socket.emit('кошелёк:ошибка', 'Сначала установите ПИН-код');
            if (!pin) return socket.emit('кошелёк:пин-требуется', { toPhone, amount: amt, comment });
            if (!await bcrypt.compare(String(pin), sender.pin)) return socket.emit('кошелёк:ошибка', 'Неверный ПИН-код');
            if ((sender.balance || 0) < amt) return socket.emit('кошелёк:ошибка', 'Недостаточно средств');

            const recipient = await global.db.get('SELECT balance,nickname FROM users WHERE phone=$1', [toPhone]);
            if (!recipient) return socket.emit('кошелёк:ошибка', 'Получатель не найден');

            const txId = 'tx_' + uid(), txTs = ts();
            await global.db.transaction(async tx => {
                await tx.run('UPDATE users SET balance=balance-$1 WHERE phone=$2', [amt, socket.phone]);
                await tx.run('UPDATE users SET balance=balance+$1 WHERE phone=$2', [amt, toPhone]);
                await tx.run(
                    'INSERT INTO transactions (id,fromPhone,toPhone,amount,comment,type,status,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                    [txId, socket.phone, toPhone, amt, comment || '', 'transfer', 'completed', txTs]
                );
            });

            const nbS = (await global.db.get('SELECT balance FROM users WHERE phone=$1', [socket.phone]))?.balance || 0;
            const nbR = (await global.db.get('SELECT balance FROM users WHERE phone=$1', [toPhone]))?.balance || 0;

            socket.emit('кошелёк:перевод-выполнен', { txId, amount: amt, toPhone, toName: recipient.nickname, newBalance: nbS, timestamp: txTs });
            const rs = socketsByPhone[toPhone];
            if (rs) io.to(rs).emit('кошелёк:получен-перевод', { txId, amount: amt, fromPhone: socket.phone, fromName: sender.nickname, newBalance: nbR, comment: comment || '', timestamp: txTs });

            // Системное сообщение
            const chatId = [socket.phone, toPhone].sort().join('_');
            const sysText = `💸 ${sender.nickname} → ${recipient.nickname}: ${amt.toLocaleString('ru')} ₽${comment $1 ' · ' + comment : ''}`;
            const sysId = uid();
            await global.db.run('INSERT INTO messages (id,chatId,senderPhone,senderName,text,timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
                [sysId, chatId, 'system', 'БАЗА Кошелёк', sysText, txTs]);
            await emitToChat(chatId, 'message:receive', { chatId, message: { id: sysId, chatId, senderPhone: 'system', senderName: 'БАЗА Кошелёк', text: sysText, timestamp: txTs, reactions: [], isRead: 0, isEdited: 0, replyTo: null } });

            await auditLog({
                actorPhone: socket.phone,
                actorType: 'user',
                action: 'wallet.transfer',
                targetPhone: toPhone,
                severity: 'info',
                meta: { amount: amt, comment: comment || '' },
            });
        } catch (e) { console.error('wallet:transfer:', e.message); socket.emit('кошелёк:ошибка', 'Ошибка: ' + e.message); }
    });

    // Проверка PIN для lock screen кошелька
    socket.on('кошелёк:проверить-пин', async ({ pin }, callback) => {
        if (!socket.phone) return;
        try {
            const user = await global.db.get('SELECT pin FROM users WHERE phone=$1', [socket.phone]);
            if (!user?.pin) {
                if (callback) callback({ ok: false, error: 'PIN не установлен' });
                return;
            }
            const ok = await bcrypt.compare(String(pin), user.pin);
            if (callback) callback({ ok });
            if (!ok) socket.emit('кошелёк:ошибка', 'Неверный PIN-код');
        } catch(e) {
            if (callback) callback({ ok: false });
        }
    });

    socket.on('кошелёк:пополнить', async ({ amount }) => {
        if (!socket.phone) return;
        const amt = parseFloat(amount);
        if (!amt || amt <= 0 || amt > 50000) return socket.emit('кошелёк:ошибка', 'Сумма: 1–50 000 ₽');
        await global.db.run('UPDATE users SET balance=balance+$1 WHERE phone=$2', [amt, socket.phone]);
        await global.db.run('INSERT INTO transactions (id,fromPhone,toPhone,amount,comment,type,status,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            ['tx_' + uid(), 'system', socket.phone, amt, 'Пополнение (демо)', 'topup', 'completed', ts()]);
        const u = await global.db.get('SELECT balance FROM users WHERE phone=$1', [socket.phone]);
        socket.emit('кошелёк:пополнено', { amount: amt, newBalance: u.balance });

        await auditLog({
            actorPhone: socket.phone,
            actorType: 'user',
            action: 'wallet.topup_demo',
            targetPhone: socket.phone,
            severity: 'info',
            meta: { amount: amt },
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // ⭐ PREMIUM — покупка через баланс (демо)
    // ══════════════════════════════════════════════════════════════════════
    const PREMIUM_PLANS = [
        { id: 'premium_month',  title: 'Premium · 30 дней',  days: 30,  price: 199 },
        { id: 'premium_year',   title: 'Premium · 365 дней', days: 365, price: 1490 },
    ];

    socket.on('premium:plans', async () => {
        socket.emit('premium:plans:result', { plans: PREMIUM_PLANS });
    });

    socket.on('premium:buy', async ({ planId, pin }) => {
        if (!socket.phone) return;
        try {
            const plan = PREMIUM_PLANS.find(p => p.id === planId) || PREMIUM_PLANS[0];
            const sender = await global.db.get('SELECT balance,pin,nickname,isPremium,premiumUntil FROM users WHERE phone=$1', [socket.phone]);
            if (!sender) return socket.emit('premium:error', 'Пользователь не найден');
            if (!sender.pin) return socket.emit('premium:error', 'Сначала установите ПИН-код кошелька');
            if (!pin) return socket.emit('premium:pin_required', { planId: plan.id, price: plan.price });
            if (!await bcrypt.compare(String(pin), sender.pin)) return socket.emit('premium:error', 'Неверный ПИН-код');
            if ((sender.balance || 0) < plan.price) return socket.emit('premium:error', 'Недостаточно средств');

            const now = Date.now();
            const curExp = sender.premiumUntil ? Date.parse(sender.premiumUntil) : NaN;
            const base = (!Number.isNaN(curExp) && curExp > now) ? curExp : now;
            const newExp = new Date(base + plan.days * 24 * 60 * 60 * 1000).toISOString();

            const orderTs = ts();
            await global.db.transaction(async tx => {
                await tx.run('UPDATE users SET balance=balance-$1 WHERE phone=$2', [plan.price, socket.phone]);
                await tx.run('UPDATE users SET isPremium=1, premiumUntil=$1 WHERE phone=$2', [newExp, socket.phone]);
                await tx.run(
                    'INSERT INTO transactions (id,fromPhone,toPhone,amount,comment,type,status,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                    ['tx_' + uid(), socket.phone, 'system', plan.price, `Premium: ${plan.title}`, 'subscription', 'completed', orderTs]
                );
            });

            socket.isPremium = 1;
            socket.emit('premium:buy:ok', { isPremium: 1, premiumUntil: newExp, plan });
            socket.emit('premium:status', { isPremium: 1, plan: { id: plan.id, title: plan.title, premiumUntil: newExp } });

            await auditLog({
                actorPhone: socket.phone,
                actorType: 'user',
                action: 'premium.buy',
                targetPhone: socket.phone,
                severity: 'info',
                meta: { planId: plan.id, price: plan.price, premiumUntil: newExp },
            });
        } catch (e) {
            console.error('premium:buy:', e.message);
            socket.emit('premium:error', 'Ошибка покупки: ' + e.message);
        }
    });

    // ══════════════════════════════════════════════════════════════════════
    // 🛍️ МАРКЕТПЛЕЙС
    // ══════════════════════════════════════════════════════════════════════
    const SYSTEM_SERVICES = [
        { id: 'autoservice', name: 'Автосервис',     icon: '🚗', desc: 'Запись на ТО и ремонт',   category: 'авто',        price: 500,  isSystem: true },
        { id: 'delivery',    name: 'Доставка',        icon: '📦', desc: 'Курьер в течение часа',   category: 'услуги',      price: 299,  isSystem: true },
        { id: 'doctor',      name: 'Запись к врачу',  icon: '🏥', desc: 'Онлайн-консультация',     category: 'здоровье',    price: 990,  isSystem: true },
        { id: 'tutor',       name: 'Репетитор',       icon: '📚', desc: 'Обучение онлайн',          category: 'образование', price: 1200, isSystem: true },
        { id: 'taxi',        name: 'Такси',           icon: '🚕', desc: 'Поездки по городу',        category: 'транспорт',   price: 200,  isSystem: true },
        { id: 'beauty',      name: 'Красота',         icon: '💄', desc: 'Запись к мастеру',         category: 'красота',     price: 800,  isSystem: true },
    ];

    socket.on('маркет:услуги', async () => {
        if (!socket.phone) return;
        const user = await global.db.get('SELECT balance FROM users WHERE phone=$1', [socket.phone]);
        const userSvcs = await global.db.all('SELECT * FROM user_services WHERE isActive=1 ORDER BY createdAt DESC LIMIT 50');
        socket.emit('маркет:список', { balance: user?.balance || 0, services: SYSTEM_SERVICES, userServices: userSvcs });
    });

    socket.on('маркет:заказать', async ({ serviceId, serviceName, amount, details, pin, ownerPhone }) => {
        if (!socket.phone) return;
        try {
            const amt = parseFloat(amount);
            if (!amt || amt <= 0) return socket.emit('маркет:ошибка', 'Неверная сумма');
            const sender = await global.db.get('SELECT balance,pin,nickname FROM users WHERE phone=$1', [socket.phone]);
            if (!sender?.pin) return socket.emit('маркет:ошибка', 'Сначала установите ПИН-код');
            if (!pin) return socket.emit('маркет:пин-требуется', { serviceId, serviceName, amount: amt, details, ownerPhone });
            if (!await bcrypt.compare(String(pin), sender.pin)) return socket.emit('маркет:ошибка', 'Неверный ПИН-код');
            if ((sender.balance || 0) < amt) return socket.emit('маркет:ошибка', 'Недостаточно средств');

            const orderId = 'ord_' + uid(), orderTs = ts();
            await global.db.transaction(async tx => {
                await tx.run('UPDATE users SET balance=balance-$1 WHERE phone=$2', [amt, socket.phone]);
                if (ownerPhone && ownerPhone !== socket.phone) {
                    await tx.run('UPDATE users SET balance=balance+$1 WHERE phone=$2', [amt, ownerPhone]);
                }
                await tx.run(
                    'INSERT INTO marketplace_orders (id,userPhone,serviceId,serviceName,amount,status,details,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                    [orderId, socket.phone, serviceId, serviceName, amt, 'confirmed', JSON.stringify(details || {}), orderTs]
                );
                await tx.run('INSERT INTO transactions (id,fromPhone,toPhone,amount,comment,type,status,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                    ['tx_' + uid(), socket.phone, ownerPhone || 'marketplace', amt, `Услуга: ${serviceName}`, 'payment', 'completed', orderTs]);
            });
            if (ownerPhone && ownerPhone !== socket.phone) {
                const rs = socketsByPhone[ownerPhone];
                if (rs) io.to(rs).emit('кошелёк:получен-перевод', { amount: amt, fromPhone: socket.phone, fromName: sender.nickname, comment: `Заказ: ${serviceName}`, timestamp: orderTs });
            }
            const nb = (await global.db.get('SELECT balance FROM users WHERE phone=$1', [socket.phone]))?.balance || 0;
            socket.emit('маркет:заказ-принят', { orderId, serviceId, serviceName, amount: amt, newBalance: nb, timestamp: orderTs });
        } catch (e) { console.error('маркет:заказать:', e.message); socket.emit('маркет:ошибка', 'Ошибка заказа: ' + e.message); }
    });

    socket.on('маркет:заказы', async () => {
        if (!socket.phone) return;
        const orders = await global.db.all('SELECT * FROM marketplace_orders WHERE userPhone=$1 ORDER BY timestamp DESC LIMIT 30', [socket.phone]);
        socket.emit('маркет:список-заказов', orders);
    });

    socket.on('маркет:добавить-услугу', async ({ name, description, icon, category, price }) => {
        if (!socket.phone) return;
        if (!name?.trim()) return socket.emit('маркет:ошибка', 'Введите название');
        const p = parseFloat(price);
        if (!p || p <= 0) return socket.emit('маркет:ошибка', 'Укажите цену');
        const id = 'svc_' + uid();
        await global.db.run(
            'INSERT INTO user_services (id,ownerPhone,ownerName,name,description,icon,category,price,isActive,createdAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)',
            [id, socket.phone, socket.nickname, name.trim(), description || '', icon || '🔧', category || 'услуги', p, ts()]
        );
        const svc = await global.db.get('SELECT * FROM user_services WHERE id=$1', [id]);
        socket.emit('маркет:услуга-добавлена', svc);
    });

    socket.on('маркет:мои-услуги', async () => {
        if (!socket.phone) return;
        const svcs = await global.db.all('SELECT * FROM user_services WHERE ownerPhone=$1 ORDER BY createdAt DESC', [socket.phone]);
        socket.emit('маркет:список-моих-услуг', svcs);
    });

    socket.on('маркет:удалить-услугу', async ({ id }) => {
        if (!socket.phone) return;
        const svc = await global.db.get('SELECT ownerPhone FROM user_services WHERE id=$1', [id]);
        if (!svc || svc.ownerPhone !== socket.phone) return socket.emit('маркет:ошибка', 'Нет прав');
        await global.db.run('UPDATE user_services SET isActive=0 WHERE id=$1', [id]);
        socket.emit('маркет:услуга-удалена', { id });
    });

    socket.on('маркет:переключить-услугу', async ({ id, isActive }) => {
        if (!socket.phone) return;
        const svc = await global.db.get('SELECT ownerPhone FROM user_services WHERE id=$1', [id]);
        if (!svc || svc.ownerPhone !== socket.phone) return;
        await global.db.run('UPDATE user_services SET isActive=$1 WHERE id=$2', [isActive ? 1 : 0, id]);
        socket.emit('маркет:услуга-обновлена', { id, isActive });
    });

    // ══════════════════════════════════════════════════════════════════════
    // DISCONNECT
    // ══════════════════════════════════════════════════════════════════════
    // 🤖 Боты
    attachBotHandlers(socket);

    socket.on('disconnect', async () => {
        if (!socket.phone) return;
        delete socketsByPhone[socket.phone];
        await global.db.run('UPDATE users SET status=$1,lastSeen=$2 WHERE phone=$3', ['offline', ts(), socket.phone]).catch(() => {});
        io.emit('user:status', { phone: socket.phone, status: 'offline', lastSeen: ts() });

        for (const [id, c] of Object.entries(activeCall)) {
            if (c.initiatorPhone === socket.phone || c.recipientPhone === socket.phone) {
                [c.initiatorSocket, c.recipientSocket].forEach(s => io.to(s).emit('videocall:ended', { callId: id }));
                delete activeCall[id];
            }
        }

        for (const [callId, gc] of Object.entries(groupCalls)) {
            if (gc.members.has(socket.phone)) {
                gc.members.delete(socket.phone);
                if (gc.mediaStatus) gc.mediaStatus.delete(socket.phone);
                const remaining = Array.from(gc.members);
                remaining.forEach(phone => {
                    const sid = socketsByPhone[phone];
                    if (sid) io.to(sid).emit('gcall:user_left', { callId, phone: socket.phone, members: remaining });
                });
                if (gc.members.size === 0) delete groupCalls[callId];
            }
        }
    });
});


// ════════════════════════════════════════════════════════════════════════════════
// 🤖 СИСТЕМА БОТОВ И МИНИ-АППОВ
// ════════════════════════════════════════════════════════════════════════════════
//
// Бот — специальный аккаунт с токеном, отвечает на сообщения через Webhook или
// через Long Polling (сервер сам опрашивает handler URL).
//
// Mini App — HTML страница, открывается поверх чата в iframe.
// Получает контекст пользователя через postMessage, может отправлять сообщения.
//
// ── Таблицы БД ────────────────────────────────────────────────────────────────
// bots(id, name, username, ownerId, token, avatarEmoji, description,
//      webhookUrl, isActive, miniAppUrl, miniAppTitle, createdAt)
// bot_commands(id, botId, command, description)
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Убедимся что таблицы ботов существуют (теперь создаются в основном init)
async function ensureBotTables() {
    // Таблицы уже созданы в основном блоке инициализации БД
    if (!global.db) return;
    // Проверяем существование таблиц и создаём если нет
    try {
        await global.db.run(`CREATE TABLE IF NOT EXISTS bots (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            username    TEXT NOT NULL UNIQUE,
            ownerId     TEXT NOT NULL,
            token       TEXT NOT NULL UNIQUE,
            avatarEmoji TEXT DEFAULT '🤖',
            description TEXT DEFAULT '',
            webhookUrl  TEXT DEFAULT '',
            isActive    INTEGER DEFAULT 1,
            miniAppUrl  TEXT DEFAULT '',
            miniAppTitle TEXT DEFAULT '',
            createdAt   TEXT NOT NULL
        )`);
        await global.db.run(`CREATE TABLE IF NOT EXISTS bot_commands (
            id          TEXT PRIMARY KEY,
            botId       TEXT NOT NULL,
            command     TEXT NOT NULL,
            description TEXT DEFAULT ''
        )`);
    } catch(e) {
        console.error('Error creating bot tables:', e.message);
    }
}

// Инициализируем при старте (после инициализации БД)
setTimeout(() => ensureBotTables().catch(e => console.error('bot tables error:', e.message)), 100);

// ── HTTP API для ботов (аналог Telegram Bot API) ──────────────────────────────

// GET /api/bot/:token/getMe — информация о боте
app.get('/api/bot/:token/getMe', async (req, res) => {
    const bot = await global.db.get('SELECT * FROM bots WHERE token=$1 AND isActive=1', [req.params.token]);
    if (!bot) return res.status(401).json({ ok: false, error: 'Invalid token' });
    res.json({ ok: true, result: {
        id: bot.id, name: bot.name, username: bot.username,
        description: bot.description, avatarEmoji: bot.avatarEmoji
    }});
});

// POST /api/bot/:token/sendMessage — бот отправляет сообщение
app.post('/api/bot/:token/sendMessage', async (req, res) => {
    const bot = await global.db.get('SELECT * FROM bots WHERE token=$1 AND isActive=1', [req.params.token]);
    if (!bot) return res.status(401).json({ ok: false, error: 'Invalid token' });

    const { chat_id, text, reply_to_message_id } = req.body;
    if (!chat_id || !text) return res.status(400).json({ ok: false, error: 'chat_id and text required' });

    const msgId = 'msg_' + uid();
    const now   = ts();

    await global.db.run(
        'INSERT INTO messages (id,chatId,senderPhone,senderName,text,timestamp,replyTo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [msgId, chat_id, bot.id, bot.name, text, now, reply_to_message_id || null]
    );

    const msgObj = {
        id: msgId, chatId: chat_id,
        senderPhone: bot.id, senderName: bot.name,
        text, timestamp: now,
        replyTo: reply_to_message_id || null,
        isBot: true, botAvatarEmoji: bot.avatarEmoji
    };
    await emitToChat(chat_id, 'message:new', msgObj);
    res.json({ ok: true, result: msgObj });
});

// POST /api/bot/:token/setWebhook — установить URL для уведомлений
app.post('/api/bot/:token/setWebhook', async (req, res) => {
    const bot = await global.db.get('SELECT id FROM bots WHERE token=$1', [req.params.token]);
    if (!bot) return res.status(401).json({ ok: false, error: 'Invalid token' });
    const { url } = req.body;
    await global.db.run('UPDATE bots SET webhookUrl=$1 WHERE id=$2', [url || '', bot.id]);
    res.json({ ok: true, description: url ? 'Webhook set' : 'Webhook removed' });
});

// GET /api/bot/:token/getCommands — список команд
app.get('/api/bot/:token/getCommands', async (req, res) => {
    const bot = await global.db.get('SELECT id FROM bots WHERE token=$1', [req.params.token]);
    if (!bot) return res.status(401).json({ ok: false, error: 'Invalid token' });
    const cmds = await global.db.all('SELECT command,description FROM bot_commands WHERE botId=$1', [bot.id]);
    res.json({ ok: true, result: cmds });
});

// POST /api/bot/:token/setCommands — установить команды
app.post('/api/bot/:token/setCommands', async (req, res) => {
    const bot = await global.db.get('SELECT id FROM bots WHERE token=$1', [req.params.token]);
    if (!bot) return res.status(401).json({ ok: false, error: 'Invalid token' });
    const { commands } = req.body; // [{command, description}]
    if (!Array.isArray(commands)) return res.status(400).json({ ok: false, error: 'commands must be array' });
    await global.db.run('DELETE FROM bot_commands WHERE botId=$1', [bot.id]);
    for (const cmd of commands.slice(0, 50)) {
        if (cmd.command) await global.db.run(
            'INSERT INTO bot_commands (id,botId,command,description) VALUES ($1,$2,$3,$4)',
            [uid(), bot.id, cmd.command.replace(/^\//, ''), cmd.description || '']
        );
    }
    res.json({ ok: true });
});

// ── Mini App: нативный запуск HTML страниц ────────────────────────────────────
// Создаём директорию для мини-приложений
const MINIAPPS_DIR = path.join(__dirname, 'miniapps');
fs.mkdir(MINIAPPS_DIR, { recursive: true }).catch(() => {});

// Статический доступ к мини-приложениям
app.use('/miniapps', express.static(MINIAPPS_DIR));

// GET /api/miniapp/create — создание мини-приложения из HTML контента
app.post('/api/miniapp/create', async (req, res) => {
    try {
        const { botId, name, htmlContent } = req.body;
        if (!botId || !name || !htmlContent) {
            return res.status(400).json({ error: 'Требуется botId, name и htmlContent' });
        }
        
        // Проверяем существование бота
        const bot = await global.db.get('SELECT id FROM bots WHERE id=$1', [botId]);
        if (!bot) {
            return res.status(404).json({ error: 'Бот не найден' });
        }
        
        // Создаём безопасное имя файла
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = `${safeName}_${Date.now()}.html`;
        const filePath = path.join(MINIAPPS_DIR, fileName);
        
        // Сохраняем HTML файл
        await fs.writeFile(filePath, htmlContent, 'utf8');
        
        // Обновляем запись бота с путём к мини-приложению
        const miniAppUrl = `/miniapps/${fileName}`;
        await global.db.run(
            'UPDATE bots SET miniAppUrl=$1, miniAppTitle=$2 WHERE id=$3',
            [miniAppUrl, name, botId]
        );
        
        res.json({ success: true, url: miniAppUrl, path: filePath });
    } catch (e) {
        console.error('Ошибка создания мини-приложения:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/miniapp/list — список всех мини-приложений
app.get('/api/miniapp/list', async (req, res) => {
    try {
        const files = await fs.readdir(MINIAPPS_DIR);
        const htmlFiles = files.filter(f => f.endsWith('.html'));
        const apps = [];
        
        for (const file of htmlFiles) {
            const filePath = path.join(MINIAPPS_DIR, file);
            const stats = await fs.stat(filePath);
            apps.push({
                fileName: file,
                url: `/miniapps/${file}`,
                size: stats.size,
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime
            });
        }
        
        res.json(apps);
    } catch (e) {
        console.error('Ошибка получения списка мини-приложений:', e);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/miniapp/delete/:fileName — удаление мини-приложения
app.delete('/api/miniapp/delete/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        if (!fileName.endsWith('.html')) {
            return res.status(400).json({ error: 'Неверный формат файла' });
        }
        
        const filePath = path.join(MINIAPPS_DIR, fileName);
        await fs.unlink(filePath);
        
        // Очищаем ссылку у связанных ботов
        await global.db.run(
            'UPDATE bots SET miniAppUrl=NULL, miniAppTitle=NULL WHERE miniAppUrl LIKE $1',
            [`%/miniapps/${fileName}`]
        );
        
        res.json({ success: true });
    } catch (e) {
        console.error('Ошибка удаления мини-приложения:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /miniapp/:botId — открывает мини-приложение бота
app.get('/miniapp/:botId', async (req, res) => {
    const bot = await global.db.get('SELECT miniAppUrl,miniAppTitle,name,id FROM bots WHERE id=$1', [req.params.botId]);
    if (!bot?.miniAppUrl) return res.status(404).send('Mini App не найден');
    
    // Если это внешний URL — редирект
    if (bot.miniAppUrl.startsWith('http')) {
        return res.redirect(bot.miniAppUrl);
    }
    
    // Если это локальный файл — отдаём его через редирект
    res.redirect(bot.miniAppUrl);
});

// GET /miniapp/view/:botId — просмотр мини-приложения в iframe (обёртка)
app.get('/miniapp/view/:botId', async (req, res) => {
    const bot = await global.db.get('SELECT miniAppUrl,miniAppTitle,name,id FROM bots WHERE id=$1', [req.params.botId]);
    if (!bot?.miniAppUrl) return res.status(404).send('Mini App не найден');
    
    const appUrl = bot.miniAppUrl.startsWith('http') ? bot.miniAppUrl : bot.miniAppUrl;
    
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${bot.miniAppTitle || bot.name || 'Mini App'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body, html { width: 100%; height: 100%; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; }
        .header { 
            position: fixed; top: 0; left: 0; right: 0; 
            background: #1a1d24; color: white; padding: 12px 20px;
            z-index: 1000; display: flex; align-items: center; gap: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .header h1 { font-size: 16px; font-weight: 600; }
        .content { margin-top: 50px; height: calc(100% - 50px); }
    </style>
</head>
<body>
    <div class="header">
        <span>🤖</span>
        <h1>${bot.miniAppTitle || bot.name || 'Mini App'}</h1>
    </div>
    <div class="content">
        <iframe src="${appUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </div>
    <script>
        // Telegram WebApp API совместимость
        window.Telegram = window.Telegram || {};
        window.Telegram.WebApp = {
            ready: () => console.log('Mini App готов'),
            expand: () => {},
            close: () => window.close(),
            sendData: (data) => console.log('sendData:', data),
            themeParams: {},
            platform: 'web'
        };
        
        // Сообщаем родительскому окну о готовности
        window.addEventListener('load', () => {
            window.parent.postMessage({ type: 'MINI_APP_READY', botId: '${bot.id}' }, '*');
        });
    </script>
</body>
</html>
    `);
});

// ── Socket.IO события для управления ботами ──────────────────────────────────
// Добавляем в основной io.on('connection') через отдельный обработчик
const _botHandlers = new Map(); // socket.id → handlers

function attachBotHandlers(socket) {

    // Создать бота
    socket.on('bot:create', async ({ name, username, avatarEmoji, description }) => {
        if (!socket.phone) return;
        if (!name?.trim() || !username?.trim())
            return socket.emit('bot:error', 'Введите имя и username');

        const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (cleanUsername.length < 3)
            return socket.emit('bot:error', 'Username минимум 3 символа (a-z, 0-9, _)');

        const exists = await global.db.get('SELECT 1 FROM bots WHERE username=$1', [cleanUsername]);
        if (exists) return socket.emit('bot:error', 'Username уже занят');

        const id    = 'bot_' + uid();
        const token = crypto.randomBytes(24).toString('hex'); // 48-символьный токен

        await global.db.run(
            'INSERT INTO bots (id,name,username,ownerId,token,avatarEmoji,description,createdAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [id, name.trim(), cleanUsername, socket.phone, token, avatarEmoji || '🤖', description || '', ts()]
        );

        socket.emit('bot:created', {
            id, name: name.trim(), username: cleanUsername,
            token, avatarEmoji: avatarEmoji || '🤖', description: description || '',
            webhookUrl: '', miniAppUrl: '', miniAppTitle: '', isActive: 1
        });
    });

    // Список моих ботов
    socket.on('bot:list', async () => {
        if (!socket.phone) return;
        const bots = await global.db.all(
            'SELECT id,name,username,avatarEmoji,description,webhookUrl,miniAppUrl,miniAppTitle,isActive,createdAt FROM bots WHERE ownerId=$1 ORDER BY createdAt DESC',
            [socket.phone]
        );
        // Для каждого бота добавляем команды
        for (const bot of bots) {
            bot.commands = await global.db.all('SELECT command,description FROM bot_commands WHERE botId=$1', [bot.id]);
        }
        socket.emit('bot:list', bots);
    });

    // Получить токен бота (только владелец)
    socket.on('bot:token', async ({ botId }) => {
        if (!socket.phone) return;
        const bot = await global.db.get('SELECT token FROM bots WHERE id=$1 AND ownerId=$2', [botId, socket.phone]);
        if (!bot) return socket.emit('bot:error', 'Бот не найден');
        socket.emit('bot:token', { botId, token: bot.token });
    });

    // Обновить бота
    socket.on('bot:update', async ({ botId, name, avatarEmoji, description, webhookUrl, miniAppUrl, miniAppTitle }) => {
        if (!socket.phone) return;
        const bot = await global.db.get('SELECT id FROM bots WHERE id=$1 AND ownerId=$2', [botId, socket.phone]);
        if (!bot) return socket.emit('bot:error', 'Бот не найден');
        await global.db.run(
            'UPDATE bots SET name=COALESCE($1,name), avatarEmoji=COALESCE($2,avatarEmoji), description=COALESCE($3,description), webhookUrl=COALESCE($4,webhookUrl), miniAppUrl=COALESCE($5,miniAppUrl), miniAppTitle=COALESCE($6,miniAppTitle) WHERE id=$7',
            [name||null, avatarEmoji||null, description||null, webhookUrl||null, miniAppUrl||null, miniAppTitle||null, botId]
        );
        const updated = await global.db.get('SELECT id,name,username,avatarEmoji,description,webhookUrl,miniAppUrl,miniAppTitle,isActive FROM bots WHERE id=$1', [botId]);
        socket.emit('bot:updated', updated);
    });

    // Удалить бота
    socket.on('bot:delete', async ({ botId }) => {
        if (!socket.phone) return;
        const bot = await global.db.get('SELECT 1 FROM bots WHERE id=$1 AND ownerId=$2', [botId, socket.phone]);
        if (!bot) return socket.emit('bot:error', 'Бот не найден');
        await global.db.run('DELETE FROM bot_commands WHERE botId=$1', [botId]);
        await global.db.run('DELETE FROM bots WHERE id=$1', [botId]);
        socket.emit('bot:deleted', { botId });
    });

    // Регенерировать токен
    socket.on('bot:regen_token', async ({ botId }) => {
        if (!socket.phone) return;
        const bot = await global.db.get('SELECT 1 FROM bots WHERE id=$1 AND ownerId=$2', [botId, socket.phone]);
        if (!bot) return socket.emit('bot:error', 'Бот не найден');
        const newToken = crypto.randomBytes(24).toString('hex');
        await global.db.run('UPDATE bots SET token=$1 WHERE id=$2', [newToken, botId]);
        socket.emit('bot:token', { botId, token: newToken });
    });

    // Добавить бота в чат (написать боту)
    socket.on('bot:open_chat', async ({ botUsername }) => {
        if (!socket.phone) return;
        const bot = await global.db.get('SELECT id,name,avatarEmoji FROM bots WHERE username=$1 AND isActive=1', [botUsername.toLowerCase()]);
        if (!bot) return socket.emit('bot:error', 'Бот не найден: @' + botUsername);
        // Создаём или открываем личный чат с ботом
        const chatId = [socket.phone, bot.id].sort().join('_');
        socket.emit('bot:chat_opened', { chatId, botId: bot.id, botName: bot.name, botAvatarEmoji: bot.avatarEmoji });
    });
}

// ── Webhook: отправить обновление на URL бота ─────────────────────────────────
async function sendWebhook(bot, update) {
    if (!bot.webhookUrl) return;
    try {
        await axios.post(bot.webhookUrl, update, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.warn(`⚠️  Webhook [${bot.username}] failed: ${e.message}`);
    }
}

// ── Перехват входящих сообщений для ботов ─────────────────────────────────────
// Когда пользователь пишет в чат, проверяем — бот ли получатель?
async function tryRouteToBot(chatId, senderPhone, senderName, text) {
    if (!text || !chatId) return;
    // chatId формата "phone_bot_xxx" — один из участников бот
    const parts = chatId.split('_');
    let botId = null;
    for (const part of parts) {
        if (part.startsWith('bot')) {
            // Проверяем есть ли такой бот
            const b = await global.db.get('SELECT * FROM bots WHERE id LIKE $1 AND isActive=1', ['%' + part + '%']);
            if (b) { botId = b.id; break; }
        }
    }
    // Также ищем бота по полному chatId
    const fullChatParts = chatId.split('_');
    for (const p of fullChatParts) {
        const candidate = fullChatParts.slice(fullChatParts.indexOf(p)).join('_');
        const b = await global.db.get('SELECT * FROM bots WHERE id=$1 AND isActive=1', [candidate]);
        if (b) { botId = b.id; break; }
    }

    if (!botId) return;
    const bot = await global.db.get('SELECT * FROM bots WHERE id=$1', [botId]);
    if (!bot) return;

    // Формируем объект обновления (как Telegram Update)
    const update = {
        update_id: Date.now(),
        message: {
            message_id: uid(),
            from: { phone: senderPhone, name: senderName },
            chat: { id: chatId },
            text,
            date: Math.floor(Date.now() / 1000)
        }
    };

    // Шлём на Webhook если настроен
    await sendWebhook(bot, update);
}

// ── Глобальный обработчик ошибок Express ────────────────────────────────────
// Ловит любой крашнувший маршрут и всегда возвращает JSON (не пустое тело)
app.use((err, req, res, next) => {
    console.error('Express error:', req.method, req.url, err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + err.message });
    }
});

// 404 — тоже возвращаем JSON если это API запрос
app.use((req, res) => {
    if (req.url.startsWith('/api/')) {
        return res.status(404).json({ error: 'Маршрут не найден: ' + req.url });
    }
    res.status(404).send('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 БАЗА v1.0 Alpha → http://localhost:${PORT} [${IS_PG $1 'PostgreSQL' : 'SQLite'}] [PID:${process.pid}]`);
});