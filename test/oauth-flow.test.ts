import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorize,
  Browser,
  callGetState,
  exchangeCode,
  loginAs,
  registerClient,
  startAuthorize,
  startTestServer,
  type TestServer,
} from './helpers.js';

const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const CODEX_CB = 'http://127.0.0.1:47123/callback';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s?.close();
});

describe('탐색', () => {
  it('토큰 없는 /mcp 요청은 401과 보호 리소스 메타데이터 위치를 준다', async () => {
    const res = await fetch(s.config.resource, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate')!;
    expect(www).toContain(`resource_metadata="${s.baseUrl}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('보호 리소스·인가 서버 메타데이터를 제공한다', async () => {
    const prm = await (await fetch(`${s.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: s.config.resource, authorization_servers: [s.config.issuer] });

    const as = await (await fetch(`${s.baseUrl}/.well-known/oauth-authorization-server/oauth`)).json();
    expect(as).toMatchObject({
      issuer: s.config.issuer,
      authorization_endpoint: `${s.config.issuer}/authorize`,
      token_endpoint: `${s.config.issuer}/token`,
      registration_endpoint: `${s.config.issuer}/register`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  });
});

describe('DCR + 동의 화면 역할 선택', () => {
  it('Claude용·Codex용 연결이 각자 역할로 판별된다', async () => {
    const alice = await loginAs(s, 'alice');
    const claude = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: claude.client_id, redirectUri: CLAUDE_CB, browser: alice.browser, participant: 'claude' });
    expect(a.iss).toBe(s.config.issuer);
    expect(a.consentPage).not.toContain('로컬 앱으로 돌아갑니다');
    const t1 = await exchangeCode(s, claude.client_id, CLAUDE_CB, a.code, a.verifier);
    expect(t1.status).toBe(200);
    expect(t1.json.refresh_token).toBeTruthy();
    expect(await callGetState(s, t1.json.access_token)).toMatchObject({ status: 200, state: { user: alice.userId, me: 'claude' } });

    const codex = await registerClient(s, CODEX_CB, 'Codex');
    const b = await authorize(s, { clientId: codex.client_id, redirectUri: CODEX_CB, browser: alice.browser, participant: 'codex' });
    expect(b.consentPage).toContain('로컬 앱으로 돌아갑니다');
    const t2 = await exchangeCode(s, codex.client_id, CODEX_CB, b.code, b.verifier);
    expect(await callGetState(s, t2.json.access_token)).toMatchObject({ status: 200, state: { user: alice.userId, me: 'codex' } });

    // 두 연결이 공존한다
    expect((await callGetState(s, t1.json.access_token)).status).toBe(200);
  });
});

describe('MCP 클라이언트', () => {
  it('SDK 클라이언트로 initialize·도구 목록·get_state 호출이 된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const sdk = await loginAs(s, 'sdk');
    const a = await authorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, browser: sdk.browser, participant: 'claude' });
    const t = await exchangeCode(s, c.client_id, CLAUDE_CB, a.code, a.verifier);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.config.resource), {
        requestInit: { headers: { authorization: `Bearer ${t.json.access_token}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name)).toEqual(['get_state']);
    const r = (await client.callTool({ name: 'get_state', arguments: { discussion_id: 'x' } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0].text)).toMatchObject({ me: 'claude', user: sdk.userId });
    await client.close();
  });
});

describe('CIMD', () => {
  it('비공개 주소의 클라이언트 메타데이터 문서는 조회하지 않고 거부한다', async () => {
    for (const clientId of ['https://127.0.0.1:1/client.json', 'https://10.0.0.1/client.json', 'https://localhost/client.json']) {
      const res = await fetch(
        `${s.config.issuer}/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: CLAUDE_CB,
          code_challenge: 'x'.repeat(43),
          code_challenge_method: 'S256',
        })}`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('invalid_client');
    }
  });
});

describe('DCR 등록 정책', () => {
  const register = (redirectUri: string, applicationType?: string) =>
    fetch(`${s.config.issuer}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        ...(applicationType ? { application_type: applicationType } : {}),
      }),
    });

  it('web 유형은 HTTPS 또는 루프백 HTTP 리디렉트만 등록된다', async () => {
    for (const uri of ['http://example.com/cb', 'http://192.168.0.10/cb']) {
      const res = await register(uri);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    }
    expect((await register('https://example.com/cb')).status).toBe(201);
    expect((await register('http://127.0.0.1:5555/cb')).status).toBe(201);
    expect((await register('http://localhost:5555/cb', 'web')).status).toBe(201);
  });

  it('native 유형의 루프백 콜백은 그대로 허용된다', async () => {
    expect((await register('http://127.0.0.1:47123/callback', 'native')).status).toBe(201);
  });
});

describe('동의 화면', () => {
  it('웹 세션이 없으면 로그인 화면으로 보내고, 로그인하면 동의 화면으로 돌아온다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const browser = new Browser();
    const flow = await startAuthorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, browser });
    expect(new URL(flow.consentUrl).pathname).toBe('/login');
    expect(flow.consentPage).toContain('GitHub로 로그인');
    const returnTo = new URL(flow.consentUrl).searchParams.get('return_to')!;
    expect(returnTo).toMatch(/^\/oauth\/interaction\//);

    await loginAs(s, 'consent-user', browser);
    const res = await browser.request(`${s.baseUrl}${returnTo}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('consent-user</b> 계정으로');
  });

  it('CSRF 토큰 없이 제출한 동의는 거부된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const { browser, userId } = await loginAs(s, 'csrf-user');
    const flow = await startAuthorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, browser });
    for (const csrf of ['', 'forged']) {
      const res = await browser.request(`${flow.consentUrl}/consent`, browser.form({ participant: 'claude', csrf }));
      expect(res.status).toBe(403);
    }
    const { rows } = await s.db.query(`SELECT 1 FROM oauth_connections WHERE user_id = $1`, [userId]);
    expect(rows).toHaveLength(0);
  });

  it('인가 서버 오류 화면은 한국어로 보여 준다', async () => {
    const res = await fetch(`${s.config.issuer}/authorize?client_id=unknown&response_type=code`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('등록되지 않았거나 확인할 수 없는 앱입니다');
    expect(html).toContain('lang="ko"');
  });
});
