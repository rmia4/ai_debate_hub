// docs/roadmap.md 2단계 완료 조건을 하나씩 고정한다
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFRESH_GRACE_SECONDS } from '../src/oauth/adapter.js';
import { revokeConnection } from '../src/oauth/connections.js';
import {
  activeConnectionCount,
  authorize,
  Browser,
  callGetState,
  connect,
  csrfFrom,
  exchangeCode,
  loginAs,
  refresh,
  registerClient,
  socialLogin,
  startAuthorize,
  startTestServer,
  submitConsent,
  type TestServer,
} from './helpers.js';

const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const CODEX_CB = 'http://127.0.0.1:47123/callback';

let s: TestServer;
let claudeClient: string;
let codexClient: string;
beforeAll(async () => {
  s = await startTestServer();
  claudeClient = (await registerClient(s, CLAUDE_CB, 'Claude')).client_id;
  codexClient = (await registerClient(s, CODEX_CB, 'Codex CLI')).client_id;
});
afterAll(async () => {
  await s?.close();
});

const connectClaude = (browser: Browser) => connect(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser });
const connectCodex = (browser: Browser) => connect(s, { clientId: codexClient, redirectUri: CODEX_CB, browser });

async function connectionOf(userId: string, clientId: string) {
  const { rows } = await s.db.query<{ id: string; grant_id: string; revoked_at: Date | null; revoke_reason: string | null }>(
    `SELECT id, grant_id, revoked_at, revoke_reason FROM oauth_connections WHERE user_id = $1 AND client_id = $2 ORDER BY id DESC LIMIT 1`,
    [userId, clientId],
  );
  return rows[0];
}

const setStatus = (userId: string, status: 'active' | 'suspended') =>
  s.db.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);

describe('두 계정의 Claude·Codex가 서로 다른 사용자로 판별', () => {
  it('GitHub 계정과 Google 계정의 네 연결이 각자 (사용자, 앱)으로 판별된다', async () => {
    const alice = await loginAs(s, { provider: 'github', id: '1001', name: 'Alice' });
    const bob = await loginAs(s, { provider: 'google', id: 'g-2002', name: 'Bob', email: 'bob@example.com' });
    expect(alice.userId).not.toBe(bob.userId);

    const tokens = {
      aliceClaude: await connectClaude(alice.browser),
      aliceCodex: await connectCodex(alice.browser),
      bobClaude: await connectClaude(bob.browser),
      bobCodex: await connectCodex(bob.browser),
    };
    expect((await callGetState(s, tokens.aliceClaude.access_token)).state).toMatchObject({ user: alice.userId, app: 'Claude' });
    expect((await callGetState(s, tokens.aliceCodex.access_token)).state).toMatchObject({ user: alice.userId, app: 'Codex CLI' });
    expect((await callGetState(s, tokens.bobClaude.access_token)).state).toMatchObject({ user: bob.userId, app: 'Claude' });
    expect((await callGetState(s, tokens.bobCodex.access_token)).state).toMatchObject({ user: bob.userId, app: 'Codex CLI' });
  });

  it('같은 브라우저에서 로그아웃 후 다른 계정으로 로그인하면 새 계정으로 연결된다', async () => {
    const carol = await loginAs(s, 'carol');
    await connectClaude(carol.browser);
    const page = await (await carol.browser.request(`${s.baseUrl}/app/connections`)).text();
    await carol.browser.request(`${s.baseUrl}/logout`, carol.browser.form({ csrf: csrfFrom(page) }));

    const dan = await loginAs(s, 'dan', carol.browser);
    const t = await connectClaude(carol.browser);
    expect(t.consentPage).toContain('dan</b> 계정으로');
    expect((await callGetState(s, t.access_token)).state).toMatchObject({ user: dan.userId, app: 'Claude' });
  });
});

describe('연결 해제·교체 후 기존 액세스 토큰 즉시 거부', () => {
  it('같은 앱으로 다시 연결하면(교체) 기존 토큰이 즉시 거부된다', async () => {
    const u = await loginAs(s, 'replace-user');
    const old = await connectClaude(u.browser);
    const fresh = await connectClaude(u.browser);
    expect(fresh.consentPage).toContain('교체합니다');
    expect((await callGetState(s, old.access_token)).status).toBe(401);
    expect((await refresh(s, claudeClient, old.refresh_token)).status).toBe(400);
    expect((await callGetState(s, fresh.access_token)).status).toBe(200);
    expect(await activeConnectionCount(s, u.userId, claudeClient)).toBe(1);
  });

  it('연결 설정 화면에서 해제하면 토큰이 즉시 거부되고 다른 앱 연결은 남는다', async () => {
    const u = await loginAs(s, 'revoke-user');
    const claude = await connectClaude(u.browser);
    const codex = await connectCodex(u.browser);
    const conn = await connectionOf(u.userId, claudeClient);
    const page = await (await u.browser.request(`${s.baseUrl}/app/connections`)).text();

    const res = await u.browser.request(`${s.baseUrl}/app/connections/${conn.id}/revoke`, u.browser.form({ csrf: csrfFrom(page) }));
    expect(res.status).toBe(303);
    expect((await callGetState(s, claude.access_token)).status).toBe(401);
    expect((await refresh(s, claudeClient, claude.refresh_token)).json.error).toBe('invalid_grant');
    expect((await connectionOf(u.userId, claudeClient)).revoke_reason).toBe('user_revoked');
    expect((await callGetState(s, codex.access_token)).status).toBe(200);
  });
});

