import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Db, Queryable } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';

export const PASSCODE = 'test-passcode';

export function createPgliteDb(): Db {
  const pg = new PGlite();
  const wrap = (c: PGlite | Transaction): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await c.query<T>(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return { ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) };
}

export interface TestServer {
  baseUrl: string;
  config: Config;
  db: Db;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const db = createPgliteDb();
  await migrate(db);
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({ BASE_URL: baseUrl, STAGE1_PASSCODE: PASSCODE, COOKIE_KEYS: 'test-key' });
  server.on('request', createApp(config, db));
  return { baseUrl, config, db, close: () => new Promise((r) => server.close(() => r())) };
}

// 리디렉트를 직접 따라가며 쿠키를 유지하는 최소 브라우저
export class Browser {
  private cookies = new Map<string, string>();

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }

  // 3xx를 따라가다가 stopPrefix로 시작하는 주소에 도달하면 그 주소를 반환
  async follow(url: string, stopPrefix: string, init?: RequestInit): Promise<string> {
    let res = await this.request(url, init);
    let current = url;
    for (let i = 0; i < 10; i++) {
      if (res.status < 300 || res.status >= 400) return current;
      current = new URL(res.headers.get('location')!, current).href;
      if (current.startsWith(stopPrefix)) return current;
      res = await this.request(current);
    }
    throw new Error('too many redirects');
  }

  form(fields: Record<string, string>) {
    return { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function registerClient(s: TestServer, redirectUri: string, clientName: string) {
  const res = await fetch(`${s.config.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: redirectUri.startsWith('http://127.0.0.1') ? 'native' : 'web',
    }),
  });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${await res.text()}`);
  return (await res.json()) as { client_id: string };
}

// 로그인·동의를 거쳐 인가 코드를 받는다
export async function authorize(
  s: TestServer,
  opts: { clientId: string; redirectUri: string; username: string; participant: 'claude' | 'codex'; browser?: Browser },
) {
  const browser = opts.browser ?? new Browser();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: s.config.resource,
    scope: 'mcp',
    state: 'st',
  });
  let at = await browser.follow(`${s.config.issuer}/authorize?${q}`, opts.redirectUri);
  if (at.includes('/interaction/') && !at.startsWith(opts.redirectUri)) {
    const page = await (await browser.request(at)).text();
    if (page.includes('name="passcode"')) {
      const uid = at.split('/interaction/')[1];
      at = await browser.follow(
        `${s.config.issuer}/interaction/${uid}/login`,
        opts.redirectUri,
        browser.form({ username: opts.username, passcode: PASSCODE }),
      );
    }
  }
  const consentUrl = at;
  const consentPage = await (await browser.request(consentUrl)).text();
  const uid = consentUrl.split('/interaction/')[1];
  const callback = await browser.follow(
    `${s.config.issuer}/interaction/${uid}/consent`,
    opts.redirectUri,
    browser.form({ participant: opts.participant }),
  );
  const cb = new URL(callback);
  return { code: cb.searchParams.get('code')!, iss: cb.searchParams.get('iss'), verifier, consentPage, browser };
}

export async function token(s: TestServer, body: Record<string, string>) {
  const res = await fetch(`${s.config.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

export async function exchangeCode(s: TestServer, clientId: string, redirectUri: string, code: string, verifier: string) {
  return token(s, {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: s.config.resource,
  });
}

export async function callGetState(s: TestServer, accessToken: string) {
  const res = await fetch(s.config.resource, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_state', arguments: { discussion_id: 'dummy' } },
    }),
  });
  if (res.status !== 200) return { status: res.status, state: undefined };
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  return { status: res.status, state: JSON.parse(body.result.content[0].text) as { user: string; me: string } };
}
