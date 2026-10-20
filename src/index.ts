// Vercel 진입점: Express 앱을 기본 내보내기로 둔다
import express from 'express';
import { createApp } from './app.js';
import { loadConfig, missingEnv } from './config.js';
import { createPgDb } from './db/db.js';

// 필수 환경변수가 비어 있으면 함수가 죽는 대신 빠진 변수 이름을 알려 준다
function setupErrorApp(missing: string[]) {
  console.error(`필수 환경변수 누락: ${missing.join(', ')}`);
  const app = express();
  app.use((_req, res) => {
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send(`설정이 끝나지 않았습니다. 다음 환경변수를 넣고 다시 배포하세요:\n\n${missing.map((m) => `- ${m}`).join('\n')}\n`);
  });
  return app;
}

const missing = missingEnv();

export default missing.length ? setupErrorApp(missing) : createApp(loadConfig(), createPgDb(process.env.DATABASE_URL!));