describe('리프레시 토큰 재사용 시 연결 전체 폐기', () => {
  it('이미 다음 토큰으로 넘어간 리프레시 토큰이 다시 오면 연결과 모든 토큰이 폐기된다', async () => {
    const u = await loginAs(s, 'reuse-user');
    const t0 = await connectClaude(u.browser);
    const r1 = await refresh(s, claudeClient, t0.refresh_token);
    const r2 = await refresh(s, claudeClient, r1.json.refresh_token);
    expect(r2.status).toBe(200);

    const reuse = await refresh(s, claudeClient, t0.refresh_token);
    expect(reuse).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
    expect((await connectionOf(u.userId, claudeClient)).revoke_reason).toBe('grant_revoked');
    expect((await callGetState(s, r2.json.access_token)).status).toBe(401);
    expect((await refresh(s, claudeClient, r2.json.refresh_token)).status).toBe(400);
  });

  it('유예 시간이 지난 뒤의 재사용도 연결 전체를 폐기한다', async () => {
    const u = await loginAs(s, 'late-reuse-user');
    const t0 = await connectClaude(u.browser);
    const r1 = await refresh(s, claudeClient, t0.refresh_token);
    await s.db.query(
      `UPDATE oidc_models SET consumed_at = consumed_at - make_interval(secs => $1::int) WHERE model = 'RefreshToken' AND id = $2`,
      [REFRESH_GRACE_SECONDS + 1, t0.refresh_token],
    );
    expect((await refresh(s, claudeClient, t0.refresh_token)).status).toBe(400);
    expect((await connectionOf(u.userId, claudeClient)).revoked_at).not.toBeNull();
    expect((await callGetState(s, r1.json.access_token)).status).toBe(401);
  });
});

