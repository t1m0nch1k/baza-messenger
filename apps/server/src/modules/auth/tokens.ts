import crypto from 'node:crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';

type AccessPayload = { sub: string; role: string };
type RefreshPayload = { sub: string; type: 'refresh'; jti: string };

export function signAccessToken(phone: string, role: string): string {
  const payload: AccessPayload = { sub: phone, role };
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.accessTtl } as SignOptions);
}

export function signRefreshToken(phone: string, jti: string): string {
  const payload: RefreshPayload = { sub: phone, type: 'refresh', jti };
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.refreshTtl } as SignOptions);
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, env.jwtAccessSecret) as AccessPayload;
}

export function verifyRefreshToken(token: string): RefreshPayload {
  return jwt.verify(token, env.jwtRefreshSecret) as RefreshPayload;
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

