// docs/roadmap.md 4단계(웹 1단계) 완료 조건과 한도 검증을 하나씩 고정한다
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discussionsFor } from '../src/db/discussions.js';
import { hitRateLimit } from '../src/db/rate-limit.js';
import { renderMarkdown } from '../src/web/markdown.js';
import { Browser, callTool, connect, csrfFrom, loginAs, registerClient, startTestServer, type TestServer } from './helpers.js';

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

let userCount = 0;

// 테스트에서는 Claude 연결 토큰을 A석, Codex 연결 토큰을 B석으로 쓴다
const seatOf = new Map<string, string>();
const tool = (token: string, name: string, args: Record<string, unknown>) =>
  callTool(s, token, name, name === 'get_state' || name === 'submit' ? { seat: seatOf.get(token), ...args } : args);

// 웹 로그인 + Claude 연결. withCodex면 Codex도 연결한다.
async function user(withCodex = false) {
  const { browser, userId } = await loginAs(s, `web${++userCount}`);
  const claude = (await connect(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser })).access_token;
  const codex = withCodex
    ? (await connect(s, { clientId: codexClient, redirectUri: CODEX_CB, browser })).access_token
    : '';
  seatOf.set(claude, 'A');
  if (codex) seatOf.set(codex, 'B');
  const csrf = csrfFrom(await (await browser.request(`${s.baseUrl}/app/new`)).text());
  const get = (path: string) => browser.request(`${s.baseUrl}${path}`);
  const post = (path: string, fields: Record<string, string> = {}) =>
    browser.request(`${s.baseUrl}${path}`, browser.form({ csrf, ...fields }));
  return { browser, userId, claude, codex, csrf, get, post };
}
type User = Awaited<ReturnType<typeof user>>;

async function webCreate(u: User, fields: Record<string, string> = {}) {
  const res = await u.post('/app/new', { topic: '웹에서 만든 토론', ...fields });
  const id = /^\/app\/d\/([^?]+)/.exec(res.headers.get('location') ?? '')?.[1];
  return { res, id };
}

const mcpCreate = (u: User, topic = 'MCP에서 만든 토론') => tool(u.claude, 'start_discussion', { topic });

// 종료된 토론을 DB에 직접 채운다(하루 생성 한도와 무관하게 보관 한도를 시험하기 위해)
async function fillEnded(userId: string, count: number, contextBytes = 0) {
  await s.db.query(
    `INSERT INTO discussions (id, owner_id, topic, context, mode, max_rounds, min_rounds, status, ended_at)
     SELECT 'pad-' || md5(random()::text), $1, 'old', repeat('a', $3::int), 'parallel', 5, 2, 'closed', now()
     FROM generate_series(1, $2::int)`,
    [userId, count, contextBytes],
  );
}

const count = async (sql: string, params: unknown[]) => (await s.db.query<{ n: number }>(sql, params)).rows[0].n;
const activeCount = (userId: string) =>
  count(`SELECT count(*)::int AS n FROM discussions WHERE owner_id = $1 AND status = 'active'`, [userId]);
const storedCount = (userId: string) => count(`SELECT count(*)::int AS n FROM discussions WHERE owner_id = $1`, [userId]);

