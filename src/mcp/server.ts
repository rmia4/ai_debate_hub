import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { currentProposal, DiscussionError, discussionsFor, PARTICIPANTS, type Discussion, type Participant, type Turn } from '../db/discussions.js';
import { instructionFor, rulesFor, SERVER_INSTRUCTIONS } from '../instructions.js';
import type { Caller } from './caller.js';

const RULE = '쉽게 동의하지 말고 근거를 제시할 것.';

const discussionId = z.string().max(64).describe('토론 ID');
const seat = z.enum(['A', 'B']).describe('사용자가 정해 준 내 자리(A 또는 B). 토론 내내 같은 값을 쓴다');

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (error: string, message: string, extra: object = {}): CallToolResult => ({
  ...json({ error, message, ...extra }),
  isError: true,
});

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DiscussionError) return fail(e.code, e.message);
    throw e;
  }
}

const opponentOf = (me: Participant): Participant => (me === 'A' ? 'B' : 'A');

// MCP 조회 경로의 공개 규칙: 진행 중이면 완료된 라운드만 보인다. 순차 방식은 제출마다 턴이 넘어가므로 모두 보인다.
const visibleTurns = (d: Discussion, turns: Turn[]) => (d.status === 'active' ? turns.filter((t) => t.round < d.current_round) : turns);

function formatTurn(d: Discussion, t: Turn) {
  return {
    id: t.id,
    [d.mode === 'parallel' ? 'round' : 'turn']: t.round,
    participant: t.participant,
    client_name: t.client_name,
    content: t.content,
    proposal: t.proposal,
    ...(d.mode === 'parallel' ? { agreement: t.agreement, accepted_proposal_id: t.accepted_proposal_id } : { sign: t.sign }),
    open_issues: t.open_issues,
  };
}

const proposalOf = (t: Turn) => ({ proposal_id: t.id, round: t.round, participant: t.participant, proposal: t.proposal });

function agreedProposal(d: Discussion, turns: Turn[]) {
  const t = turns.find((x) => x.id === d.agreed_proposal_id);
  return t ? proposalOf(t) : null;
}

function isMyTurn(d: Discussion, turns: Turn[], me: Participant) {
  if (d.status !== 'active') return false;
  if (d.mode === 'parallel') return !turns.some((t) => t.round === d.current_round && t.participant === me);
  return turns.at(-1)?.participant !== me;
}

// 순차 방식: 현재 합의안 이후 연속된 사인
function signsSince(turns: Turn[]) {
  const signs: { turn: number; participant: Participant }[] = [];
  for (let i = turns.length - 1; i >= 0 && turns[i].sign; i--) signs.unshift({ turn: turns[i].round, participant: turns[i].participant });
  return signs;
}

function guide(d: Discussion, turns: Turn[], me: Participant) {
  if (d.status !== 'active') return `토론이 종료되었습니다(${d.status}). 사용자에게 종료를 알리세요.`;
  const mine = isMyTurn(d, turns, me);
  if (d.mode === 'parallel') {
    if (!mine) return '이번 라운드 제출을 마쳤습니다. 상대 제출을 기다리세요.';
    if (d.current_round === 1) return '라운드 1입니다. 상대 답변 없이 독립 답변을 submit하세요.';
    return `직전 라운드 답변과 합의 후보를 검토해 라운드 ${d.current_round} 답변을 submit하세요. ${RULE}`;
  }
  if (turns.length === 0) return '아직 아무도 시작하지 않았습니다. 먼저 submit하면 선공이 됩니다.';
  return mine ? `당신 차례입니다(턴 ${d.current_round}). ${RULE}` : '상대 차례입니다. 사용자가 상대에게 진행을 지시할 때까지 기다리세요.';
}

