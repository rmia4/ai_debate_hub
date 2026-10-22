// 쟁점 원장(합의안 #23) 6항 검증 항목을 하나씩 고정한다
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discussionsFor, type Discussion, type Turn } from '../src/db/discussions.js';
import { getIssueLedger, replayIssues, type IssueEvent } from '../src/db/issues.js';
import { callTool, connect, loginAs, registerClient, startTestServer, type TestServer, type ToolResult } from './helpers.js';

// --- 순수 함수: DB 없이 원장 계산만 본다 ---

const disc = (over: Partial<Discussion> = {}) => ({ mode: 'parallel', status: 'active', current_round: 3, ...over }) as Discussion;
const turn = (id: string, round: number, participant: 'A' | 'B') => ({ id, round, participant }) as Turn;
let eventSeq = 0;
const ev = (turn_id: string, participant: 'A' | 'B', action: IssueEvent['action'], issue_id: string, more: Partial<IssueEvent> = {}): IssueEvent => ({
  id: String(++eventSeq),
  issue_id,
  turn_id,
  participant,
  action,
  text: null,
  note: null,
  proposal_turn_id: null,
  ...more,
});

describe('원장 계산(순수 함수)', () => {
  const turns = [turn('1', 1, 'A'), turn('2', 1, 'B'), turn('3', 2, 'A'), turn('4', 2, 'B'), turn('5', 3, 'A')];

  it('번호는 공개 시 A→B·배열 순서로 매기며, 제출 순서(이벤트 ID)와 무관하다', () => {
    // B가 먼저 제출해 이벤트 ID가 더 작아도 A의 쟁점이 I1이다
    const events = [ev('2', 'B', 'open', 'b1', { text: 'B 쟁점' }), ev('1', 'A', 'open', 'a1', { text: 'A 쟁점 1' }), ev('1', 'A', 'open', 'a2', { text: 'A 쟁점 2' })];
    const r = replayIssues(disc(), turns, events);
    expect(r.issues.map((s) => [s.number, s.title])).toEqual([
      [1, 'A 쟁점 1'],
      [2, 'A 쟁점 2'],
      [3, 'B 쟁점'],
    ]);
  });

  it('같은 쟁점의 같은 변경은 한 번만 적용하고 두 기록과 각자의 note를 남긴다', () => {
    const events = [
      ev('1', 'A', 'open', 'x', { text: '비용' }),
      ev('3', 'A', 'resolve', 'x', { note: 'A 근거', proposal_turn_id: '1' }),
      ev('4', 'B', 'resolve', 'x', { note: 'B 근거', proposal_turn_id: '1' }),
    ];
    const { issues } = getIssueLedger({ discussion: disc(), turns, issueEvents: events }, 'mcp');
    expect(issues[0]).toMatchObject({ ref: 'I1', status: 'resolved', closed: { turn: 2, by: 'A', action: 'resolve', note: 'A 근거' } });
    expect(issues[0].history.slice(1).map((c) => [c.by, c.note, c.conflict, c.after?.status])).toEqual([
      ['A', 'A 근거', false, 'resolved'],
      ['B', 'B 근거', false, 'resolved'],
    ]);
  });

  it('다른 변경은 양쪽 모두 충돌로 두고, 상태는 open·문구는 직전 공개 문구를 유지하며 요청 문구는 보존한다', () => {
    const events = [
      ev('1', 'A', 'open', 'x', { text: '비용' }),
      ev('2', 'B', 'resolve', 'x', { note: '해결됨' }),
      ev('3', 'A', 'reopen', 'x', { note: '다시' }),
      ev('4', 'B', 'revise', 'x', { text: '비용 상한', note: '좁힘' }),
    ];
    const r = replayIssues(disc(), turns, events);
    expect(r.issues[0]).toMatchObject({ title: '비용', status: 'open', closed: null });
    const round2 = r.published.filter((c) => c.turn === 2);
    expect(round2.map((c) => [c.conflict, c.text, c.before, c.after])).toEqual([
      [true, null, { title: '비용', status: 'resolved' }, { title: '비용', status: 'open' }],
      [true, '비용 상한', { title: '비용', status: 'resolved' }, { title: '비용', status: 'open' }],
    ]);
    expect([...r.conflicts].sort()).toEqual(round2.map((c) => c.event_id).sort());
  });

  it('진행 중 라운드 이벤트는 웹에만 pending으로 보이고, 쟁점 상태에는 섞이지 않는다', () => {
    const events = [ev('1', 'A', 'open', 'x', { text: '비용' }), ev('5', 'A', 'resolve', 'x', { note: '끝' }), ev('5', 'A', 'open', 'y', { text: '새 쟁점' })];
    const snapshot = { discussion: disc(), turns, issueEvents: events };
    const web = getIssueLedger(snapshot, 'web');
    expect(web.issues).toHaveLength(1);
    expect(web.issues[0].status).toBe('open');
    expect(web.changesByTurn['5'].map((c) => [c.ref, c.pending, c.before, c.after])).toEqual([
      ['I1', true, { title: '비용', status: 'open' }, null],
      [null, true, null, null],
    ]);
    expect(getIssueLedger(snapshot, 'mcp').changesByTurn['5']).toBeUndefined();
    // 토론이 끝나면 같은 이벤트가 공개된다
    const ended = getIssueLedger({ ...snapshot, discussion: disc({ status: 'closed' }) }, 'mcp');
    expect(ended.issues.map((i) => [i.ref, i.status, i.unresolved_at_end])).toEqual([
      ['I1', 'resolved', false],
      ['I2', 'open', true],
    ]);
  });
});

