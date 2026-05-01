import cookieParser from 'cookie-parser';
import express from 'express';
import { env } from './config/env';
import { authRoutes } from './modules/auth/auth.routes';
import { adminRoutes } from './modules/admin/admin.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', env.corsOrigin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/v2/health', (_req, res) => {
    res.json({ ok: true, service: 'baza-server-v2', ts: new Date().toISOString(), env: env.nodeEnv });
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