function stateView(d: Discussion, turns: Turn[], me: Participant) {
  const visible = visibleTurns(d, turns);
  const base = {
    discussion_id: d.id,
    topic: d.topic,
    context: d.context,
    mode: d.mode,
    status: d.status,
    me,
    max_rounds: d.max_rounds,
    my_turn: isMyTurn(d, turns, me),
    agreed_proposal: agreedProposal(d, turns),
    guide: guide(d, turns, me),
    // 지시문을 붙여 넣지 않고 참여한 AI도 규칙을 받도록, 내 제출이 없는 동안 함께 보낸다
    ...(d.status === 'active' && !turns.some((t) => t.participant === me) ? { rules: rulesFor(d.mode) } : {}),
  };
  if (d.mode === 'parallel') {
    const lastRound = Math.max(0, ...visible.map((t) => t.round));
    return {
      ...base,
      current_round: d.current_round,
      min_rounds: d.min_rounds,
      submitted: turns.some((t) => t.round === d.current_round && t.participant === me),
      previous_round: visible.filter((t) => t.round === lastRound).map((t) => formatTurn(d, t)),
      proposals: visible.filter((t) => t.proposal !== null).map(proposalOf),
    };
  }
  const opponentLast = visible.findLast((t) => t.participant === opponentOf(me));
  const proposal = currentProposal(visible);
  return {
    ...base,
    current_turn: d.current_round,
    starter: d.starter,
    opponent_last_turn: opponentLast ? formatTurn(d, opponentLast) : null,
    current_proposal: proposal ? proposalOf(proposal) : null,
    signs: signsSince(visible),
  };
}

function nextStep(d: Discussion, turns: Turn[], me: Participant) {
  if (d.status !== 'active') return null;
  if (d.mode === 'sequential') return { participant: opponentOf(me), turn: d.current_round };
  if (isMyTurn(d, turns, me)) return { round: d.current_round, participant: 'both' };
  return { round: d.current_round, participant: opponentOf(me) };
}