// --- MCP·웹 통합 ---

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

type Tool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
let userCount = 0;

const toolAs =
  (token: string, seat: 'A' | 'B'): Tool =>
  (name, args) =>
    callTool(s, token, name, name === 'get_state' || name === 'submit' ? { seat, ...args } : args);

async function pair() {
  const { browser, userId } = await loginAs(s, `issue${++userCount}`);
  const claude = await connect(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser });
  const codex = await connect(s, { clientId: codexClient, redirectUri: CODEX_CB, browser });
  const page = async (path: string) => (await browser.request(`${s.baseUrl}${path}`)).text();
  return { userId, page, a: toolAs(claude.access_token, 'A'), b: toolAs(codex.access_token, 'B') };
}

async function start(as: Tool, args: Record<string, unknown> = {}) {
  const r = await as('start_discussion', { topic: '쟁점 토론', ...args });
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data.discussion_id as string;
}

async function ok(as: Tool, id: string, args: Record<string, unknown>) {
  const r = await as('submit', { discussion_id: id, content: '근거', ...args });
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data;
}

async function rejected(as: Tool, id: string, args: Record<string, unknown>, error = 'invalid_issue') {
  const r = await as('submit', { discussion_id: id, content: '근거', ...args });
  expect(r.data.error, JSON.stringify(r.data)).toBe(error);
  return r.data.message as string;
}

const count = async (sql: string, id: string) => (await s.db.query<{ n: number }>(sql, [id])).rows[0].n;
const turnCount = (id: string) => count(`SELECT count(*)::int AS n FROM turns WHERE discussion_id = $1`, id);
const issueCount = (id: string) => count(`SELECT count(*)::int AS n FROM issues WHERE discussion_id = $1`, id);
const eventCount = (id: string) =>
  count(`SELECT count(*)::int AS n FROM issue_events e JOIN issues i ON i.id = e.issue_id WHERE i.discussion_id = $1`, id);

const open = (text: string, more: object = {}) => ({ action: 'open', text, ...more });
const change = (action: string, id: string, note: string, more: object = {}) => ({ action, id, note, ...more });

