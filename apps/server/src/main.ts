import http from 'node:http';
import { env } from './config/env';
import { createApp } from './app';

const app = createApp();

const server = http.createServer(app);
server.listen(env.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`✅ v2 API listening on http://localhost:${env.port}`);
});