function buildServer(caller: Caller, db: Db): McpServer {
  const server = new McpServer({ name: 'ai-debate-hub', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  const repo = discussionsFor(db, caller.userId);

  // discussion_id를 생략하면 진행 중인 토론이 하나일 때만 그것을 쓴다. 여럿이면 엉뚱한 방에 제출하지 않도록 고르게 한다.
  async function resolveId(id: string | undefined): Promise<string | CallToolResult> {
    if (id) return id;
    const active = (await repo.list()).filter((d) => d.status === 'active');
    if (active.length === 0) return fail('not_found', '진행 중인 토론이 없습니다. 웹에서 토론방을 만들거나 토론 ID를 알려 달라고 사용자에게 요청하세요');
    if (active.length > 1) {
      return fail('choose_discussion', '진행 중인 토론이 여럿입니다. 사용자가 말한 주제와 맞는 토론이 하나뿐이면 그 discussion_id로 다시 호출하고, 아니면 목록을 보여 주고 사용자에게 고르게 하세요', {
        discussions: active.map((d) => ({ discussion_id: d.id, topic: d.topic, mode: d.mode, created_at: d.created_at })),
      });
    }
    return active[0].id;
  }

  server.registerTool(
    'start_discussion',
    {
      description: '새 토론방을 만들고 참여자별 지시문을 반환한다. 웹에서 만드는 것이 기본이며 채팅에서 만들 때만 쓴다.',
      inputSchema: {
        topic: z.string().min(1).max(200).describe('토론 주제'),
        context: z.string().max(2000).optional().describe('배경 설명·제약 조건'),
        mode: z.enum(['parallel', 'sequential']).optional().describe('parallel(동시, 기본) 또는 sequential(순차)'),
        max_rounds: z.number().int().optional().describe('최대 라운드(동시 기본 5, 2~10) 또는 최대 턴(순차 기본 10, 4~20)'),
        min_rounds: z.number().int().optional().describe('최소 라운드(동시 방식만, 기본 2)'),
      },
    },
    (input) =>
      run(async () => {
        const d = await repo.create(input);
        return json({
          discussion_id: d.id,
          mode: d.mode,
          max_rounds: d.max_rounds,
          min_rounds: d.min_rounds,
          instructions: Object.fromEntries(PARTICIPANTS.map((p) => [p, instructionFor(d, p)])),
        });
      }),
  );

  server.registerTool(
    'get_state',
    {
      description:
        `토론의 현재 상태, 내 차례 여부, 직전 답변과 합의 후보를 조회한다. 진행 중인 라운드의 상대 답변은 보이지 않는다. ` +
        `처음 참여할 때는 rules에 이 토론의 규칙이 온다. ${RULE}`,
      inputSchema: { discussion_id: discussionId.optional().describe('토론 ID. 생략하면 진행 중인 토론이 하나일 때 그 토론을 조회한다'), seat },
    },
    ({ discussion_id, seat: me }) =>
      run(async () => {
        const id = await resolveId(discussion_id);
        if (typeof id !== 'string') return id;
        const { discussion, turns } = await repo.get(id);
        return json(stateView(discussion, turns, me));
      }),
  );

  server.registerTool(
    'submit',
    {
      description:
        `이번 라운드(순차 방식은 턴)의 답변을 제출한다. ${RULE} ` +
        '동시 방식: agreement=agree이면 accepted_proposal_id 필수, 새 proposal 금지, open_issues 빈 배열. ' +
        '순차 방식: sign=true는 현재 합의안을 수정 없이 받아들인다는 뜻이며 새 proposal 금지, open_issues 빈 배열. ' +
        '응답을 받지 못했으면 같은 expected_round와 같은 내용으로 다시 보내면 된다.',
      inputSchema: {
        discussion_id: discussionId,
        seat,
        expected_round: z.number().int().min(1).max(20).describe('get_state의 current_round(순차 방식은 current_turn)'),
        content: z.string().min(1).max(8000).describe('답변 본문: 검토·반박·근거'),
        proposal: z.string().min(1).max(4000).optional().describe('이 답변이 제시하는 최종안 본문'),
        open_issues: z.array(z.string().min(1).max(200)).max(10).default([]).describe('남은 이견(짧은 문장 배열)'),
        agreement: z.enum(['agree', 'partial', 'disagree']).optional().describe('동시 방식만: 동의 상태'),
        accepted_proposal_id: z.string().regex(/^\d{1,18}$/).optional().describe('동시 방식 agree일 때: 동의하는 합의안 ID'),
        sign: z.boolean().optional().describe('순차 방식만: 현재 합의안을 수정 없이 받아들이면 true'),
      },
    },
    ({ discussion_id, seat: me, ...input }) =>
      run(async () => {
        const r = await repo.submit(discussion_id, me, caller.clientName, input);
        if (r.outcome === 'conflict') {
          return fail('already_submitted', '이미 제출됨, 수정되지 않음', { submission: formatTurn(r.discussion, r.turn) });
        }
        const d = r.discussion;
        return json({
          result: r.outcome,
          submission: formatTurn(d, r.turn),
          status: d.status,
          [d.mode === 'parallel' ? 'current_round' : 'current_turn']: d.current_round,
          next: nextStep(d, r.turns, me),
          agreed_proposal: agreedProposal(d, r.turns),
        });
      }),
  );

  server.registerTool(
    'get_summary',
    {
      description: '토론 기록을 조회한다. 진행 중에는 완료된 라운드·턴만, 종료 후에는 전체 기록과 결론을 반환한다.',
      inputSchema: { discussion_id: discussionId },
    },
    ({ discussion_id }) =>
      run(async () => {
        const { discussion: d, turns } = await repo.get(discussion_id);
        const agreed = agreedProposal(d, turns);
        const conclusion =
          d.status === 'agreed' ? '합의 완료' : d.status === 'max_reached' ? '최대 도달·합의 미확정' : d.status === 'closed' ? '수동 종료' : '진행 중';
        return json({
          discussion_id: d.id,
          topic: d.topic,
          context: d.context,
          mode: d.mode,
          status: d.status,
          [d.mode === 'parallel' ? 'current_round' : 'current_turn']: d.current_round,
          turns: visibleTurns(d, turns).map((t) => formatTurn(d, t)),
          conclusion,
          agreed_proposal: agreed,
        });
      }),
  );
  return server;
}

// 무상태 Streamable HTTP: 요청마다 서버·전송 객체를 새로 만든다.
export async function handleMcp(req: Request, res: Response, caller: Caller, db: Db): Promise<void> {
  const server = buildServer(caller, db);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
