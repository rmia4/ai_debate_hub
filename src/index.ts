// Vercel 진입점: Express 앱을 기본 내보내기로 둔다
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

export default createApp(loadConfig(), createPgDb(url));
