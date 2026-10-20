import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { User } from '../db/users.js';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('base64url');

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// 첫 번째 키로 서명하고, 모든 키로 검증한다(키 교체 대비)
export function sign(config: Config, value: string) {
  return `${value}.${hmac(config.cookieKeys[0], value)}`;
}

export function unsign(config: Config, signed: string | undefined): string | undefined {
  if (!signed) return undefined;
  const i = signed.lastIndexOf('.');
  if (i <= 0) return undefined;
  const value = signed.slice(0, i);
  const sig = signed.slice(i + 1);
  return config.cookieKeys.some((k) => safeEqual(hmac(k, value), sig)) ? value : undefined;
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export const cookieOptions = (maxAgeSeconds: number) =>
  ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: maxAgeSeconds * 1000 }) as const;

export async function startSession(config: Config, db: Db, res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3::int))`,
    [sha256(token), userId, SESSION_TTL_SECONDS],
  );
  res.cookie(SESSION_COOKIE, sign(config, token), cookieOptions(SESSION_TTL_SECONDS));
}

export interface WebSession {
  user: User;
  token: string;
  csrf: string;
}

// 서명·만료를 확인하고 사용자를 함께 읽는다. 정지 여부 판단은 호출하는 쪽이 user.status로 한다.
export async function loadSession(config: Config, db: Db, req: Request): Promise<WebSession | undefined> {
  const token = unsign(config, readCookie(req, SESSION_COOKIE));
  if (!token) return undefined;
  const { rows } = await db.query<User>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  const user = rows[0];
  return user ? { user, token, csrf: hmac(config.cookieKeys[0], `csrf:${token}`) } : undefined;
}

export function checkCsrf(config: Config, session: WebSession, submitted: unknown) {
  return typeof submitted === 'string' && config.cookieKeys.some((k) => safeEqual(hmac(k, `csrf:${session.token}`), submitted));
}

export async function endSession(db: Db, res: Response, session: WebSession | undefined) {
  if (session) await db.query(`DELETE FROM sessions WHERE id = $1`, [sha256(session.token)]);
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}
