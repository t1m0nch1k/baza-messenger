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

