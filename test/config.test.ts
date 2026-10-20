import { describe, expect, it } from 'vitest';
import { loadConfig, missingEnv } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x', COOKIE_KEYS: 'k', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };

describe('설정', () => {
  it('필수 값이 다 있으면 빠진 것이 없다', () => {
    expect(missingEnv(base)).toEqual([]);
    expect(missingEnv({ ...base, GITHUB_CLIENT_ID: '', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' })).toEqual([]);
  });

  it('빠진 변수 이름을 알려 준다', () => {
    expect(missingEnv({})).toEqual([
      'DATABASE_URL',
      'COOKIE_KEYS',
      'GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET 또는 GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET',
    ]);
  });

  it('BASE_URL이 없으면 Vercel 운영 도메인을 쓴다', () => {
    expect(loadConfig({ ...base, VERCEL_PROJECT_PRODUCTION_URL: 'ai-debate-hub.vercel.app' }).baseUrl).toBe(
      'https://ai-debate-hub.vercel.app',
    );
    expect(loadConfig({ ...base, BASE_URL: 'https://example.com/', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }).baseUrl).toBe(
      'https://example.com',
    );
  });
});