describe('정상적인 동시 갱신·응답 유실 재시도 처리', () => {
  it('응답을 못 받고 같은 리프레시 토큰으로 다시 갱신하면 새 토큰을 받고 연결은 유지된다', async () => {
    const u = await loginAs(s, 'retry-user');
    const t0 = await connectClaude(u.browser);
    const lost = await refresh(s, claudeClient, t0.refresh_token);
    expect(lost.status).toBe(200);

    const retry = await refresh(s, claudeClient, t0.refresh_token);
    expect(retry.status).toBe(200);
    expect((await callGetState(s, retry.json.access_token)).status).toBe(200);
    // 받지 못한 쪽 리프레시 토큰은 무효가 되며, 이것은 재사용으로 보지 않는다
    expect((await refresh(s, claudeClient, lost.json.refresh_token)).status).toBe(400);
    const next = await refresh(s, claudeClient, retry.json.refresh_token);
    expect(next.status).toBe(200);
    expect((await callGetState(s, next.json.access_token)).status).toBe(200);
    expect((await connectionOf(u.userId, claudeClient)).revoked_at).toBeNull();
  });

  it('같은 리프레시 토큰으로 동시에 갱신해도 서버 오류 없이 모두 성공하고, 살아남는 리프레시 토큰은 하나다', async () => {
    const u = await loginAs(s, 'concurrent-refresh-user');
    const t0 = await connectClaude(u.browser);
    const results = await Promise.all([1, 2, 3].map(() => refresh(s, claudeClient, t0.refresh_token)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    for (const r of results) expect((await callGetState(s, r.json.access_token)).status).toBe(200);

    const { rows } = await s.db.query<{ id: string }>(
      `SELECT m.id FROM oidc_models m JOIN oauth_connections c ON c.grant_id = m.grant_id
       WHERE m.model = 'RefreshToken' AND m.consumed_at IS NULL AND c.user_id = $1`,
      [u.userId],
    );
    expect(rows).toHaveLength(1);
    const survivor = results.find((r) => r.json.refresh_token === rows[0].id)!;
    expect((await refresh(s, claudeClient, survivor.json.refresh_token)).status).toBe(200);
    expect((await connectionOf(u.userId, claudeClient)).revoked_at).toBeNull();
  });
});

describe('인가 코드 동시 교환 시 한 번만 성공', () => {
  it('동시에 교환하면 하나만 토큰을 받고 나머지는 invalid_grant', async () => {
    const u = await loginAs(s, 'code-race-user');
    const a = await authorize(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser: u.browser });
    const results = await Promise.all([1, 2, 3].map(() => exchangeCode(s, claudeClient, CLAUDE_CB, a.code, a.verifier)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400).map((r) => r.json.error)).toEqual(['invalid_grant', 'invalid_grant']);
  });
});

describe('30일 만료 후 재연결 요구', () => {
  it('리프레시 토큰 만료는 갱신해도 연결 생성 시점 기준 30일로 고정된다', async () => {
    const u = await loginAs(s, 'fixed-expiry-user');
    const t0 = await connectClaude(u.browser);
    const r1 = await refresh(s, claudeClient, t0.refresh_token);
    const { rows } = await s.db.query<{ drift: number }>(
      `SELECT abs(extract(epoch FROM m.expires_at - c.expires_at))::int AS drift
       FROM oidc_models m JOIN oauth_connections c ON c.grant_id = m.grant_id
       WHERE m.model = 'RefreshToken' AND m.id = $1`,
      [r1.json.refresh_token],
    );
    expect(rows[0].drift).toBeLessThan(60);
  });

  it('30일이 지나면 액세스·리프레시 토큰이 모두 거부되고 다시 연결하면 쓸 수 있다', async () => {
    const u = await loginAs(s, 'expired-user');
    const t0 = await connectClaude(u.browser);
    const conn = await connectionOf(u.userId, claudeClient);
    // 30일 경과: 연결과 그 연결에서 나온 토큰의 만료 시각을 과거로 돌린다
    await s.db.query(`UPDATE oauth_connections SET expires_at = now() - interval '1 second' WHERE id = $1`, [conn.id]);
    expect((await callGetState(s, t0.access_token)).status).toBe(401);
    // 리프레시 토큰 행이 아직 남아 있어도 연결이 만료되면 갱신을 거부한다
    expect((await refresh(s, claudeClient, t0.refresh_token)).json.error).toBe('invalid_grant');
    await s.db.query(`UPDATE oidc_models SET expires_at = now() - interval '1 second' WHERE grant_id = $1`, [conn.grant_id]);
    expect((await refresh(s, claudeClient, t0.refresh_token)).json.error).toBe('invalid_grant');

    const page = await (await u.browser.request(`${s.baseUrl}/app/connections`)).text();
    expect(page).toContain('만료됨');
    const again = await connectClaude(u.browser);
    expect((await callGetState(s, again.access_token)).status).toBe(200);
  });
});

describe('동시 재연결 후 같은 사용자·앱의 미폐기 연결이 1개만 남음', () => {
  it('세 브라우저에서 동시에 같은 앱으로 동의해도 미폐기 연결은 1개이고 토큰은 그 연결만 받는다', async () => {
    // 테스트 브라우저는 쿠키 경로를 구분하지 않으므로 동시 인가는 브라우저를 나눠서 한다
    const logins = await Promise.all([1, 2, 3].map(() => loginAs(s, 'race-user', new Browser())));
    const userId = logins[0].userId;
    const flows = await Promise.all(logins.map(({ browser }) => startAuthorize(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser })));
    const codes = await Promise.all(flows.map((f) => submitConsent(f, CLAUDE_CB)));
    expect(await activeConnectionCount(s, userId, claudeClient)).toBe(1);

    // 교체당한 쪽은 코드를 못 받거나(동의 화면이 다시 뜸), 받은 코드가 거부된다
    const exchanged = await Promise.all(
      codes.filter((c) => c.code).map((c) => exchangeCode(s, claudeClient, CLAUDE_CB, c.code, c.verifier)),
    );
    const ok = exchanged.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect((await callGetState(s, ok[0].json.access_token)).status).toBe(200);
  });
});

describe('만료됐지만 미폐기인 연결이 있어도 재연결 성공', () => {
  it('만료된 기존 연결은 재연결 때 폐기되고 새 연결이 만들어진다', async () => {
    const u = await loginAs(s, 'stale-user');
    await connectClaude(u.browser);
    const stale = await connectionOf(u.userId, claudeClient);
    await s.db.query(`UPDATE oauth_connections SET expires_at = now() - interval '1 day' WHERE id = $1`, [stale.id]);

    const fresh = await connectClaude(u.browser);
    expect((await callGetState(s, fresh.access_token)).status).toBe(200);
    const { rows } = await s.db.query<{ revoke_reason: string }>(`SELECT revoke_reason FROM oauth_connections WHERE id = $1`, [stale.id]);
    expect(rows[0].revoke_reason).toBe('replaced');
    expect(await activeConnectionCount(s, u.userId, claudeClient)).toBe(1);
  });
});