describe('순차 방식: 이력과 이월', () => {
  it('수정·해결 이력이 남고, 언급하지 않은 쟁점은 이월되며 그 턴에는 변경이 표시되지 않는다', async () => {
    const u = await pair();
    const id = await start(u.a, { mode: 'sequential' });
    const t1 = await ok(u.a, id, { expected_round: 1, proposal: '안 1', issue_updates: [open('비용'), open('운영 부담')] });
    expect(t1.submission.issue_changes.map((c: any) => [c.ref, c.action, c.pending])).toEqual([
      ['I1', 'open', false],
      ['I2', 'open', false],
    ]);
    await ok(u.b, id, { expected_round: 2, issue_updates: [change('revise', 'I1', '범위를 좁힘', { text: '초기 비용' })] });
    const t3 = await ok(u.a, id, { expected_round: 3, proposal: '안 3' });
    expect(t3.submission.issue_changes).toEqual([]);
    const p3 = t3.submission.id;
    await ok(u.b, id, { expected_round: 4, issue_updates: [change('resolve', 'I1', '안 3이 비용을 다룸', { proposal_ref: p3 })] });

    const state = (await u.a('get_state', { discussion_id: id })).data;
    expect(state.issues.map((i: any) => [i.ref, i.status, i.title])).toEqual([
      ['I2', 'open', '운영 부담'],
      ['I1', 'resolved', '초기 비용'],
    ]);
    expect(state.issues[1].last_change).toMatchObject({ turn: 4, by: 'B', action: 'resolve', note: '안 3이 비용을 다룸' });
    expect(state.issues[0].opened).toEqual({ turn: 1, by: 'A' });

    const summary = (await u.a('get_summary', { discussion_id: id })).data;
    const i1 = summary.issues.find((i: any) => i.ref === 'I1');
    expect(i1).toMatchObject({ initial_title: '비용', title: '초기 비용', closed: { turn: 4, by: 'B', action: 'resolve' }, unresolved_at_end: false });
    expect(i1.history.map((c: any) => [c.turn, c.action, c.before?.title ?? null, c.after.title, c.proposal_turn_id])).toEqual([
      [1, 'open', null, '비용', null],
      [2, 'revise', '비용', '초기 비용', null],
      [4, 'resolve', '초기 비용', '초기 비용', p3],
    ]);
    expect(summary.turns[2].issue_changes).toEqual([]);

    // 웹: 개설·문구 전후·해결 근거·반영 제안 링크
    const html = await u.page(`/app/d/${id}`);
    expect(html).toContain('I1 개설: 비용');
    expect(html).toContain('I1 문구 수정: 비용 → 초기 비용 (근거: 범위를 좁힘)');
    expect(html).toContain(`I1 해결 (근거: 안 3이 비용을 다룸) · 반영 제안 <a href="#t${p3}">#${p3}</a>`);
    expect(html).toContain(`id="t${p3}"`);
    expect(html).toContain('열린 쟁점');
    expect(html).toContain('종결된 쟁점');
    const md = await u.page(`/app/d/${id}.md`);
    expect(md).toContain(`- 쟁점 I1 해결 (근거: 안 3이 비용을 다룸) [반영 제안 ${p3}]`);
    expect(md).toContain('## 쟁점');
    expect(md).toContain('- I1 초기 비용 [해결] (턴 1 A석 개설, 턴 4 B석 해결 (근거: 안 3이 비용을 다룸))');
  });

  it('철회·재개: 재개한 쟁점은 다시 열리고 종결 정보가 지워진다', async () => {
    const u = await pair();
    const id = await start(u.a, { mode: 'sequential' });
    await ok(u.a, id, { expected_round: 1, proposal: '안', issue_updates: [open('보안')] });
    await ok(u.b, id, { expected_round: 2 });
    await ok(u.a, id, { expected_round: 3, issue_updates: [change('withdraw', 'I1', '불필요')] });
    let issue = (await u.a('get_summary', { discussion_id: id })).data.issues[0];
    expect(issue).toMatchObject({ status: 'withdrawn', closed: { action: 'withdraw', by: 'A' } });
    await ok(u.b, id, { expected_round: 4, issue_updates: [change('reopen', 'I1', '여전히 문제')] });
    issue = (await u.a('get_summary', { discussion_id: id })).data.issues[0];
    expect(issue).toMatchObject({ status: 'open', closed: null });
    const { rows } = await s.db.query(`SELECT number, title, status, closed_turn_id FROM issues WHERE discussion_id = $1`, [id]);
    expect(rows).toEqual([{ number: 1, title: '보안', status: 'open', closed_turn_id: null }]);
  });
});

