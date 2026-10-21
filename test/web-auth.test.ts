import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hitRateLimit } from '../src/db/rate-limit.js';
import { LOGIN_RATE_LIMIT } from '../src/web/auth-routes.js';
import { Browser, connect, csrfFrom, loginAs, registerClient, socialLogin, startTestServer, type TestServer } from './helpers.js';

const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s?.close();
});

const appPage = async (browser: Browser) => {
  const res = await browser.request(`${s.baseUrl}/app/connections`);
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
};

describe('소셜 로그인과 가입', () => {
  it('첫 GitHub 로그인에서 가입되고, 다시 로그인하면 같은 사용자다', async () => {
    const account = { provider: 'github' as const, id: '42', name: 'Octo', email: 'octo@example.com' };
    const browser = new Browser();
    const res = await socialLogin(s, browser, account, '/app/connections');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/connections');
    const { rows } = await s.db.query<{ id: string; email: string; display_name: string; terms_agreed_at: Date | null; status: string }>(
      `SELECT u.* FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.provider = 'github' AND a.provider_account_id = '42'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'octo@example.com', display_name: 'Octo', status: 'active' });
    expect(rows[0].terms_agreed_at).not.toBeNull();
    expect((await appPage(browser)).html).toContain('Octo</b> 계정으로 로그인했습니다');

    const again = await loginAs(s, account);
    expect(again.userId).toBe(rows[0].id);
  });

  it('Google 로그인은 ID 토큰의 sub로 계정을 구분하며, 이메일이 같아도 GitHub 계정과 합치지 않는다', async () => {
    const google = await loginAs(s, { provider: 'google', id: 'g-1', name: 'G', email: 'same@example.com' });
    const github = await loginAs(s, { provider: 'github', id: '777', name: 'H', email: 'same@example.com' });
    expect(google.userId).not.toBe(github.userId);
  });

  it('state가 맞지 않는 콜백은 거부하고 세션을 만들지 않는다', async () => {
    const browser = new Browser();
    const start = await browser.request(`${s.baseUrl}/auth/github`);
    const callback = new URL(new URL(start.headers.get('location')!).searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'whatever', state: 'forged' }).toString();
    const res = await browser.request(callback.href);
    expect(res.status).toBe(400);
    expect(browser.cookies.has('sid')).toBe(false);
  });

  it('로그인 후 돌아갈 곳은 같은 사이트 경로만 받는다', async () => {
    for (const evil of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
      const res = await socialLogin(s, new Browser(), { provider: 'github', id: 'redirect-user' }, evil);
      expect(res.headers.get('location')).toBe('/app/connections');
    }
  });

  it('로그인 시도는 IP당 횟수가 제한된다', async () => {
    const browser = new Browser();
    for (let i = 0; i < LOGIN_RATE_LIMIT.limit; i++) {
      expect((await browser.request(`${s.baseUrl}/auth/github`)).status).toBe(303);
    }
    expect((await browser.request(`${s.baseUrl}/auth/github`)).status).toBe(429);
    // 다른 IP는 영향받지 않는다
    expect((await new Browser().request(`${s.baseUrl}/auth/github`)).status).toBe(303);
  });
});

describe('웹 세션', () => {
  it('세션 쿠키는 서명되고 HttpOnly·Secure·SameSite=Lax, 7일 만료다', async () => {
    const browser = new Browser();
    const res = await socialLogin(s, browser, { provider: 'github', id: 'cookie-user' });
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('sid=') && !c.startsWith('sid=;'))!;
    expect(sid).toMatch(/; Max-Age=604800/);
    expect(sid).toMatch(/; HttpOnly/);
    expect(sid).toMatch(/; Secure/);
    expect(sid).toMatch(/; SameSite=Lax/);
    const { rows } = await s.db.query<{ days: number }>(
      `SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM sessions ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0].days).toBe(7);
  });

  it('로그인하지 않았거나 서명이 틀린 세션은 로그인 화면으로 보낸다', async () => {
    expect(await appPage(new Browser())).toMatchObject({ status: 303, location: '/login?return_to=%2Fapp%2Fconnections' });

    const { browser } = await loginAs(s, 'tamper-user');
    const signed = decodeURIComponent(browser.cookies.get('sid')!);
    browser.cookies.set('sid', encodeURIComponent(`${signed.slice(0, signed.lastIndexOf('.'))}.forged`));
    expect((await appPage(browser)).status).toBe(303);
  });

  it('만료된 세션은 로그인 화면으로 보낸다', async () => {
    const { browser, userId } = await loginAs(s, 'expire-user');
    await s.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
    expect((await appPage(browser)).status).toBe(303);
  });

  it('로그아웃은 CSRF 토큰을 확인하고 세션을 지운다', async () => {
    const { browser, userId } = await loginAs(s, 'logout-user');
    const { html } = await appPage(browser);
    expect((await browser.request(`${s.baseUrl}/logout`, browser.form({ csrf: 'forged' }))).status).toBe(403);
    expect((await appPage(browser)).status).toBe(200);

    expect((await browser.request(`${s.baseUrl}/logout`, browser.form({ csrf: csrfFrom(html) }))).status).toBe(303);
    expect((await appPage(browser)).status).toBe(303);
    const { rows } = await s.db.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [userId]);
    expect(rows).toHaveLength(0);
  });
});

describe('연결 설정 화면', () => {
  it('연결 목록을 보여 주고, CSRF 없는 해제와 다른 사용자의 연결 해제는 거부한다', async () => {
    const owner = await loginAs(s, 'owner');
    const intruder = await loginAs(s, 'intruder');
    const c = await registerClient(s, CLAUDE_CB, 'Claude');
    await connect(s, { clientId: c.client_id, redirectUri: CLAUDE_CB, browser: owner.browser });
    const { rows } = await s.db.query<{ id: string }>(`SELECT id FROM oauth_connections WHERE user_id = $1`, [owner.userId]);
    const id = rows[0].id;

    const { html } = await appPage(owner.browser);
    expect(html).toContain('<td>Claude</td>');
    expect(html).toContain('https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=AI+Debate+Hub&amp;connectorUrl=');
    expect(html).toContain('data-dialog="codex-connect"');
    expect(html).toContain('codex://plugins/install/ai-debate?marketplace=ai-debate-local');
    expect(html).toContain(`/app/connections/${id}/revoke`);
    expect(html).toContain(s.config.resource);

    const revokeUrl = `${s.baseUrl}/app/connections/${id}/revoke`;
    expect((await owner.browser.request(revokeUrl, owner.browser.form({ csrf: '' }))).status).toBe(403);
    const intruderCsrf = csrfFrom((await appPage(intruder.browser)).html);
    expect((await intruder.browser.request(revokeUrl, intruder.browser.form({ csrf: intruderCsrf }))).status).toBe(404);
    const still = await s.db.query(`SELECT 1 FROM oauth_connections WHERE id = $1 AND revoked_at IS NULL`, [id]);
    expect(still.rows).toHaveLength(1);
  });
});

describe('공개 페이지', () => {
  it('소개·로그인·약관·개인정보 처리방침을 보여 준다', async () => {
    for (const [path, text] of [
      ['/', 'MCP 주소'],
      ['/login', 'Google로 로그인'],
      ['/terms', '이용약관'],
      ['/privacy', '국외'],
    ]) {
      const res = await fetch(`${s.baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(text);
    }
  });
});

describe('횟수 제한 카운터', () => {
  it('동시에 증가해도 정확히 한도만큼만 허용한다', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => hitRateLimit(s.db, 'test:concurrent', 60, 4)));
    expect(results.filter(Boolean)).toHaveLength(4);
  });
});
