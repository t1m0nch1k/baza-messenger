import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../modules/auth/tokens';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const payload = verifyAccessToken(token);
    req.auth = { phone: payload.sub, role: payload.role || 'user' };
    next();
  } catch {
    res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (!roles.includes(req.auth.role)) return res.status(403).json({ error: 'FORBIDDEN' });
    next();
  };
}