describe('전이·권한·소속 검증', () => {
  it('잘못된 변경은 거부하고 아무것도 저장하지 않는다', async () => {
    const u = await pair();
    const other = await start(u.a, { mode: 'sequential', topic: '다른 토론' });
    await ok(u.a, other, { expected_round: 1, proposal: '안', issue_updates: [open('a'), open('b'), open('c')] });

    const id = await start(u.a, { mode: 'sequential' });
    const first = await ok(u.a, id, { expected_round: 1, proposal: '안', issue_updates: [open('비용')] });
    const before = [await turnCount(id), await issueCount(id), await eventCount(id)];
    const bad = [
      [change('withdraw', 'I1', '철회')], // 연 쪽(A)만 철회할 수 있다
      [change('reopen', 'I1', '재개')], // 열린 쟁점은 재개할 수 없다
      [change('resolve', 'I3', '다른 토론의 I3')], // 소속: 다른 토론에만 있는 번호
      [change('resolve', 'I1', '하나'), change('revise', 'I1', '둘', { text: '새 문구' })], // 같은 ID 중복
      [{ action: 'resolve', id: 'I1' }], // note 필수
      [{ action: 'revise', id: 'I1', note: '문구 없음' }], // revise는 text 필수
      [open('id를 붙인 open', { id: 'I1' })],
      [open('note를 붙인 open', { note: '근거' })],
      [change('resolve', 'I1', '근거', { text: '문구' })], // resolve는 text를 받지 않는다
      [change('resolve', 'I1', '근거', { proposal_ref: 'this' })], // 이번 proposal이 없다
      [change('resolve', 'I1', '근거', { proposal_ref: '999999' })], // 공개된 proposal이 아니다
    ];
    for (const updates of bad) await rejected(u.b, id, { expected_round: 2, issue_updates: updates });
    expect([await turnCount(id), await issueCount(id), await eventCount(id)]).toEqual(before);

    // 개설자는 철회할 수 있고, 해결된 쟁점은 revise·resolve할 수 없다
    await ok(u.b, id, { expected_round: 2, issue_updates: [change('resolve', 'I1', '해결', { proposal_ref: first.submission.id })] });
    await rejected(u.a, id, { expected_round: 3, issue_updates: [change('revise', 'I1', '수정', { text: 'x' })] });
    await rejected(u.a, id, { expected_round: 3, issue_updates: [change('withdraw', 'I1', '철회')] });
    await ok(u.a, id, { expected_round: 3, proposal: '새 안', issue_updates: [change('reopen', 'I1', '다시', { proposal_ref: 'this' })] });
  });
});

describe('합의 절차와 sign/agree 결합', () => {
  it('순차: sign=true에는 resolve·withdraw만 허용하고, 열린 쟁점이 있어도 합의되며 경고와 미종결 표시가 남는다', async () => {
    const u = await pair();
    const id = await start(u.a, { mode: 'sequential' });
    await ok(u.a, id, { expected_round: 1, proposal: '안', issue_updates: [open('비용'), open('일정')] });
    for (const updates of [[open('새 쟁점')], [change('revise', 'I1', '수정', { text: 'x' })]]) {
      await rejected(u.b, id, { expected_round: 2, sign: true, issue_updates: updates });
    }
    const b = await ok(u.b, id, { expected_round: 2, sign: true, issue_updates: [change('resolve', 'I1', '안에 반영됨')] });
    expect(b.warnings).toEqual([expect.objectContaining({ code: 'open_issues_remain', issues: ['I2'], basis_turn: 2 })]);
    const a = await ok(u.a, id, { expected_round: 3, sign: true });
    expect(a.status).toBe('agreed');
    expect(a.warnings[0].issues).toEqual(['I2']);

    const summary = (await u.a('get_summary', { discussion_id: id })).data;
    expect(summary.issues.map((i: any) => [i.ref, i.status, i.unresolved_at_end])).toEqual([
      ['I1', 'resolved', false],
      ['I2', 'open', true],
    ]);
    expect(await u.page(`/app/d/${id}`)).toContain('I2 일정 [열림·합의 시 미종결]');
    expect(await u.page(`/app/d/${id}.md`)).toContain('I2 일정 [열림·합의 시 미종결]');
  });

  it('동시: agree에는 resolve·withdraw만 허용하고, 경고는 직전 공개 스냅샷과 내 변경만 기준으로 한다', async () => {
    const u = await pair();
    const id = await start(u.a, { min_rounds: 2, max_rounds: 3 });
    const pa = (await ok(u.a, id, { expected_round: 1, proposal: '안 A', issue_updates: [open('비용')] })).submission.id;
    await ok(u.b, id, { expected_round: 1, issue_updates: [open('운영')] });

    // B가 먼저 대기 중 새 쟁점을 연다. A의 경고에는 섞이지 않는다
    await ok(u.b, id, { expected_round: 2, agreement: 'partial', issue_updates: [open('B의 비공개 쟁점')] });
    await rejected(u.a, id, { expected_round: 2, agreement: 'agree', accepted_proposal_id: pa, issue_updates: [open('x')] });
    await rejected(u.a, id, {
      expected_round: 2,
      agreement: 'agree',
      accepted_proposal_id: pa,
      issue_updates: [change('reopen', 'I1', '재개')],
    });
    const a = await ok(u.a, id, {
      expected_round: 2,
      agreement: 'agree',
      accepted_proposal_id: pa,
      issue_updates: [change('resolve', 'I1', '안 A로 해결', { proposal_ref: pa })],
    });
    expect(a.warnings).toEqual([expect.objectContaining({ issues: ['I2'], basis_round: 1 })]);
    expect(JSON.stringify(a)).not.toContain('B의 비공개 쟁점');
    expect(JSON.stringify(a.warnings)).not.toContain('I3');
  });
});

