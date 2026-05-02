import cookieParser from 'cookie-parser';
import express from 'express';
import { env } from './config/env';
import { adminRoutes } from './modules/admin/admin.routes';
import { authRoutes } from './modules/auth/auth.routes';

const corsOrigins = env.corsOrigin
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const requestOrigin = req.header('origin');
    const allowAny = corsOrigins.includes('*');
    const isAllowed = !requestOrigin || allowAny || corsOrigins.includes(requestOrigin);

    if (isAllowed) {
      if (requestOrigin && !allowAny) {
        res.header('Access-Control-Allow-Origin', requestOrigin);
      } else if (allowAny) {
        res.header('Access-Control-Allow-Origin', '*');
      }

      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }

    if (req.method === 'OPTIONS') {
      return isAllowed ? res.sendStatus(204) : res.sendStatus(403);
    }

    if (!isAllowed) {
      return res.status(403).json({ error: 'CORS_ORIGIN_FORBIDDEN' });
    }

    return next();
  });

  app.get('/api/v2/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'baza-server-v2',
      ts: new Date().toISOString(),
      env: env.nodeEnv,
    });
  });

  app.use('/api/v2/auth', authRoutes);
  app.use('/api/v2/admin', adminRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  });

  return app;
}