describe('격리', () => {
  it('두 계정은 서로의 토론방을 목록·상세·내보내기·종료·삭제 어디서도 볼 수 없고, 없는 ID와 같은 404를 받는다', async () => {
    const alice = await user();
    const bob = await user();
    const { id } = await webCreate(alice, { topic: '앨리스의 비밀 주제' });
    expect(id).toBeTruthy();

    expect(await (await alice.get('/app')).text()).toContain('앨리스의 비밀 주제');
    expect(await (await bob.get('/app')).text()).not.toContain('앨리스의 비밀 주제');

    const missing = await bob.get('/app/d/no-such-discussion-id');
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    for (const res of [
      await bob.get(`/app/d/${id}`),
      await bob.get(`/app/d/${id}.md`),
      await bob.post(`/app/d/${id}/close`),
      await bob.post(`/app/d/${id}/delete`, { confirm: 'yes' }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(missingBody);
    }
    expect((await alice.get(`/app/d/${id}`)).status).toBe(200);
    expect(await storedCount(alice.userId)).toBe(1);
    expect(await activeCount(alice.userId)).toBe(1);
  });
});

describe('토론 화면', () => {
  it('생성 화면은 기밀·개인정보 금지를 안내하고, 생성 후 참여 문구와 참여자별 지시문을 복사 버튼과 함께 보여 준다', async () => {
    const u = await user();
    const form = await (await u.get('/app/new')).text();
    expect(form).toContain('기밀이나 개인정보를 넣지 마세요');

    const { res, id } = await webCreate(u, { topic: '캐시 전략', context: '읽기 위주', mode: 'sequential', max_rounds: '6' });
    expect(res.status).toBe(303);
    const detail = await (await u.get(res.headers.get('location')!)).text();
    expect(detail).toContain(`너는 ai-debate 토론 ${id}에 A석으로 참여한다. 진행 방식은 순차 방식이다.`);
    expect(detail).toContain(`너는 ai-debate 토론 ${id}에 B석으로 참여한다.`);
    expect(detail).toContain('seat에는 항상 &quot;A&quot;를 넣는다');
    expect(detail).toContain('배경: 읽기 위주');
    expect(detail).toContain('data-copy="instr-A"');
    expect(detail).toContain('data-copy="instr-B"');
    expect(detail).toContain(`<pre id="join-A">토론 ${id}에 A석으로 참여해</pre>`);
    expect(detail).toContain('data-copy="join-B"');
    expect((await u.get('/static/app.js')).status).toBe(200);

    const { rows } = await s.db.query(`SELECT mode, max_rounds, min_rounds FROM discussions WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ mode: 'sequential', max_rounds: 6, min_rounds: null });
  });

  it('잘못된 설정은 생성하지 않고 입력값과 함께 오류를 보여 준다', async () => {
    const u = await user();
    const { res } = await webCreate(u, { topic: '설정 오류', max_rounds: '11' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('max_rounds');
    expect((await webCreate(u, { topic: 'x'.repeat(201) })).res.status).toBe(400);
    expect(await storedCount(u.userId)).toBe(0);
  });

  it('상세 화면은 진행 중 라운드의 제출도 보여 주지만, MCP 조회는 완료된 라운드만 보여 준다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u);
    await tool(u.claude, 'submit', { discussion_id: id, expected_round: 1, content: '진행 중 라운드의 클로드 답변', proposal: '안 A' });

    const detail = await (await u.get(`/app/d/${id}`)).text();
    expect(detail).toContain('진행 중 라운드의 클로드 답변');
    expect(detail).toContain('아직 제출 안 함');
    const state = await tool(u.codex, 'get_state', { discussion_id: id });
    expect(JSON.stringify(state.data)).not.toContain('진행 중 라운드의 클로드 답변');
  });

  it('동시 토론 화면 방식은 기본이 A이고, 고른 방식은 쿠키로 기억하며 잘못된 값은 무시한다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u);
    await tool(u.claude, 'submit', { discussion_id: id, expected_round: 1, content: '화면 방식 확인용 답변', proposal: '안 A' });

    const current = (html: string) => /<option value="(\w)" selected>/.exec(html)?.[1];
    expect(current(await (await u.get(`/app/d/${id}`)).text())).toBe('a');
    for (const v of ['b', 'c', 'd', 'e', 'a']) {
      const html = await (await u.get(`/app/d/${id}?view=${v}`)).text();
      expect(current(html)).toBe(v);
      expect(html).toContain('화면 방식 확인용 답변');
      expect(html).toContain('아직 제출 안 함');
    }
    await u.get(`/app/d/${id}?view=c`);
    expect(current(await (await u.get(`/app/d/${id}`)).text())).toBe('c');
    expect(current(await (await u.get(`/app/d/${id}?view=toString`)).text())).toBe('c');
  });

  it('순차 토론도 같은 다섯 화면 방식을 고를 수 있고, 현재 합의안과 다음 차례를 보여 준다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u, { topic: '순차 화면 방식', mode: 'sequential' });
    await tool(u.claude, 'submit', { discussion_id: id, expected_round: 1, content: '선공 A석 답변', proposal: '순차 첫 안' });

    const current = (html: string) => /<option value="(\w)" selected>/.exec(html)?.[1];
    expect(current(await (await u.get(`/app/d/${id}`)).text())).toBe('a');
    for (const v of ['b', 'c', 'd', 'e', 'a']) {
      const html = await (await u.get(`/app/d/${id}?view=${v}`)).text();
      expect(current(html)).toBe(v);
      expect(html).toContain('선공 A석 답변');
      expect(html).toContain('순차 첫 안');
      expect(html).toContain('B석 차례');
    }
    // 고른 방식은 동시·순차가 함께 쓴다
    await u.get(`/app/d/${id}?view=e`);
    const { id: parallel } = await webCreate(u);
    expect(current(await (await u.get(`/app/d/${parallel}`)).text())).toBe('e');
  });

  it('목록은 진행 중 토론의 차례를 보여 주고, 프로젝트·진행 중·종료 탭으로 거를 수 있다', async () => {
    const u = await user(true);
    const pid = /^\/app\?project=(.+)$/.exec((await u.post('/app/projects/new', { name: '목록 프로젝트' })).headers.get('location') ?? '')?.[1];
    const { id: half } = await webCreate(u, { topic: '한쪽만 낸 토론' });
    await tool(u.claude, 'submit', { discussion_id: half, expected_round: 1, content: '답변', proposal: '안' });
    await webCreate(u, { topic: '아무도 안 낸 순차 토론', mode: 'sequential' });
    const { id: closed } = await webCreate(u, { topic: '닫은 프로젝트 토론', project_id: pid! });
    await u.post(`/app/d/${closed}/close`);

    const all = await (await u.get('/app')).text();
    expect(all).toContain('B석 대기');
    expect(all).toContain('선공 대기');
    expect(all).toContain('목록 프로젝트');
    // 사용량은 목록이 아니라 계정 화면에서 본다
    expect(all).not.toContain('USAGE');

    const onlyClosed = await (await u.get('/app?view=ended')).text();
    expect(onlyClosed).toContain('닫은 프로젝트 토론');
    expect(onlyClosed).not.toContain('한쪽만 낸 토론');

    const onlyActive = await (await u.get('/app?view=active')).text();
    expect(onlyActive).toContain('한쪽만 낸 토론');
    expect(onlyActive).not.toContain('닫은 프로젝트 토론');

    const inProject = await (await u.get(`/app?project=${pid}`)).text();
    expect(inProject).toContain('닫은 프로젝트 토론');
    expect(inProject).not.toContain('아무도 안 낸 순차 토론');
    // 프로젝트 탭은 상세를 접이식 구역으로 그 자리에 보여 준다
    expect(inProject).toContain('<summary>프로젝트 정보·설정</summary>');
    expect(inProject).toContain('<summary>배경 항목 (0/');
    expect(inProject).toContain(`action="/app/p/${pid}/edit"`);
    expect(inProject).not.toContain('프로젝트 열기');
    // 예전 단독 상세 주소는 프로젝트 탭으로 넘어간다
    const old = await u.get(`/app/p/${pid}`);
    expect(old.status).toBe(302);
    expect(old.headers.get('location')).toBe(`/app?project=${pid}`);
    // 기본 선택은 "전체"다
    expect(all).toMatch(/class="on" aria-current="page">전체/);
    // 모르는 값은 무시하고 전체를 보여 준다
    expect(await (await u.get('/app?view=toString&project=nope')).text()).toContain('한쪽만 낸 토론');
  });

  it('합의된 토론은 결론에 합의안을, 쟁점에 남은 이견을 보여 준다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u, { min_rounds: '2', max_rounds: '3' });
    const submit = (token: string, args: Record<string, unknown>) =>
      tool(token, 'submit', { discussion_id: id, content: '근거', ...args });
    const a = await submit(u.claude, { expected_round: 1, proposal: '**최종안** 내용', open_issues: ['비용 미확정'] });
    await submit(u.codex, { expected_round: 1, open_issues: ['운영 부담'] });
    const proposalId = a.data.submission.id;
    await submit(u.claude, { expected_round: 2, agreement: 'agree', accepted_proposal_id: proposalId });
    const end = await submit(u.codex, { expected_round: 2, agreement: 'agree', accepted_proposal_id: proposalId });
    expect(end.data.status).toBe('agreed');

    const detail = await (await u.get(`/app/d/${id}`)).text();
    expect(detail).toContain('합의 완료');
    expect(detail).toContain('<strong>최종안</strong> 내용');
    expect(detail).toContain('합의된 안');
    expect(detail).not.toContain('data-copy'); // 종료 후에는 지시문을 내지 않는다

    const md = await u.get(`/app/d/${id}.md`);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('content-disposition')).toContain('attachment');
    const text = await md.text();
    expect(text).toContain('## 결론');
    expect(text).toContain('**최종안** 내용');
    expect(text).toContain('구 형식 이견: 비용 미확정');
  });

  it('마지막 라운드에서 동의 대상이 엇갈린 채 끝나면 결론과 내보내기에 엇갈림을 표시한다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u, { min_rounds: '2', max_rounds: '2' });
    const submit = (token: string, args: Record<string, unknown>) =>
      tool(token, 'submit', { discussion_id: id, content: '근거', ...args });
    const a = (await submit(u.claude, { expected_round: 1, proposal: '안 A' })).data.submission.id;
    const b = (await submit(u.codex, { expected_round: 1, proposal: '안 B' })).data.submission.id;
    await submit(u.claude, { expected_round: 2, agreement: 'agree', accepted_proposal_id: b });
    const end = await submit(u.codex, { expected_round: 2, agreement: 'agree', accepted_proposal_id: a });
    expect(end.data.status).toBe('max_reached');

    const text = `양쪽 동의 대상이 엇갈림: A→${b}, B→${a}`;
    const detail = await (await u.get(`/app/d/${id}`)).text();
    expect(detail).toContain('최대 도달·합의 미확정');
    expect(detail).toContain(text);
    expect(await (await u.get(`/app/d/${id}.md`)).text()).toContain(text);
  });

  it('강제 종료하면 closed가 되고 이후 MCP 제출은 거부된다', async () => {
    const u = await user();
    const { id } = await webCreate(u);
    const res = await u.post(`/app/d/${id}/close`);
    expect(res.status).toBe(303);
    const { rows } = await s.db.query<{ status: string; ended_at: Date | null }>(`SELECT status, ended_at FROM discussions WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('closed');
    expect(rows[0].ended_at).not.toBeNull();
    const r = await tool(u.claude, 'submit', { discussion_id: id, expected_round: 1, content: '늦은 답변' });
    expect(r.data.error).toBe('ended');
    expect((await u.post(`/app/d/${id}/close`)).status).toBe(409);
  });
});

describe('삭제', () => {
  it('진행 중인 토론과 타인 토론의 삭제는 거부한다', async () => {
    const owner = await user();
    const other = await user();
    const { id } = await webCreate(owner);

    const active = await owner.post(`/app/d/${id}/delete`, { confirm: 'yes' });
    expect(active.status).toBe(409);
    expect(await active.text()).toContain('먼저 종료');

    await owner.post(`/app/d/${id}/close`);
    expect((await other.post(`/app/d/${id}/delete`, { confirm: 'yes' })).status).toBe(404);
    expect((await owner.post(`/app/d/${id}/delete`)).status).toBe(400); // 확인란 없음
    expect(await storedCount(owner.userId)).toBe(1);
  });

  it('한도 초과 시 웹·MCP 모두 삭제 경로를 안내하고, 종료 토론을 삭제하면 생성 한도가 복구된다', async () => {
    const u = await user(true);
    await fillEnded(u.userId, 49);
    const { id } = await webCreate(u, { topic: '50번째' });
    await tool(u.claude, 'submit', { discussion_id: id, expected_round: 1, content: '답변', open_issues: ['이견'] });
    await u.post(`/app/d/${id}/close`);
    expect(await storedCount(u.userId)).toBe(50);

    const blocked = await webCreate(u, { topic: '51번째' });
    expect(blocked.res.status).toBe(409);
    const html = await blocked.res.text();
    expect(html).toContain('종료된 토론을 열어 <b>삭제</b>하면 한도가 다시 생깁니다');
    expect(await (await u.get('/app')).text()).toContain('종료된 토론을 열어 <b>삭제</b>');
    const mcp = await mcpCreate(u);
    expect(mcp.data).toMatchObject({ error: 'limit_exceeded' });
    expect(mcp.data.message).toContain('종료된 토론을 삭제');

    const detail = await (await u.get(`/app/d/${id}`)).text();
    expect(detail).toContain(`action="/app/d/${id}/delete"`);
    expect(detail).toContain('내보내기');
    expect((await u.post(`/app/d/${id}/delete`, { confirm: 'yes' })).status).toBe(303);
    expect(await count(`SELECT count(*)::int AS n FROM turns WHERE discussion_id = $1`, [id])).toBe(0);
    expect(await storedCount(u.userId)).toBe(49);

    const again = await webCreate(u, { topic: '삭제 후 생성' });
    expect(again.res.status).toBe(303);
    expect(await storedCount(u.userId)).toBe(50);
  });
});

describe('한도 검증', () => {
  it('웹·MCP 동시 생성에서도 진행 중 5개를 넘지 않는다', async () => {
    const u = await user();
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => webCreate(u, { topic: `웹 ${i}` }).then((r) => r.res.status === 303)),
      ...Array.from({ length: 4 }, (_, i) => mcpCreate(u, `MCP ${i}`).then((r) => !r.isError)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await activeCount(u.userId)).toBe(5);
  });

  it('웹·MCP 동시 생성에서도 보관 50개를 넘지 않는다', async () => {
    const u = await user();
    await fillEnded(u.userId, 47);
    const results = await Promise.all([
      ...Array.from({ length: 3 }, (_, i) => webCreate(u, { topic: `웹 ${i}` }).then((r) => r.res.status === 303)),
      ...Array.from({ length: 3 }, (_, i) => mcpCreate(u, `MCP ${i}`).then((r) => !r.isError)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await storedCount(u.userId)).toBe(50);
  });

  it('횟수 카운터는 동시 증가에서도 원자적이다', async () => {
    const key = `atomic-test:${Date.now()}`;
    const allowed = await Promise.all(Array.from({ length: 30 }, () => hitRateLimit(s.db, key, 60, 10)));
    expect(allowed.filter(Boolean)).toHaveLength(10);
    expect(await count(`SELECT sum(count)::int AS n FROM rate_limits WHERE key = $1`, [key])).toBe(30);
  });

  it('하루 생성 20개 한도는 웹·MCP를 합쳐 센다', async () => {
    const u = await user();
    // 매번 종료해 진행 중 한도에 걸리지 않게 한다
    for (let i = 0; i < 20; i++) {
      const id = i % 2 ? (await webCreate(u)).id! : (await mcpCreate(u)).data.discussion_id;
      await discussionsFor(s.db, u.userId).close(id);
    }
    const web = await webCreate(u);
    expect(web.res.status).toBe(409);
    expect(await web.res.text()).toContain('하루 20개');
    expect((await mcpCreate(u)).data.error).toBe('limit_exceeded');
    expect(await (await u.get('/app/account')).text()).toContain('<td>오늘 만든 토론</td><td>20 / 20</td>');
  });

  it('용량은 글자 수가 아니라 UTF-8 바이트로 계산한다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u, { topic: '한글', context: 'ab' });
    await tool(u.claude, 'submit', {
      discussion_id: id,
      expected_round: 1,
      content: '가나다',
      proposal: '😀',
      open_issues: ['é', 'x'],
    });
    // topic 6 + context 2 + content 9 + proposal 4 + open_issues 2+1
    expect((await discussionsFor(s.db, u.userId).usage()).bytes).toBe(24);

    // 5MB까지 6바이트 남긴다: 한글 3자(9바이트)는 거부, ASCII 6자는 허용
    await fillEnded(u.userId, 1, 5_000_000 - 24 - 3 - 6);
    expect((await discussionsFor(s.db, u.userId).usage()).bytes).toBe(5_000_000 - 6);
    expect((await webCreate(u, { topic: '가나다' })).res.status).toBe(409);
    expect((await webCreate(u, { topic: 'abcdef' })).res.status).toBe(303);
  });

  it('5MB에 도달하면 새 생성은 막지만 진행 중 토론의 제출은 받는다', async () => {
    const u = await user(true);
    const { id } = await webCreate(u);
    await fillEnded(u.userId, 1, 5_000_000);

    expect((await webCreate(u)).res.status).toBe(409);
    expect((await mcpCreate(u)).data.error).toBe('limit_exceeded');

    const submit = (token: string) =>
      tool(token, 'submit', { discussion_id: id, expected_round: 1, content: '용량을 넘겨도 제출'.repeat(100) });
    expect((await submit(u.claude)).isError).toBe(false);
    expect((await submit(u.codex)).isError).toBe(false);
    expect((await discussionsFor(s.db, u.userId).usage()).bytes).toBeGreaterThan(5_000_000);
  });
});

describe('웹 보안', () => {
  it('마크다운의 스크립트·javascript: 링크·이벤트 속성을 제거한다', async () => {
    const evil = [
      '<script>alert(1)</script>',
      '[클릭](javascript:alert(2))',
      '<a href="JaVaScRiPt:alert(3)">x</a>',
      '<img src=x onerror="alert(4)">',
      '<iframe src="https://evil.example"></iframe>',
      '**굵게** [안전](https://example.com)',
    ].join('\n\n');
    const html = renderMarkdown(evil);
    expect(html).not.toMatch(/<script|javascript:|onerror|<iframe|<img/i);
    expect(html).toContain('<strong>굵게</strong>');
    expect(html).toContain('href="https://example.com"');

    const u = await user();
    const { id } = await webCreate(u);
    await tool(u.claude, 'submit', { discussion_id: id, expected_round: 1, content: evil, proposal: evil });
    const detail = await (await u.get(`/app/d/${id}`)).text();
    expect(detail).not.toMatch(/<script>alert|javascript:alert|onerror=|<iframe/i);
    expect(detail).toContain('<strong>굵게</strong>');
  });

  it('CSRF 토큰이 없거나 틀린 웹 요청은 거부한다', async () => {
    const u = await user();
    const { id } = await webCreate(u);
    const raw = (path: string, fields: Record<string, string>) => u.browser.request(`${s.baseUrl}${path}`, u.browser.form(fields));
    expect((await raw('/app/new', { topic: '위조' })).status).toBe(403);
    expect((await raw(`/app/d/${id}/close`, { csrf: 'wrong' })).status).toBe(403);
    expect((await raw(`/app/d/${id}/delete`, { confirm: 'yes' })).status).toBe(403);
    expect((await raw('/app/account/delete', { confirm: 'yes' })).status).toBe(403);
    expect(await storedCount(u.userId)).toBe(1);
    expect(await activeCount(u.userId)).toBe(1);
  });

  it('보안 헤더(CSP 등)를 붙인다', async () => {
    for (const path of ['/', '/login', '/app']) {
      const res = await new Browser().request(`${s.baseUrl}${path}`);
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('소개 페이지는 로그인 없이 서비스 설명과 로그인 버튼을 보여 준다', async () => {
    const res = await new Browser().request(`${s.baseUrl}/`);
    const html = await res.text();
    expect(html).toContain('사용 방법');
    expect(html).toContain('href="/login"');
  });
});

describe('계정', () => {
  it('사용량을 보여 주고, 탈퇴하면 전체 기록을 내려받은 뒤 계정·연결·기록이 즉시 삭제된다', async () => {
    const u = await user();
    const other = await user();
    const { id } = await webCreate(u, { topic: '탈퇴 전 토론' });
    await webCreate(other, { topic: '남아야 하는 토론' });

    const account = await (await u.get('/app/account')).text();
    expect(account).toContain('<td>진행 중인 토론</td><td>1 / 5</td>');
    expect(account).toContain('<td>보관 토론(종료 포함)</td><td>1 / 50</td>');

    const exported = await u.get('/app/account/export.md');
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    expect(await exported.text()).toContain('# 탈퇴 전 토론');

    expect((await u.post('/app/account/delete')).status).toBe(400); // 확인란 없음
    const res = await u.post('/app/account/delete', { confirm: 'yes' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('탈퇴 완료');

    expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [u.userId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM discussions WHERE id = $1`, [id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM oauth_connections WHERE user_id = $1`, [u.userId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM oidc_models WHERE payload->>'accountId' = $1`, [u.userId])).toBe(0);
    expect((await mcpCreate(u)).status).toBe(401);
    expect((await u.get('/app')).status).toBe(303);
    expect(await storedCount(other.userId)).toBe(1);
  });
});

describe('운영자 화면', () => {
  it('admin만 접근하고 DB 용량·정리 결과를 보며, 계정을 정지·해제한다', async () => {
    const admin = await user();
    const target = await user();
    expect((await admin.get('/admin')).status).toBe(404);
    await s.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.userId]);

    const html = await (await admin.get('/admin')).text();
    expect(html).toContain('DB 용량');
    expect(html).toContain('정리 작업');
    expect(html).toContain(`action="/admin/users/${target.userId}/status"`);
    expect((await target.get('/admin')).status).toBe(404);
    expect((await new Browser().request(`${s.baseUrl}/admin`)).status).toBe(303);

    const forged = await admin.browser.request(
      `${s.baseUrl}/admin/users/${target.userId}/status`,
      admin.browser.form({ status: 'suspended' }),
    );
    expect(forged.status).toBe(403);
    expect((await target.get('/app')).status).toBe(200);

    expect((await admin.post(`/admin/users/${target.userId}/status`, { status: 'suspended' })).status).toBe(303);
    expect((await target.get('/app')).status).toBe(403);
    expect((await mcpCreate(target)).status).toBe(401);

    expect((await admin.post(`/admin/users/${target.userId}/status`, { status: 'active' })).status).toBe(303);
    expect((await target.get('/app')).status).toBe(200);
    expect((await admin.post(`/admin/users/${admin.userId}/status`, { status: 'suspended' })).status).toBe(400);
  });
});

describe('정리 작업', () => {
  it('Cron 비밀값 없이는 실행되지 않는다', async () => {
    expect((await fetch(`${s.baseUrl}/cron/cleanup`)).status).toBe(401);
    expect((await fetch(`${s.baseUrl}/cron/cleanup`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('보존 기간이 지난 토론, 만료된 세션·인가 기록, 오래된 토큰 이력·횟수 제한 기록을 지우고 결과를 남긴다', async () => {
    const u = await user();
    const ago = (days: number) => `now() - interval '${days} days'`;
    const insertDiscussion = (id: string, status: string, endedDaysAgo: number | null) =>
      s.db.query(
        `INSERT INTO discussions (id, owner_id, topic, mode, max_rounds, min_rounds, status, ended_at, created_at)
         VALUES ($1, $2, 't', 'parallel', 5, 2, $3, ${endedDaysAgo === null ? 'NULL' : ago(endedDaysAgo)}, ${ago(400)})`,
        [id, u.userId, status],
      );
    await insertDiscussion('cleanup-expired', 'closed', 181);
    await insertDiscussion('cleanup-recent', 'agreed', 179);
    await insertDiscussion('cleanup-active', 'active', null);
    await s.db.query(`INSERT INTO turns (discussion_id, round, participant, content) VALUES ('cleanup-expired', 1, 'A', 'x')`);

    await s.db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('expired-session', $1, ${ago(1)})`, [u.userId]);
    const model = (model: string, id: string, expiresDaysAgo: number) =>
      s.db.query(`INSERT INTO oidc_models (model, id, payload, expires_at) VALUES ($1, $2, '{}', ${ago(expiresDaysAgo)})`, [model, id]);
    await model('Interaction', 'old-interaction', 1);
    await model('AuthorizationCode', 'old-code', 1);
    await model('RefreshToken', 'old-refresh', 31);
    await model('AccessToken', 'recent-access', 1);
    await s.db.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ('old-key', ${ago(3)}, 1), ('new-key', now(), 1)`);
    await s.db.query(
      `INSERT INTO oauth_connections (grant_id, user_id, client_id, client_name, created_at, expires_at, revoked_at)
       VALUES ('old-grant', $1, 'c', 'Old', ${ago(90)}, ${ago(60)}, ${ago(70)})`,
      [u.userId],
    );

    const res = await fetch(`${s.baseUrl}/cron/cleanup`, { headers: { authorization: `Bearer ${s.config.cronSecret}` } });
    expect(res.status).toBe(200);
    const { deleted } = (await res.json()) as { deleted: Record<string, number> };
    expect(deleted.discussions).toBeGreaterThanOrEqual(1);

    const exists = async (table: string, column: string, value: string) =>
      (await count(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [value])) > 0;
    expect(await exists('discussions', 'id', 'cleanup-expired')).toBe(false);
    expect(await exists('turns', 'discussion_id', 'cleanup-expired')).toBe(false);
    expect(await exists('discussions', 'id', 'cleanup-recent')).toBe(true);
    expect(await exists('discussions', 'id', 'cleanup-active')).toBe(true);
    expect(await exists('sessions', 'id', 'expired-session')).toBe(false);
    expect(await exists('oidc_models', 'id', 'old-interaction')).toBe(false);
    expect(await exists('oidc_models', 'id', 'old-code')).toBe(false);
    expect(await exists('oidc_models', 'id', 'old-refresh')).toBe(false);
    expect(await exists('oidc_models', 'id', 'recent-access')).toBe(true);
    expect(await exists('rate_limits', 'key', 'old-key')).toBe(false);
    expect(await exists('rate_limits', 'key', 'new-key')).toBe(true);
    expect(await exists('oauth_connections', 'grant_id', 'old-grant')).toBe(false);
    // 살아 있는 로그인과 연결은 그대로
    expect((await u.get('/app')).status).toBe(200);
    expect((await mcpCreate(u)).isError).toBe(false);

    await s.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [u.userId]);
    const admin = await (await u.get('/admin')).text();
    expect(admin).toContain('성공');
    expect(admin).toContain(`discussions ${deleted.discussions}`);
  });

  it('보존 기간 30일 전부터 상세 화면에 자동 삭제를 안내한다', async () => {
    const u = await user();
    const { id } = await webCreate(u);
    await s.db.query(`UPDATE discussions SET status = 'closed', ended_at = now() - interval '160 days' WHERE id = $1`, [id]);
    expect(await (await u.get(`/app/d/${id}`)).text()).toContain('자동 삭제됩니다');
    await s.db.query(`UPDATE discussions SET ended_at = now() - interval '100 days' WHERE id = $1`, [id]);
    expect(await (await u.get(`/app/d/${id}`)).text()).not.toContain('자동 삭제됩니다');
  });

  it('vercel.json에 하루 1회 정리 작업 Cron이 설정돼 있다', async () => {
    const { readFile } = await import('node:fs/promises');
    const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(vercel.crons).toEqual([{ path: '/cron/cleanup', schedule: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
  });
});

describe('이전 구조(연결마다 Claude/Codex 역할)에서 옮기기', () => {
  it('마이그레이션을 다시 실행하면 참여자 값이 자리로 바뀌고 앱 이름이 채워지며, 여러 번 실행해도 같다', async () => {
    const { migrate } = await import('../src/db/migrate.js');
    const u = await user();
    const id = 'legacy-discussion';
    await s.db.query(`ALTER TABLE discussions DROP CONSTRAINT discussions_starter_check`);
    await s.db.query(`ALTER TABLE turns DROP CONSTRAINT turns_participant_check`);
    await s.db.query(`ALTER TABLE oauth_connections ADD COLUMN participant text`);
    await s.db.query(
      `INSERT INTO discussions (id, owner_id, topic, mode, max_rounds, starter) VALUES ($1, $2, 't', 'sequential', 10, 'codex')`,
      [id, u.userId],
    );
    await s.db.query(`INSERT INTO turns (discussion_id, round, participant, content) VALUES ($1, 1, 'codex', 'x'), ($1, 2, 'claude', 'y')`, [id]);

    await migrate(s.db);
    await migrate(s.db);

    const d = await s.db.query(`SELECT starter FROM discussions WHERE id = $1`, [id]);
    expect(d.rows[0]).toEqual({ starter: 'B' });
    const t = await s.db.query(`SELECT round, participant, client_name FROM turns WHERE discussion_id = $1 ORDER BY round`, [id]);
    expect(t.rows).toEqual([
      { round: 1, participant: 'B', client_name: 'Codex' },
      { round: 2, participant: 'A', client_name: 'Claude' },
    ]);
    const col = await s.db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'oauth_connections' AND column_name = 'participant'`);
    expect(col.rows).toHaveLength(0);
    await s.db.query(`DELETE FROM discussions WHERE id = $1`, [id]);
  });
});