describe('동시 방식: 누출 방지·순서 독립성·충돌', () => {
  it('대기 중 변경은 상대 MCP 조회·오류에 드러나지 않고, 라운드가 끝나면 A→B 순으로 번호가 붙으며 다른 변경은 충돌로 남는다', async () => {
    const u = await pair();
    const id = await start(u.a, { min_rounds: 2, max_rounds: 3 });
    // 라운드 1: B가 먼저 제출해도 A의 쟁점이 I1이다
    await ok(u.b, id, { expected_round: 1, proposal: '안 B', issue_updates: [open('B 쟁점')] });
    await ok(u.a, id, { expected_round: 1, proposal: '안 A', issue_updates: [open('A 쟁점')] });
    const r1 = (await u.b('get_state', { discussion_id: id })).data;
    expect(r1.issues.map((i: any) => [i.ref, i.title])).toEqual([
      ['I1', 'A 쟁점'],
      ['I2', 'B 쟁점'],
    ]);

    // 라운드 2: A가 I1 해결 + 새 쟁점(대기)
    const a2 = await ok(u.a, id, {
      expected_round: 2,
      agreement: 'partial',
      issue_updates: [change('resolve', 'I1', 'A가 해결'), open('A의 대기 쟁점')],
    });
    expect(a2.submission.issue_changes.map((c: any) => [c.ref, c.action, c.pending, c.after])).toEqual([
      ['I1', 'resolve', true, null],
      [null, 'open', true, null],
    ]);
    const bState = (await u.b('get_state', { discussion_id: id })).data;
    expect(bState.issues.map((i: any) => [i.ref, i.status])).toEqual([
      ['I1', 'open'],
      ['I2', 'open'],
    ]);
    const bSummary = (await u.b('get_summary', { discussion_id: id })).data;
    for (const view of [bState, bSummary]) {
      expect(JSON.stringify(view)).not.toContain('A의 대기 쟁점');
      expect(JSON.stringify(view)).not.toContain('A가 해결');
    }
    // 대기 쟁점이 받을 번호(I3)와 없는 번호(I9)의 오류가 같다
    const m3 = await rejected(u.b, id, { expected_round: 2, issue_updates: [change('resolve', 'I3', '추측')] });
    const m9 = await rejected(u.b, id, { expected_round: 2, issue_updates: [change('resolve', 'I9', '추측')] });
    expect(m3.replace('I3', 'I?')).toBe(m9.replace('I9', 'I?'));

    // 웹 읽기 모델: 대기 변경은 changesByTurn에만, 쟁점 목록·상태에는 섞지 않는다
    const repo = discussionsFor(s.db, u.userId);
    const web = getIssueLedger(await repo.get(id), 'web');
    expect(web.issues.map((i) => i.status)).toEqual(['open', 'open']);
    expect(web.changesByTurn[a2.submission.id].every((c) => c.pending)).toBe(true);
    const html = await u.page(`/app/d/${id}`);
    expect(html).toContain('새 쟁점 개설: A의 대기 쟁점 <span class="badge">변경 대기</span>');

    // B는 같은 I1에 다른 변경(revise) → 양쪽 충돌. B도 새 쟁점을 연다
    await ok(u.b, id, {
      expected_round: 2,
      agreement: 'partial',
      issue_updates: [change('revise', 'I1', 'B의 수정', { text: 'A 쟁점 수정안' }), open('B의 새 쟁점')],
    });
    const summary = (await u.a('get_summary', { discussion_id: id })).data;
    expect(summary.issues.map((i: any) => [i.ref, i.title, i.status])).toEqual([
      ['I1', 'A 쟁점', 'open'],
      ['I2', 'B 쟁점', 'open'],
      ['I3', 'A의 대기 쟁점', 'open'],
      ['I4', 'B의 새 쟁점', 'open'],
    ]);
    const conflicts = summary.issues[0].history.filter((c: any) => c.turn === 2);
    expect(conflicts.map((c: any) => [c.by, c.conflict, c.text, c.after])).toEqual([
      ['A', true, null, { title: 'A 쟁점', status: 'open' }],
      ['B', true, 'A 쟁점 수정안', { title: 'A 쟁점', status: 'open' }],
    ]);
    const { rows } = await s.db.query<{ conflict: boolean }>(
      `SELECT e.conflict FROM issue_events e JOIN issues i ON i.id = e.issue_id WHERE i.discussion_id = $1 AND i.number = 1 ORDER BY e.id`,
      [id],
    );
    expect(rows.map((r) => r.conflict)).toEqual([false, true, true]);
    expect(await u.page(`/app/d/${id}`)).toContain('<span class="badge">충돌·미반영</span>');
  });

  it('합의로 끝나는 라운드의 대기 변경은 종료 트랜잭션에서 확정되고, 같은 해결은 합쳐진다', async () => {
    const u = await pair();
    const id = await start(u.a, { min_rounds: 2, max_rounds: 3 });
    const pa = (await ok(u.a, id, { expected_round: 1, proposal: '안 A', issue_updates: [open('비용')] })).submission.id;
    await ok(u.b, id, { expected_round: 1, issue_updates: [open('운영')] });
    await ok(u.a, id, { expected_round: 2, agreement: 'agree', accepted_proposal_id: pa, issue_updates: [change('resolve', 'I1', 'A 근거')] });
    const end = await ok(u.b, id, {
      expected_round: 2,
      agreement: 'agree',
      accepted_proposal_id: pa,
      issue_updates: [change('resolve', 'I1', 'B 근거'), change('withdraw', 'I2', 'B가 철회')],
    });
    expect(end.status).toBe('agreed');
    expect(end.submission.issue_changes.map((c: any) => [c.ref, c.pending, c.conflict, c.after?.status])).toEqual([
      ['I1', false, false, 'resolved'],
      ['I2', false, false, 'withdrawn'],
    ]);
    const { rows } = await s.db.query(`SELECT number, status FROM issues WHERE discussion_id = $1 ORDER BY number`, [id]);
    expect(rows).toEqual([
      { number: 1, status: 'resolved' },
      { number: 2, status: 'withdrawn' },
    ]);
    // 끝난 라운드의 쟁점 박스는 변경 목록 없이 끝 상태와 종결 결론(종결한 자리·근거)을 보인다
    const html = await u.page(`/app/d/${id}`);
    expect(html).not.toContain('<p>이번 라운드 변경</p>');
    expect(html).toContain('<small>A석 해결: A 근거</small><br><small>B석 해결: B 근거</small>');
    expect(html).toContain('<small>B석 철회: B가 철회</small>');
  });

  it('끝난 라운드의 쟁점 박스는 열린 쟁점의 문구 수정 내용(자리·근거·이전 문구)을 보인다', async () => {
    const u = await pair();
    const id = await start(u.a, { max_rounds: 3 });
    await ok(u.a, id, { expected_round: 1, issue_updates: [open('채식 메뉴를 매일 포함할지')] });
    await ok(u.b, id, { expected_round: 1 });
    await ok(u.a, id, { expected_round: 2, issue_updates: [change('revise', 'I1', '매일은 과함', { text: '채식 메뉴를 주 3회 포함할지' })] });
    await ok(u.b, id, { expected_round: 2 });
    const html = await u.page(`/app/d/${id}`);
    expect(html).toContain('I1 채식 메뉴를 주 3회 포함할지 <span class="badge ok">이번 라운드 변경</span><br><small>A석 문구 수정: 매일은 과함 (이전: 채식 메뉴를 매일 포함할지)</small>');
  });
});

