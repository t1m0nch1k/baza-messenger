import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const projectRoot = path.resolve(process.cwd(), '../..');
const rawSqlitePath = process.env.SQLITE_PATH || './baza.db';
const resolvedSqlitePath = path.isAbsolute(rawSqlitePath)
  ? rawSqlitePath
  : path.resolve(projectRoot, rawSqlitePath);

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT_V2 || 3100),
  dbPath: resolvedSqlitePath,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'change_me_access_secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'change_me_refresh_secret',
  accessTtl: process.env.JWT_ACCESS_TTL || '15m',
  refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
};

