import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorize,
  callGetState,
  exchangeCode,
  registerClient,
  startTestServer,
  token,
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
    const claude = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: claude.client_id, redirectUri: CLAUDE_CB, username: 'alice', participant: 'claude' });
    expect(a.iss).toBe(s.config.issuer);
    expect(a.consentPage).not.toContain('로컬 앱으로 돌아갑니다');
    const t1 = await exchangeCode(s, claude.client_id, CLAUDE_CB, a.code, a.verifier);
    expect(t1.status).toBe(200);
    expect(t1.json.refresh_token).toBeTruthy();
    expect(await callGetState(s, t1.json.access_token)).toMatchObject({ status: 200, state: { user: 'stage1:alice', me: 'claude' } });

    const codex = await registerClient(s, CODEX_CB, 'Codex');
    const b = await authorize(s, { clientId: codex.client_id, redirectUri: CODEX_CB, username: 'alice', participant: 'codex' });
    expect(b.consentPage).toContain('로컬 앱으로 돌아갑니다');
    const t2 = await exchangeCode(s, codex.client_id, CODEX_CB, b.code, b.verifier);
    expect(await callGetState(s, t2.json.access_token)).toMatchObject({ status: 200, state: { user: 'stage1:alice', me: 'codex' } });

    // 두 연결이 공존한다
    expect((await callGetState(s, t1.json.access_token)).status).toBe(200);
  });

  it('다른 계정은 다른 사용자로 판별된다', async () => {
    const claude = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: claude.client_id, redirectUri: CLAUDE_CB, username: 'bob', participant: 'claude' });
    const t = await exchangeCode(s, claude.client_id, CLAUDE_CB, a.code, a.verifier);
    expect(await callGetState(s, t.json.access_token)).toMatchObject({ state: { user: 'stage1:bob', me: 'claude' } });
  });
});

describe('MCP 클라이언트', () => {
  it('SDK 클라이언트로 initialize·도구 목록·get_state 호출이 된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, username: 'sdk', participant: 'claude' });
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
    expect(JSON.parse(r.content[0].text)).toMatchObject({ me: 'claude', user: 'stage1:sdk' });
    await client.close();
  });
});

describe('토큰 수명주기', () => {
  it('인가 코드는 한 번만 교환된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, username: 'carol', participant: 'claude' });
    const results = await Promise.all([
      exchangeCode(s, c.client_id, CLAUDE_CB, a.code, a.verifier),
      exchangeCode(s, c.client_id, CLAUDE_CB, a.code, a.verifier),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('같은 역할로 재연결하면 기존 액세스 토큰이 즉시 거부된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, username: 'dave', participant: 'claude' });
    const old = await exchangeCode(s, c.client_id, CLAUDE_CB, a.code, a.verifier);
    const b = await authorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, username: 'dave', participant: 'claude' });
    expect(b.consentPage).toContain('교체합니다');
    const fresh = await exchangeCode(s, c.client_id, CLAUDE_CB, b.code, b.verifier);

    expect((await callGetState(s, old.json.access_token)).status).toBe(401);
    expect((await callGetState(s, fresh.json.access_token)).status).toBe(200);
    const { rows } = await s.db.query(
      `SELECT count(*)::int AS n FROM oauth_connections WHERE user_id = 'stage1:dave' AND revoked_at IS NULL`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('리프레시 토큰을 재사용하면 연결 전체가 폐기된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const a = await authorize(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, username: 'erin', participant: 'claude' });
    const t = await exchangeCode(s, c.client_id, CLAUDE_CB, a.code, a.verifier);
    const r1 = await token(s, { grant_type: 'refresh_token', client_id: c.client_id, refresh_token: t.json.refresh_token, resource: s.config.resource });
    expect(r1.status).toBe(200);
    expect((await callGetState(s, r1.json.access_token)).status).toBe(200);

    const reuse = await token(s, { grant_type: 'refresh_token', client_id: c.client_id, refresh_token: t.json.refresh_token, resource: s.config.resource });
    expect(reuse.status).toBe(400);
    expect((await callGetState(s, r1.json.access_token)).status).toBe(401);
    const r2 = await token(s, { grant_type: 'refresh_token', client_id: c.client_id, refresh_token: r1.json.refresh_token, resource: s.config.resource });
    expect(r2.status).toBe(400);
  });

  it('다른 resource 요청은 거부된다', async () => {
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    const res = await fetch(
      `${s.config.issuer}/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: c.client_id,
        redirect_uri: CLAUDE_CB,
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        resource: 'https://evil.example/mcp',
      })}`,
      { redirect: 'manual' },
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
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