describe('부분 라운드 종료', () => {
  it('수동 종료하면 진행 중 라운드에 있는 제출의 변경만 확정·공개한다', async () => {
    const u = await pair();
    const id = await start(u.a);
    await ok(u.a, id, { expected_round: 1, issue_updates: [open('A만 낸 쟁점')] });
    expect(await count(`SELECT count(*)::int AS n FROM issues WHERE discussion_id = $1 AND number IS NOT NULL`, id)).toBe(0);
    await discussionsFor(s.db, u.userId).close(id);
    const summary = (await u.b('get_summary', { discussion_id: id })).data;
    expect(summary.issues).toEqual([expect.objectContaining({ ref: 'I1', title: 'A만 낸 쟁점', unresolved_at_end: true })]);
    expect(summary.turns[0].issue_changes[0]).toMatchObject({ ref: 'I1', pending: false });
    expect(await u.page(`/app/d/${id}`)).toContain('[열림·종료 시 미종결]');
  });
});

describe('롤백·재시도', () => {
  it('같은 issue_updates로 재시도하면 중복 없이 retry, 다르면 already_submitted', async () => {
    const u = await pair();
    const id = await start(u.a);
    const args = { expected_round: 1, proposal: '안', issue_updates: [open('비용', { proposal_ref: 'this' })] };
    await ok(u.a, id, args);
    expect((await ok(u.a, id, args)).result).toBe('retry');
    await ok(u.b, id, { expected_round: 1 });
    // 라운드가 공개된 뒤에도 같은 내용이면 retry
    expect((await ok(u.a, id, args)).result).toBe('retry');
    expect([await issueCount(id), await eventCount(id)]).toEqual([1, 1]);
    const r = await u.a('submit', { discussion_id: id, content: '근거', ...args, issue_updates: [open('다른 문구')] });
    expect(r.data.error).toBe('already_submitted');
    expect(r.data.submission.issue_changes[0]).toMatchObject({ ref: 'I1', text: '비용' });
  });

  it('이벤트 저장 중 오류가 나면 답변·쟁점·이벤트가 모두 롤백된다', async () => {
    const u = await pair();
    const id = await start(u.a, { mode: 'sequential' });
    await s.db.query(`CREATE OR REPLACE FUNCTION fail_issue_event() RETURNS trigger AS $$
      BEGIN IF NEW.text = '폭발' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await s.db.query(`CREATE TRIGGER fail_issue_event BEFORE INSERT ON issue_events FOR EACH ROW EXECUTE FUNCTION fail_issue_event()`);
    try {
      const r = await u.a('submit', { discussion_id: id, expected_round: 1, content: '근거', issue_updates: [open('정상'), open('폭발')] });
      expect(r.isError).toBe(true);
    } finally {
      await s.db.query(`DROP TRIGGER fail_issue_event ON issue_events`);
    }
    expect([await turnCount(id), await issueCount(id)]).toEqual([0, 0]);
    const { rows } = await s.db.query<{ starter: string | null; current_round: number }>(`SELECT starter, current_round FROM discussions WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ starter: null, current_round: 1 });
    await ok(u.a, id, { expected_round: 1, issue_updates: [open('정상')] });
  });
});

