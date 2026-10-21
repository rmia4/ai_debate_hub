// docs/roadmap.md 3단계(MCP 핵심) 완료 조건 시나리오를 하나씩 고정한다
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, connect, loginAs, registerClient, startTestServer, type TestServer, type ToolResult } from './helpers.js';

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

// 자리(A/B)를 정해 도구를 부른다. get_state·submit에는 seat을 넣는다.
const toolAs =
  (token: string, seat: 'A' | 'B'): Tool =>
  (name, args) =>
    callTool(s, token, name, name === 'get_state' || name === 'submit' ? { seat, ...args } : args);

// 한 사용자의 Claude 연결을 A석, Codex 연결을 B석으로 쓴다. 테스트마다 새 사용자를 써서 생성 한도가 서로 영향을 주지 않게 한다.
async function pair() {
  const { browser, userId } = await loginAs(s, `user${++userCount}`);
  const claude = await connect(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser });
  const codex = await connect(s, { clientId: codexClient, redirectUri: CODEX_CB, browser });
  return { userId, claudeToken: claude.access_token, claude: toolAs(claude.access_token, 'A'), codex: toolAs(codex.access_token, 'B') };
}

async function start(as: Tool, args: Record<string, unknown> = {}) {
  const r = await as('start_discussion', { topic: '캐시 전략', ...args });
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data.discussion_id as string;
}

// 성공을 기대하는 submit
async function ok(as: Tool, id: string, args: Record<string, unknown>) {
  const r = await as('submit', { discussion_id: id, content: '근거를 담은 답변', ...args });
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data;
}

