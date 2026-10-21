import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { createApp } from '../src/create-app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Db, Queryable } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';

export const GITHUB_CLIENT_ID = 'github-client';
export const GOOGLE_CLIENT_ID = 'google-client';

export interface FakeAccount {
  provider: 'github' | 'google';
  id: string;
  name?: string;
  email?: string;
}

// 가짜 GitHub·Google. 서버가 같은 프로세스에서 돌므로 전역 fetch에서 두 서비스 주소만 가로채고
// 나머지 요청은 그대로 보낸다. Arctic의 실제 토큰 교환·응답 해석 코드를 그대로 통과한다.
const idpCodes = new Map<string, FakeAccount>();
const idpTokens = new Map<string, FakeAccount>();
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

globalThis.fetch = async (input, init) => {
  const href = input instanceof Request ? input.url : String(input);
  const { host, pathname } = new URL(href);
  if (!['github.com', 'api.github.com', 'oauth2.googleapis.com'].includes(host)) return realFetch(input, init);
  const req = new Request(input, init);
  if (pathname === '/login/oauth/access_token' || pathname === '/token') {
    const code = new URLSearchParams(await req.text()).get('code') ?? '';
    const account = idpCodes.get(code);
    idpCodes.delete(code);
    if (!account) return json({ error: 'invalid_grant' }, 400);
    const accessToken = randomBytes(8).toString('hex');
    idpTokens.set(accessToken, account);
    if (account.provider === 'github') return json({ access_token: accessToken, token_type: 'bearer', scope: 'read:user,user:email' });
    const claims = {
      iss: 'https://accounts.google.com',
      aud: GOOGLE_CLIENT_ID,
      sub: account.id,
      email: account.email,
      email_verified: true,
      name: account.name,
    };
    const idToken = [b64({ alg: 'RS256' }), b64(claims), 'sig'].join('.');
    return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
  }
  const account = idpTokens.get((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
  if (!account) return json({ message: 'Bad credentials' }, 401);
  if (pathname === '/user') return json({ id: account.id, login: account.id, name: account.name ?? null });
  if (pathname === '/user/emails') return json(account.email ? [{ email: account.email, primary: true, verified: true }] : []);
  return json({}, 404);
};

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

// 운영과 같은 모양의 키(scripts/gen-keys.ts: ES256 하나). 개발용 기본 키로는 서명 알고리즘 문제를 못 잡는다.
const TEST_JWKS = JSON.stringify({
  keys: [{ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'ES256' }],
});

export async function startTestServer(): Promise<TestServer> {
  const db = createPgliteDb();
  await migrate(db);
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({
    BASE_URL: baseUrl,
    COOKIE_KEYS: 'test-key',
    CRON_SECRET: 'cron-secret',
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: 'github-secret',
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'google-secret',
    JWKS: TEST_JWKS,
  });
  server.on('request', createApp(config, db));
  return { baseUrl, config, db, close: () => new Promise((r) => server.close(() => r())) };
}

let browserCount = 0;

// 리디렉트를 직접 따라가며 쿠키를 유지하는 최소 브라우저. 브라우저마다 다른 IP(X-Forwarded-For)로 접속한다.
export class Browser {
  cookies = new Map<string, string>();
  readonly ip = `10.0.${(++browserCount >> 8) & 255}.${browserCount & 255}`;

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', this.ip);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
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

export const csrfFrom = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

// 가짜 IdP를 거쳐 소셜 로그인한다. 콜백 응답을 반환한다.
export async function socialLogin(s: TestServer, browser: Browser, account: FakeAccount, returnTo = '/app/connections') {
  const start = await browser.request(`${s.baseUrl}/auth/${account.provider}?${new URLSearchParams({ return_to: returnTo })}`);
  if (start.status !== 303) return start;
  const authUrl = new URL(start.headers.get('location')!);
  const code = randomBytes(8).toString('hex');
  idpCodes.set(code, account);
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ code, state: authUrl.searchParams.get('state')! }).toString();
  return browser.request(callback.href);
}

export async function userIdOf(s: TestServer, account: FakeAccount) {
  const { rows } = await s.db.query<{ user_id: string }>(
    `SELECT user_id FROM accounts WHERE provider = $1 AND provider_account_id = $2`,
    [account.provider, account.id],
  );
  return rows[0]?.user_id;
}

// 문자열이면 그 이름의 GitHub 계정으로 로그인한 브라우저를 만든다
export async function loginAs(s: TestServer, who: string | FakeAccount, browser = new Browser()) {
  const account: FakeAccount = typeof who === 'string' ? { provider: 'github', id: who, name: who } : who;
  const res = await socialLogin(s, browser, account);
  if (res.status !== 303) throw new Error(`login failed ${res.status}`);
  return { browser, userId: (await userIdOf(s, account))!, account };
}

// 인가 요청을 보내 동의 화면까지 간다
export async function startAuthorize(s: TestServer, opts: { clientId: string; redirectUri: string; browser: Browser }) {
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
  const consentUrl = await opts.browser.follow(`${s.config.issuer}/authorize?${q}`, opts.redirectUri);
  const res = await opts.browser.request(consentUrl);
  const consentPage = await res.text();
  return { consentUrl, consentStatus: res.status, consentPage, csrf: csrfFrom(consentPage), verifier, browser: opts.browser };
}

export type AuthorizeFlow = Awaited<ReturnType<typeof startAuthorize>>;

// 동의 화면에서 역할을 골라 제출하고, 클라이언트 콜백으로 돌아온 인가 코드를 받는다
export async function submitConsent(flow: AuthorizeFlow, redirectUri: string, participant: 'claude' | 'codex') {
  const callback = await flow.browser.follow(
    `${flow.consentUrl}/consent`,
    redirectUri,
    flow.browser.form({ participant, csrf: flow.csrf }),
  );
  const cb = new URL(callback);
  return { code: cb.searchParams.get('code')!, iss: cb.searchParams.get('iss'), verifier: flow.verifier };
}

// 로그인·동의를 거쳐 인가 코드를 받는다. browser가 없으면 username으로 로그인한 새 브라우저를 쓴다.
export async function authorize(
  s: TestServer,
  opts: { clientId: string; redirectUri: string; participant: 'claude' | 'codex'; username?: string; browser?: Browser },
) {
  const browser = opts.browser ?? (await loginAs(s, opts.username!)).browser;
  const flow = await startAuthorize(s, { clientId: opts.clientId, redirectUri: opts.redirectUri, browser });
  const result = await submitConsent(flow, opts.redirectUri, opts.participant);
  return { ...result, consentPage: flow.consentPage, browser };
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

export async function refresh(s: TestServer, clientId: string, refreshToken: string) {
  return token(s, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: s.config.resource });
}

export interface ToolResult<T = Record<string, any>> {
  status: number;
  isError: boolean;
  data: T;
}

// MCP 도구를 호출한다. 도구 오류(isError)와 JSON-RPC 오류 모두 data에 담는다.
export async function callTool<T = Record<string, any>>(
  s: TestServer,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult<T>> {
  const res = await fetch(s.config.resource, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (res.status !== 200) return { status: res.status, isError: true, data: undefined as T };
  const body = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
  if (body.error) return { status: res.status, isError: true, data: body.error as T };
  const text = body.result!.content[0].text;
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { message: text } as T;
  }
  return { status: res.status, isError: !!body.result!.isError, data };
}

// 토큰이 어느 (사용자, 참여자)로 판별되는지 확인한다. 토론을 하나 만들어 소유자와 get_state의 me를 읽고 지운다.
export async function callGetState(s: TestServer, accessToken: string) {
  const created = await callTool(s, accessToken, 'start_discussion', { topic: 'whoami' });
  if (created.status !== 200) return { status: created.status, state: undefined };
  const id = created.data.discussion_id as string;
  const state = await callTool(s, accessToken, 'get_state', { discussion_id: id });
  const { rows } = await s.db.query<{ owner_id: string }>(`DELETE FROM discussions WHERE id = $1 RETURNING owner_id`, [id]);
  return { status: state.status, state: { user: rows[0].owner_id, me: state.data.me as string } };
}

// 처음부터 끝까지 연결해 토큰을 받는다
export async function connect(
  s: TestServer,
  opts: { clientId: string; redirectUri: string; participant: 'claude' | 'codex'; username?: string; browser?: Browser },
) {
  const a = await authorize(s, opts);
  const t = await exchangeCode(s, opts.clientId, opts.redirectUri, a.code, a.verifier);
  if (t.status !== 200) throw new Error(`exchange failed ${t.status} ${JSON.stringify(t.json)}`);
  return { access_token: t.json.access_token, refresh_token: t.json.refresh_token, browser: a.browser, consentPage: a.consentPage };
}

export async function activeConnectionCount(s: TestServer, userId: string, participant: string) {
  const { rows } = await s.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM oauth_connections WHERE user_id = $1 AND participant = $2 AND revoked_at IS NULL`,
    [userId, participant],
  );
  return rows[0].n;
}