describe('구 입력 호환', () => {
  it('open_issues는 저장·구 형식 이견 표시만 하고 쟁점을 만들지 않으며, issue_updates와 함께 쓰면 거부한다', async () => {
    const u = await pair();
    const id = await start(u.a);
    await rejected(u.a, id, { expected_round: 1, open_issues: ['옛 이견'], issue_updates: [open('새 쟁점')] }, 'invalid_combination');
    const r = await ok(u.a, id, { expected_round: 1, open_issues: ['옛 이견'] });
    expect(r.submission.open_issues).toEqual(['옛 이견']);
    expect(await issueCount(id)).toBe(0);
    const html = await u.page(`/app/d/${id}`);
    expect(html).toContain('구 형식 이견');
    expect(html).toContain('옛 이견');
  });

  it('규칙 안내는 issue_updates 기준이다', async () => {
    const u = await pair();
    const id = await start(u.a);
    const rules = (await u.a('get_state', { discussion_id: id })).data.rules as string;
    expect(rules).toContain('issue_updates');
    expect(rules).toContain('open_issues는 쓰지 않는다');
  });
});

describe('용량', () => {
  it('쟁점은 이벤트의 text·note 바이트로 세고, 캐시 문구는 중복으로 세지 않는다', async () => {
    const u = await pair();
    const id = await start(u.a, { topic: '용량', mode: 'sequential' });
    await ok(u.a, id, { expected_round: 1, content: 'c', issue_updates: [open('é')] });
    // topic 6 + content 1 + text 2
    expect((await discussionsFor(s.db, u.userId).usage()).bytes).toBe(9);
    await ok(u.b, id, { expected_round: 2, content: 'c', issue_updates: [change('revise', 'I1', 'n', { text: 'ab' })] });
    // + content 1 + text 2 + note 1
    expect((await discussionsFor(s.db, u.userId).usage()).bytes).toBe(13);
  });
});