describe('계정 정지와 해제', () => {
  it('정지 중에는 웹 세션·MCP 호출·새 로그인·인가·토큰 발급이 막히고, 해제 후 유효한 정보만 되살아난다', async () => {
    const account = { provider: 'github' as const, id: 'suspended-user', name: 'suspended-user' };
    const main = await loginAs(s, account);
    const other = await loginAs(s, account, new Browser());
    const leaver = await loginAs(s, account, new Browser());
    const claude = await connectClaude(main.browser);
    // 코드만 받고 아직 교환하지 않은 Codex 연결
    const pending = await authorize(s, { clientId: codexClient, redirectUri: CODEX_CB, browser: other.browser });

    await setStatus(main.userId, 'suspended');

    // 기존 웹 세션: 정지 안내와 로그아웃만
    const app = await main.browser.request(`${s.baseUrl}/app/connections`);
    expect(app.status).toBe(403);
    const suspendedHtml = await app.text();
    expect(suspendedHtml).toContain('이용이 정지된 계정');
    expect(suspendedHtml).toContain('action="/logout"');
    // MCP 호출
    expect((await callGetState(s, claude.access_token)).status).toBe(401);
    // 새 로그인: 세션을 만들지 않는다
    const before = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [main.userId]);
    const login = await socialLogin(s, new Browser(), account);
    expect(login.status).toBe(403);
    const after = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [main.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // 인가(동의 화면)
    const flow = await startAuthorize(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser: main.browser });
    expect(flow.consentStatus).toBe(403);
    expect(flow.consentPage).toContain('이용이 정지된 계정');
    const consent = await main.browser.request(`${flow.consentUrl}/consent`, main.browser.form({ csrf: csrfFrom(suspendedHtml) }));
    expect(consent.status).toBe(403);
    // 토큰 발급: 갱신·코드 교환
    expect((await refresh(s, claudeClient, claude.refresh_token)).json.error).toBe('invalid_grant');
    expect((await exchangeCode(s, codexClient, CODEX_CB, pending.code, pending.verifier)).json.error).toBe('invalid_grant');
    // 정지는 연결을 폐기하지 않는다
    expect((await connectionOf(main.userId, claudeClient)).revoked_at).toBeNull();
    // 로그아웃은 된다
    const leaverPage = await (await leaver.browser.request(`${s.baseUrl}/app/connections`)).text();
    expect((await leaver.browser.request(`${s.baseUrl}/logout`, leaver.browser.form({ csrf: csrfFrom(leaverPage) }))).status).toBe(303);

    // 정지 중에 만료·폐기된 정보
    expect(await revokeConnection(s.db, main.userId, (await connectionOf(main.userId, codexClient)).id)).toBe(true);
    await expireSessionOf(other.browser);

    await setStatus(main.userId, 'active');

    // 유효한 웹 세션·액세스 토큰·리프레시 토큰은 그대로 다시 쓴다 (정지 중 갱신 시도로 소모되지 않았다)
    expect((await main.browser.request(`${s.baseUrl}/app/connections`)).status).toBe(200);
    expect((await callGetState(s, claude.access_token)).status).toBe(200);
    const renewed = await refresh(s, claudeClient, claude.refresh_token);
    expect(renewed.status).toBe(200);
    expect((await callGetState(s, renewed.json.access_token)).status).toBe(200);
    // 만료된 세션, 폐기된 연결, 로그아웃한 세션은 되살아나지 않는다
    expect((await other.browser.request(`${s.baseUrl}/app/connections`)).status).toBe(303);
    expect((await leaver.browser.request(`${s.baseUrl}/app/connections`)).status).toBe(303);
    expect((await connectionOf(main.userId, codexClient)).revoke_reason).toBe('user_revoked');
    expect((await exchangeCode(s, codexClient, CODEX_CB, pending.code, pending.verifier)).status).toBe(400);
  });
});

// 브라우저의 세션 쿠키(토큰.서명)에 해당하는 세션 행을 만료시킨다. DB에는 토큰의 SHA-256 해시가 있다.
async function expireSessionOf(browser: Browser) {
  const signed = decodeURIComponent(browser.cookies.get('sid')!);
  const id = createHash('sha256').update(signed.slice(0, signed.lastIndexOf('.'))).digest('base64url');
  const r = await s.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
  expect(r.rowCount).toBe(1);
}