const turnCount = async (id: string) =>
  (await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM turns WHERE discussion_id = $1`, [id])).rows[0].n;

describe('격리', () => {
  it('다른 사용자의 토론 ID로 조회·제출하면 없는 ID와 똑같이 "존재하지 않음"을 받는다', async () => {
    const alice = await pair();
    const bob = await pair();
    const id = await start(alice.claude);
    expect(id.length).toBeGreaterThanOrEqual(12);

    const missing = await bob.claude('get_state', { discussion_id: 'no-such-discussion' });
    for (const [name, args] of [
      ['get_state', {}],
      ['get_summary', {}],
      ['submit', { expected_round: 1, content: '침입' }],
    ] as const) {
      const r = await bob.claude(name, { discussion_id: id, ...args });
      expect(r).toMatchObject({ isError: true, data: { error: 'not_found' } });
      expect(r.data).toEqual(missing.data);
    }
    expect(await turnCount(id)).toBe(0);
  });
});

describe('자리(A/B)', () => {
  it('같은 연결(같은 AI의 두 채팅)이 A석·B석으로 나눠 토론해 합의할 수 있다', async () => {
    const { browser } = await loginAs(s, `user${++userCount}`);
    const token = (await connect(s, { clientId: claudeClient, redirectUri: CLAUDE_CB, browser })).access_token;
    const a = toolAs(token, 'A');
    const b = toolAs(token, 'B');
    const id = await start(a, { mode: 'sequential' });
    const first = await ok(a, id, { expected_round: 1, proposal: '안 A' });
    expect(first.submission).toMatchObject({ participant: 'A', client_name: 'Claude' });
    expect((await a('submit', { discussion_id: id, expected_round: 2, content: '연달아 제출' })).data.error).toBe('not_your_turn');
    await ok(b, id, { expected_round: 2, sign: true });
    const end = await ok(a, id, { expected_round: 3, sign: true });
    expect(end).toMatchObject({ status: 'agreed', agreed_proposal: { proposal: '안 A', participant: 'A' } });
  });

  it('seat이 없거나 A·B가 아니면 도구 입력 오류로 거부된다', async () => {
    const u = await pair();
    const id = await start(u.claude);
    for (const seat of [undefined, 'claude', 'C']) {
      const r = await callTool(s, u.claudeToken, 'get_state', { discussion_id: id, ...(seat ? { seat } : {}) });
      expect(r.isError).toBe(true);
    }
  });
});

describe('지시문 없이 참여', () => {
  it('초기화 응답의 instructions가 참여 방법을 알려 준다', async () => {
    const u = await pair();
    const res = await fetch(s.config.resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${u.claudeToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }),
    });
    const { result } = (await res.json()) as { result: { instructions?: string } };
    expect(result.instructions).toContain('discussion_id 없이 get_state');
    expect(result.instructions).toContain('사용자가 말한 주제와 뜻이 맞는 토론');
  });

  it('discussion_id를 생략하면 진행 중인 토론이 하나일 때만 그 토론을 조회하고, 여럿이면 목록을 돌려준다', async () => {
    const u = await pair();
    expect((await u.claude('get_state', {})).data.error).toBe('not_found');

    const first = await start(u.claude, { topic: '첫 토론' });
    const one = await u.claude('get_state', {});
    expect(one.isError).toBe(false);
    expect(one.data.discussion_id).toBe(first);

    const second = await start(u.claude, { topic: '둘째 토론' });
    const many = await u.codex('get_state', {});
    expect(many).toMatchObject({ isError: true, data: { error: 'choose_discussion' } });
    expect(many.data.discussions.map((d: { discussion_id: string; topic: string }) => [d.discussion_id, d.topic]).sort()).toEqual(
      [[first, '첫 토론'], [second, '둘째 토론']].sort(),
    );

    await u.claude('submit', { discussion_id: second, expected_round: 1, content: '근거' });
    await s.db.query(`UPDATE discussions SET status = 'closed' WHERE id = $1`, [second]);
    expect((await u.codex('get_state', {})).data.discussion_id).toBe(first);
  });

  it('get_state는 내 제출이 없는 동안에만 방식에 맞는 rules를 보낸다', async () => {
    const u = await pair();
    const id = await start(u.claude);
    const before = (await u.claude('get_state', { discussion_id: id })).data;
    expect(before.rules).toContain('쉽게 동의하지 않는다');
    expect(before.rules).toContain('다음 라운드 진행');
    await ok(u.claude, id, { expected_round: 1 });
    expect((await u.claude('get_state', { discussion_id: id })).data.rules).toBeUndefined();
    expect((await u.codex('get_state', { discussion_id: id })).data.rules).toBeDefined();

    const seq = await start(u.claude, { mode: 'sequential' });
    expect((await u.codex('get_state', { discussion_id: seq })).data.rules).toContain('sign=true');
  });
});

describe('공통', () => {
  it('응답 유실 후 같은 번호로 재제출하면 라운드가 넘어간 뒤에도 저장된 결과를 반환한다', async () => {
    const u = await pair();
    const id = await start(u.claude);
    const first = await ok(u.claude, id, { expected_round: 1, proposal: '안 A' });
    await ok(u.codex, id, { expected_round: 1 });

    // 라운드 2로 넘어갔지만 라운드 불일치로 거부되지 않는다
    const retry = await ok(u.claude, id, { expected_round: 1, proposal: '안 A' });
    expect(retry).toMatchObject({ result: 'retry', submission: first.submission, current_round: 2 });
    expect(await turnCount(id)).toBe(2);
  });

  it('같은 번호로 다른 내용을 보내면 "이미 제출됨"과 저장된 제출을 반환하고 수정하지 않는다', async () => {
    const u = await pair();
    const id = await start(u.claude, { mode: 'sequential' });
    const first = await ok(u.claude, id, { expected_round: 1, content: '원래 답변', proposal: '안 A' });
    const r = await u.claude('submit', { discussion_id: id, expected_round: 1, content: '바꾼 답변', proposal: '안 A' });
    expect(r).toMatchObject({ isError: true, data: { error: 'already_submitted', message: '이미 제출됨, 수정되지 않음' } });
    expect(r.data.submission).toEqual(first.submission);
    const { rows } = await s.db.query<{ content: string }>(`SELECT content FROM turns WHERE discussion_id = $1`, [id]);
    expect(rows).toEqual([{ content: '원래 답변' }]);
  });

  it('agree와 새 proposal, 사인과 새 proposal은 함께 낼 수 없다', async () => {
    const u = await pair();
    const par = await start(u.claude);
    const p = await ok(u.claude, par, { expected_round: 1, proposal: '안 A' });
    await ok(u.codex, par, { expected_round: 1 });
    const agreeWithProposal = await u.codex('submit', {
      discussion_id: par,
      expected_round: 2,
      content: '동의',
      agreement: 'agree',
      accepted_proposal_id: p.submission.id,
      proposal: '안 B',
    });
    expect(agreeWithProposal).toMatchObject({ isError: true, data: { error: 'invalid_combination' } });

    const seq = await start(u.claude, { mode: 'sequential' });
    await ok(u.claude, seq, { expected_round: 1, proposal: '안 A' });
    const signWithProposal = await u.codex('submit', { discussion_id: seq, expected_round: 2, content: '사인', sign: true, proposal: '안 B' });
    expect(signWithProposal).toMatchObject({ isError: true, data: { error: 'invalid_combination' } });
    expect(await turnCount(par)).toBe(2);
    expect(await turnCount(seq)).toBe(1);
  });

  it('마지막 라운드·턴의 합의는 max_reached가 아니라 agreed로 끝난다', async () => {
    const u = await pair();
    const par = await start(u.claude, { max_rounds: 2, min_rounds: 2 });
    const p = await ok(u.claude, par, { expected_round: 1, proposal: '안 A' });
    await ok(u.codex, par, { expected_round: 1 });
    const agree = { expected_round: 2, agreement: 'agree', accepted_proposal_id: p.submission.id };
    await ok(u.claude, par, agree);
    const last = await ok(u.codex, par, agree);
    expect(last).toMatchObject({ status: 'agreed', current_round: 2, agreed_proposal: { proposal_id: p.submission.id }, next: null });

    const seq = await start(u.claude, { mode: 'sequential', max_rounds: 4 });
    await ok(u.claude, seq, { expected_round: 1 });
    const q = await ok(u.codex, seq, { expected_round: 2, proposal: '안 B' });
    await ok(u.claude, seq, { expected_round: 3, sign: true });
    const end = await ok(u.codex, seq, { expected_round: 4, sign: true });
    expect(end).toMatchObject({ status: 'agreed', current_turn: 4, agreed_proposal: { proposal_id: q.submission.id } });
  });
});

describe('동시 방식', () => {
  it('서로 다른 안에 교차 동의하면 합의가 아니다', async () => {
    const u = await pair();
    const id = await start(u.claude);
    const a = await ok(u.claude, id, { expected_round: 1, proposal: '안 A' });
    const b = await ok(u.codex, id, { expected_round: 1, proposal: '안 B' });
    await ok(u.claude, id, { expected_round: 2, agreement: 'agree', accepted_proposal_id: b.submission.id });
    const r = await ok(u.codex, id, { expected_round: 2, agreement: 'agree', accepted_proposal_id: a.submission.id });
    expect(r).toMatchObject({ status: 'active', current_round: 3, agreed_proposal: null });
  });

  it('양쪽이 동시에 제출해도 매 라운드가 마감되고, 최소 라운드 전 합의는 미뤄진다', async () => {
    const u = await pair();
    const id = await start(u.claude, { max_rounds: 4, min_rounds: 3 });
    const [a] = await Promise.all([
      ok(u.claude, id, { expected_round: 1, proposal: '안 A' }),
      ok(u.codex, id, { expected_round: 1 }),
    ]);
    const agree = (round: number) => ({ expected_round: round, agreement: 'agree', accepted_proposal_id: a.submission.id });
    // 라운드 2: 양쪽 동의지만 min_rounds(3) 미만이라 계속
    await Promise.all([ok(u.claude, id, agree(2)), ok(u.codex, id, agree(2))]);
    let state = (await u.claude('get_state', { discussion_id: id })).data;
    expect(state).toMatchObject({ status: 'active', current_round: 3, my_turn: true, submitted: false });
    expect(state.previous_round.map((t: { participant: string }) => t.participant).sort()).toEqual(['A', 'B']);

    await Promise.all([ok(u.claude, id, agree(3)), ok(u.codex, id, agree(3))]);
    state = (await u.codex('get_state', { discussion_id: id })).data;
    expect(state).toMatchObject({ status: 'agreed', current_round: 3, agreed_proposal: { proposal_id: a.submission.id } });
    expect(await turnCount(id)).toBe(6);
  });

  it('get_state·get_summary는 진행 중인 라운드의 답변과 새 합의안을 숨긴다', async () => {
    const u = await pair();
    const id = await start(u.claude);
    await ok(u.claude, id, { expected_round: 1, content: '라운드1 claude', proposal: '안 A' });
    await ok(u.codex, id, { expected_round: 1, content: '라운드1 codex' });
    await ok(u.claude, id, { expected_round: 2, content: '라운드2 비밀', proposal: '안 C' });

    const summary = (await u.codex('get_summary', { discussion_id: id })).data;
    expect(summary.turns.map((t: { content: string }) => t.content).sort()).toEqual(['라운드1 claude', '라운드1 codex']);
    expect(JSON.stringify(summary)).not.toContain('비밀');
    const state = (await u.codex('get_state', { discussion_id: id })).data;
    expect(JSON.stringify(state)).not.toContain('비밀');
    expect(JSON.stringify(state)).not.toContain('안 C');

    await ok(u.codex, id, { expected_round: 2, content: '라운드2 codex' });
    const after = (await u.codex('get_summary', { discussion_id: id })).data;
    expect(after.turns).toHaveLength(4);
  });

  it('최대 라운드까지 합의하지 못하면 max_reached로 끝나고 이후 제출은 거부된다', async () => {
    const u = await pair();
    const id = await start(u.claude, { max_rounds: 2 });
    for (const round of [1, 2]) await Promise.all([ok(u.claude, id, { expected_round: round }), ok(u.codex, id, { expected_round: round })]);
    const state = (await u.claude('get_state', { discussion_id: id })).data;
    expect(state).toMatchObject({ status: 'max_reached', current_round: 2, my_turn: false });
    const late = await u.claude('submit', { discussion_id: id, expected_round: 3, content: '늦은 답변' });
    expect(late).toMatchObject({ isError: true, data: { error: 'ended' } });
  });
});

describe('순차 방식', () => {
  it('아무도 시작하지 않았으면 선공 안내를 하고, 먼저 제출한 쪽이 선공이 된다', async () => {
    const u = await pair();
    const id = await start(u.claude, { mode: 'sequential' });
    const before = (await u.claude('get_state', { discussion_id: id })).data;
    expect(before).toMatchObject({ starter: null, my_turn: true, current_turn: 1 });
    expect(before.guide).toContain('선공');

    const r = await ok(u.codex, id, { expected_round: 1, proposal: '안 B' });
    expect(r).toMatchObject({ current_turn: 2, next: { participant: 'A', turn: 2 } });
    const state = (await u.claude('get_state', { discussion_id: id })).data;
    expect(state).toMatchObject({ starter: 'B', my_turn: true, opponent_last_turn: { content: '근거를 담은 답변' } });
    expect(state.current_proposal).toMatchObject({ proposal: '안 B', participant: 'B' });
  });

  it('양쪽이 동시에 첫 제출하면 한쪽만 선공이 되고 다른 쪽은 "상대가 먼저 시작함"으로 거부된다', async () => {
    const u = await pair();
    for (let i = 0; i < 3; i++) {
      const id = await start(u.claude, { mode: 'sequential' });
      const results = await Promise.all(
        [u.claude, u.codex].map((as) => as('submit', { discussion_id: id, expected_round: 1, content: '첫 의견' })),
      );
      const accepted = results.filter((r) => !r.isError);
      const rejected = results.filter((r) => r.isError);
      expect(accepted).toHaveLength(1);
      expect(rejected[0].data.error).toBe('opponent_started');
      const state = (await u.claude('get_state', { discussion_id: id })).data;
      expect(state.starter).toBe(accepted[0].data.submission.participant);
      expect(await turnCount(id)).toBe(1);
    }
  });

  it('차례가 아닌 쪽의 제출은 "상대 차례"로 거부된다', async () => {
    const u = await pair();
    const id = await start(u.claude, { mode: 'sequential' });
    await ok(u.claude, id, { expected_round: 1 });
    const r = await u.claude('submit', { discussion_id: id, expected_round: 2, content: '연속 제출' });
    expect(r).toMatchObject({ isError: true, data: { error: 'not_your_turn', message: '상대 차례입니다' } });
    expect(await turnCount(id)).toBe(1);
  });

  it('수정안 → 상대 사인 → 제안자 사인으로 합의 종료된다', async () => {
    const u = await pair();
    const id = await start(u.claude, { mode: 'sequential' });
    const p = await ok(u.claude, id, { expected_round: 1, proposal: '안 A' });
    const signed = await ok(u.codex, id, { expected_round: 2, sign: true });
    expect(signed).toMatchObject({ status: 'active', current_turn: 3 });
    const state = (await u.claude('get_state', { discussion_id: id })).data;
    expect(state.signs).toEqual([{ turn: 2, participant: 'B' }]);

    const end = await ok(u.claude, id, { expected_round: 3, sign: true });
    expect(end).toMatchObject({ status: 'agreed', current_turn: 3, agreed_proposal: { proposal_id: p.submission.id, proposal: '안 A' } });
    const summary = (await u.codex('get_summary', { discussion_id: id })).data;
    expect(summary).toMatchObject({ status: 'agreed', conclusion: '합의 완료' });
    expect(summary.turns).toHaveLength(3);
  });

  it('상대 사인 뒤 재수정안이 나오면 사인이 초기화되어 다시 두 번 연속 사인해야 끝난다', async () => {
    const u = await pair();
    const id = await start(u.claude, { mode: 'sequential' });
    await ok(u.claude, id, { expected_round: 1, proposal: '안 A' });
    await ok(u.codex, id, { expected_round: 2, sign: true });
    const revised = await ok(u.claude, id, { expected_round: 3, proposal: '안 A2' });
    expect(revised).toMatchObject({ status: 'active' });
    let state = (await u.codex('get_state', { discussion_id: id })).data;
    expect(state).toMatchObject({ signs: [], current_proposal: { proposal: '안 A2' } });

    const once = await ok(u.codex, id, { expected_round: 4, sign: true });
    expect(once.status).toBe('active');
    const end = await ok(u.claude, id, { expected_round: 5, sign: true });
    expect(end).toMatchObject({ status: 'agreed', agreed_proposal: { proposal_id: revised.submission.id } });
  });

  it('합의안이 없을 때의 사인과 동시 방식 전용 필드는 거부된다', async () => {
    const u = await pair();
    const id = await start(u.claude, { mode: 'sequential' });
    const sign = await u.claude('submit', { discussion_id: id, expected_round: 1, content: '사인', sign: true });
    expect(sign).toMatchObject({ isError: true, data: { error: 'invalid_combination' } });
    const agreement = await u.claude('submit', { discussion_id: id, expected_round: 1, content: '동의', agreement: 'partial' });
    expect(agreement).toMatchObject({ isError: true, data: { error: 'invalid_combination' } });
  });
});

describe('입력 제한과 생성 한도', () => {
  it('길이 제한을 넘는 입력과 범위를 벗어난 설정은 거부된다', async () => {
    const u = await pair();
    expect((await u.claude('start_discussion', { topic: 'x'.repeat(201) })).isError).toBe(true);
    expect((await u.claude('start_discussion', { topic: 't', max_rounds: 11 })).data.error).toBe('invalid_settings');
    expect((await u.claude('start_discussion', { topic: 't', mode: 'sequential', max_rounds: 3 })).data.error).toBe('invalid_settings');
    const id = await start(u.claude);
    for (const args of [
      { content: 'x'.repeat(8001) },
      { content: 'ok', proposal: 'x'.repeat(4001) },
      { content: 'ok', open_issues: Array(11).fill('이견') },
      { content: 'ok', open_issues: ['x'.repeat(201)] },
    ]) {
      expect((await u.claude('submit', { discussion_id: id, expected_round: 1, ...args })).isError).toBe(true);
    }
    expect(await turnCount(id)).toBe(0);
  });

  it('도구 설명에 "쉽게 동의하지 말고 근거를 제시할 것", 지시문에 "쉽게 동의하지 않는다"가 들어 있다', async () => {
    const u = await pair();
    const id = await start(u.claude);
    const r = await u.claude('start_discussion', { topic: '지시문 확인' });
    expect(r.data.instructions.A).toContain('쉽게 동의하지 않는다');
    expect(r.data.instructions.B).toContain(r.data.discussion_id);
    const state = (await u.claude('get_state', { discussion_id: id })).data;
    expect(state.guide).toContain('독립 답변');

    const list = await fetch(s.config.resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${u.claudeToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const { result } = (await list.json()) as { result: { tools: { name: string; description: string }[] } };
    for (const name of ['get_state', 'submit']) {
      expect(result.tools.find((t) => t.name === name)!.description).toContain('쉽게 동의하지 말고 근거를 제시할 것');
    }
  });

  it('진행 중인 토론은 5개까지 만들 수 있고, 동시에 만들어도 넘지 않는다', async () => {
    const u = await pair();
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => u.claude('start_discussion', { topic: `주제 ${i}` })));
    expect(results.filter((r) => !r.isError)).toHaveLength(5);
    expect(results.filter((r) => r.isError).every((r) => r.data.error === 'limit_exceeded')).toBe(true);
    const { rows } = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM discussions WHERE owner_id = $1`, [u.userId]);
    expect(rows[0].n).toBe(5);
  });
});
