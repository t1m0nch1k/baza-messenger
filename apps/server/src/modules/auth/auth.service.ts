import * as bcrypt from 'bcrypt';
import { getDb } from '../../db/sqlite';
import { newId, sha256, signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';

type LoginResult = {
  accessToken: string;
  refreshToken: string;
  user: { phone: string; nickname: string; role: string; isPremium: boolean };
};

function parseRefreshExpiryDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date;
}

export async function loginWithPassword(
  phone: string,
  password: string,
  userAgent?: string,
  ip?: string,
): Promise<LoginResult> {
  const db = await getDb();
  const user = await db.get<{
    phone: string;
    nickname: string;
    passwordHash: string;
    role: string;
    isBanned: number;
    isPremium: number;
  }>('SELECT phone,nickname,passwordHash,role,isBanned,isPremium FROM users WHERE phone=?', [phone]);

  if (!user) throw new Error('INVALID_CREDENTIALS');
  if (user.isBanned) throw new Error('USER_BANNED');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error('INVALID_CREDENTIALS');

  const jti = newId('rt');
  const refreshToken = signRefreshToken(user.phone, jti);
  const accessToken = signAccessToken(user.phone, user.role || 'user');
  const expiresAt = parseRefreshExpiryDate().toISOString();

  await db.run(
    `INSERT INTO auth_refresh_tokens (id,phone,tokenHash,userAgent,ip,createdAt,expiresAt,revokedAt)
     VALUES (?,?,?,?,?,?,?,NULL)`,
    [jti, user.phone, sha256(refreshToken), userAgent || null, ip || null, new Date().toISOString(), expiresAt],
  );

  return {
    accessToken,
    refreshToken,
    user: {
      phone: user.phone,
      nickname: user.nickname,
      role: user.role || 'user',
      isPremium: !!user.isPremium,
    },
  };
}

export async function refreshSession(refreshToken: string) {
  const db = await getDb();
  const payload = verifyRefreshToken(refreshToken);
  if (payload.type !== 'refresh') throw new Error('INVALID_REFRESH');

  const row = await db.get<{ id: string; phone: string; revokedAt: string | null; expiresAt: string; tokenHash: string }>(
    'SELECT id,phone,revokedAt,expiresAt,tokenHash FROM auth_refresh_tokens WHERE id=?',
    [payload.jti],
  );

  if (!row) throw new Error('INVALID_REFRESH');
  if (row.revokedAt) throw new Error('INVALID_REFRESH');
  if (new Date(row.expiresAt).getTime() <= Date.now()) throw new Error('INVALID_REFRESH');
  if (row.tokenHash !== sha256(refreshToken)) throw new Error('INVALID_REFRESH');

  const user = await db.get<{ phone: string; role: string }>('SELECT phone,role FROM users WHERE phone=?', [row.phone]);
  if (!user) throw new Error('INVALID_REFRESH');

  const accessToken = signAccessToken(user.phone, user.role || 'user');
  return { accessToken, user: { phone: user.phone, role: user.role || 'user' } };
}

export async function revokeRefreshToken(refreshToken: string) {
  const db = await getDb();
  const payload = verifyRefreshToken(refreshToken);
  await db.run('UPDATE auth_refresh_tokens SET revokedAt=? WHERE id=?', [new Date().toISOString(), payload.jti]);
}

