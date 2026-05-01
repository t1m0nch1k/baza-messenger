import { Router } from 'express';
import * as bcrypt from 'bcrypt';
import { z } from 'zod';
import { getDb } from '../../db/sqlite';
import { requireAuth } from '../../middleware/authz';
import { loginWithPassword, refreshSession, revokeRefreshToken } from './auth.service';

const router = Router();

const loginSchema = z.object({
  phone: z.string().min(3).max(32),
  password: z.string().min(1),
});

const registerSchema = z.object({
  phone: z.string().min(3).max(32),
  nickname: z.string().min(2).max(32),
  password: z.string().min(6).max(128),
});

const refreshCookieName = 'baza_rt';

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYLOAD' });

  const db = await getDb();
  const phone = parsed.data.phone.trim();
  const nickname = parsed.data.nickname.trim();

  const existing = await db.get<{ phone: string }>('SELECT phone FROM users WHERE phone=?', [phone]);
  if (existing) return res.status(409).json({ error: 'PHONE_ALREADY_EXISTS' });

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  await db.run(
    `INSERT INTO users (phone,nickname,passwordHash,role,isBanned,isPremium)
     VALUES (?,?,?,?,?,?)`,
    [phone, nickname, passwordHash, 'user', 0, 0],
  );

  res.status(201).json({ ok: true });
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYLOAD' });

  try {
    const result = await loginWithPassword(
      parsed.data.phone.trim(),
      parsed.data.password,
      req.header('user-agent') || undefined,
      req.ip,
    );

    res.cookie(refreshCookieName, result.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/api/v2/auth',
    });

    res.json({
      accessToken: result.accessToken,
      user: result.user,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'LOGIN_FAILED';
    if (code === 'USER_BANNED') return res.status(403).json({ error: 'USER_BANNED' });
    if (code === 'INVALID_CREDENTIALS') return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    res.status(500).json({ error: 'LOGIN_FAILED' });
  }
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[refreshCookieName] as string | undefined;
  if (!refreshToken) return res.status(401).json({ error: 'INVALID_REFRESH' });

  try {
    const result = await refreshSession(refreshToken);
    res.json(result);
  } catch {
    res.status(401).json({ error: 'INVALID_REFRESH' });
  }
});

router.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.[refreshCookieName] as string | undefined;
  if (refreshToken) {
    try {
      await revokeRefreshToken(refreshToken);
    } catch {
      // no-op
    }
  }
  res.clearCookie(refreshCookieName, { path: '/api/v2/auth' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const db = await getDb();
  const user = await db.get<{ phone: string; nickname: string; role: string; isPremium: number }>(
    'SELECT phone,nickname,role,isPremium FROM users WHERE phone=?',
    [req.auth!.phone],
  );
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({
    user: {
      phone: user.phone,
      nickname: user.nickname,
      role: user.role || 'user',
      isPremium: !!user.isPremium,
    },
  });
});

export { router as authRoutes };
