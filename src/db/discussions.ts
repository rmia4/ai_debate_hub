import { randomBytes } from 'node:crypto';
import type { Participant } from '../oauth/connections.js';
import type { Db, Queryable } from './db.js';
import { hitRateLimit } from './rate-limit.js';

export type Mode = 'parallel' | 'sequential';
export type Status = 'active' | 'agreed' | 'max_reached' | 'closed';
export type Agreement = 'agree' | 'partial' | 'disagree';

export interface Discussion {
  id: string;
  owner_id: string;
  topic: string;
  context: string;
  mode: Mode;
  starter: Participant | null;
  status: Status;
  current_round: number;
  max_rounds: number;
  min_rounds: number | null;
  agreed_proposal_id: string | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Turn {
  id: string;
  round: number;
  participant: Participant;
  content: string;
  proposal: string | null;
  agreement: Agreement | null;
  accepted_proposal_id: string | null;
  sign: boolean | null;
  open_issues: string[];
  created_at: Date;
}

export interface CreateInput {
  topic: string;
  context?: string;
  mode?: Mode;
  max_rounds?: number;
  min_rounds?: number;
}

export interface SubmitInput {
  expected_round: number;
  content: string;
  proposal?: string;
  open_issues: string[];
  agreement?: Agreement;
  accepted_proposal_id?: string;
  sign?: boolean;
}

export const CREATE_LIMITS = { active: 5, stored: 50, bytes: 5_000_000, perDay: 20 };
export const INPUT_LIMITS = { topic: 200, context: 2000 };
export const RETENTION_DAYS = 180;

export interface Usage {
  active: number;
  stored: number;
  bytes: number;
  createdToday: number;
}

const createKey = (userId: string) => `discussion-create:${userId}`;
const DAY_SECONDS = 24 * 60 * 60;

// 텍스트 용량: topic·context와 모든 답변의 content·proposal·open_issues 문자열의 UTF-8 바이트 합
async function usageOf(q: Queryable, userId: string): Promise<Usage> {
  const { rows } = await q.query<Usage>(
    `SELECT
       (SELECT count(*) FROM discussions WHERE owner_id = $1 AND status = 'active')::int AS active,
       (SELECT count(*) FROM discussions WHERE owner_id = $1)::int AS stored,
       ((SELECT coalesce(sum(octet_length(topic) + octet_length(context)), 0) FROM discussions WHERE owner_id = $1)
        + (SELECT coalesce(sum(octet_length(t.content) + coalesce(octet_length(t.proposal), 0)
             + (SELECT coalesce(sum(octet_length(x)), 0) FROM jsonb_array_elements_text(t.open_issues) x)), 0)
           FROM turns t JOIN discussions d ON d.id = t.discussion_id WHERE d.owner_id = $1))::float8 AS bytes,
       (SELECT coalesce(max(count), 0) FROM rate_limits
        WHERE key = $2 AND window_start = to_timestamp(floor(extract(epoch FROM now()) / $3::int) * $3::int))::int AS "createdToday"`,
    [userId, createKey(userId), DAY_SECONDS],
  );
  return rows[0];
}

export class DiscussionError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_settings'
      | 'limit_exceeded'
      | 'ended'
      | 'round_mismatch'
      | 'not_your_turn'
      | 'opponent_started'
      | 'invalid_combination'
      | 'not_ended',
    message: string,
  ) {
    super(message);
  }
}

const DISCUSSION_COLS = `id, owner_id, topic, context, mode, starter, status, current_round, max_rounds, min_rounds,
  agreed_proposal_id::text AS agreed_proposal_id, ended_at, created_at, updated_at`;
const TURN_COLS = `id::text AS id, round, participant, content, proposal, agreement,
  accepted_proposal_id::text AS accepted_proposal_id, sign, open_issues, created_at`;

const turnsOf = async (q: Queryable, discussionId: string) =>
  (await q.query<Turn>(`SELECT ${TURN_COLS} FROM turns WHERE discussion_id = $1 ORDER BY round, id`, [discussionId])).rows;

// 순차 방식의 현재 합의안: 가장 최근 proposal
export const currentProposal = (turns: Turn[]) => turns.findLast((t) => t.proposal !== null);

function settingsOf(input: CreateInput) {
  if (!input.topic.trim() || input.topic.length > INPUT_LIMITS.topic) {
    throw new DiscussionError('invalid_settings', `주제는 1~${INPUT_LIMITS.topic}자여야 합니다`);
  }
  if ((input.context ?? '').length > INPUT_LIMITS.context) {
    throw new DiscussionError('invalid_settings', `배경 설명은 ${INPUT_LIMITS.context}자까지입니다`);
  }
  const mode = input.mode ?? 'parallel';
  if (mode === 'parallel') {
    const max = input.max_rounds ?? 5;
    const min = input.min_rounds ?? 2;
    if (!(Number.isInteger(max) && Number.isInteger(min) && 2 <= min && min <= max && max <= 10)) {
      throw new DiscussionError('invalid_settings', '동시 방식은 2 ≤ min_rounds ≤ max_rounds ≤ 10이어야 합니다');
    }
    return { mode, max, min };
  }
  if (input.min_rounds !== undefined) throw new DiscussionError('invalid_settings', '순차 방식은 min_rounds를 받지 않습니다');
  const max = input.max_rounds ?? 10;
  if (!(Number.isInteger(max) && 4 <= max && max <= 20)) {
    throw new DiscussionError('invalid_settings', '순차 방식은 4 ≤ max_rounds ≤ 20이어야 합니다');
  }
  return { mode, max, min: null };
}

// 방식에 맞는 필드만 남겨 저장할 모양으로 만든다. 재시도 비교도 이 모양으로 한다.
function normalize(mode: Mode, input: SubmitInput) {
  return {
    content: input.content,
    proposal: input.proposal ?? null,
    open_issues: input.open_issues,
    agreement: mode === 'parallel' ? (input.agreement ?? null) : null,
    accepted_proposal_id: mode === 'parallel' ? (input.accepted_proposal_id ?? null) : null,
    sign: mode === 'sequential' ? (input.sign ?? false) : null,
  };
}
type TurnValues = ReturnType<typeof normalize>;

const sameSubmission = (t: Turn, v: TurnValues) =>
  t.content === v.content &&
  t.proposal === v.proposal &&
  JSON.stringify(t.open_issues) === JSON.stringify(v.open_issues) &&
  t.agreement === v.agreement &&
  t.accepted_proposal_id === v.accepted_proposal_id &&
  t.sign === v.sign;

const invalid = (message: string) => new DiscussionError('invalid_combination', message);

function validateParallel(d: Discussion, turns: Turn[], input: SubmitInput) {
  if (input.sign !== undefined) throw invalid('동시 방식은 sign을 받지 않습니다. agreement를 쓰세요');
  if (input.expected_round !== d.current_round) {
    throw new DiscussionError('round_mismatch', `현재 라운드는 ${d.current_round}입니다. get_state를 다시 호출하세요`);
  }
  if (input.agreement === 'agree') {
    if (!input.accepted_proposal_id) throw invalid('agree에는 accepted_proposal_id가 필요합니다');
    if (input.proposal !== undefined) throw invalid('agree와 새 proposal은 함께 낼 수 없습니다');
    if (input.open_issues.length) throw invalid('agree이면 open_issues는 빈 배열이어야 합니다');
    const target = turns.find((t) => t.id === input.accepted_proposal_id);
    if (!target || target.round >= d.current_round || target.proposal === null) {
      throw invalid('accepted_proposal_id는 완료된 라운드에서 proposal이 있는 답변이어야 합니다');
    }
  } else if (input.accepted_proposal_id !== undefined) {
    throw invalid('accepted_proposal_id는 agree일 때만 씁니다');
  }
}

function validateSequential(d: Discussion, turns: Turn[], me: Participant, input: SubmitInput) {
  if (input.agreement !== undefined || input.accepted_proposal_id !== undefined) {
    throw invalid('순차 방식은 agreement·accepted_proposal_id를 받지 않습니다. sign을 쓰세요');
  }
  const last = turns.at(-1);
  if (last?.participant === me) throw new DiscussionError('not_your_turn', '상대 차례입니다');
  if (input.expected_round !== d.current_round) {
    if (input.expected_round === 1 && d.starter && d.starter !== me) {
      throw new DiscussionError('opponent_started', '상대가 먼저 시작했습니다. get_state부터 다시 진행하세요');
    }
    throw new DiscussionError('round_mismatch', `현재 턴은 ${d.current_round}입니다. get_state를 다시 호출하세요`);
  }
  if (input.sign) {
    if (input.proposal !== undefined) throw invalid('사인과 새 proposal은 함께 낼 수 없습니다');
    if (input.open_issues.length) throw invalid('사인이면 open_issues는 빈 배열이어야 합니다');
    if (!currentProposal(turns)) throw invalid('사인할 합의안이 아직 없습니다');
  }
}

// 합의 판정 → (합의가 아닐 때만) 최대 판정 → (계속할 때만) 번호 증가
function nextState(d: Discussion, turns: Turn[], saved: Turn, me: Participant) {
  const end = (status: Status, agreedId: string | null = null) => ({ status, current_round: d.current_round, agreed_proposal_id: agreedId });
  const advance = () => ({ status: d.status, current_round: d.current_round + 1, agreed_proposal_id: null });
  if (d.mode === 'parallel') {
    const other = turns.find((t) => t.round === d.current_round && t.participant !== me);
    if (!other) return null;
    if (
      saved.agreement === 'agree' &&
      other.agreement === 'agree' &&
      saved.accepted_proposal_id === other.accepted_proposal_id &&
      d.current_round >= d.min_rounds!
    ) {
      return end('agreed', saved.accepted_proposal_id);
    }
    return d.current_round >= d.max_rounds ? end('max_reached') : advance();
  }
  const prev = turns.at(-1);
  if (prev?.sign && saved.sign) return end('agreed', currentProposal(turns)!.id);
  return d.current_round >= d.max_rounds ? end('max_reached') : advance();
}

// retry: 같은 내용의 재제출, conflict: 같은 번호에 다른 내용 (저장된 제출을 그대로 돌려준다)
export interface SubmitResult {
  outcome: 'accepted' | 'retry' | 'conflict';
  turn: Turn;
  discussion: Discussion;
  turns: Turn[];
}

// 토론 데이터 접근은 이 함수가 돌려주는 메서드로만 한다. 모든 쿼리에 owner_id 조건이 붙는다.
export function discussionsFor(db: Db, userId: string) {
  const lockOwned = async (q: Queryable, id: string) => {
    const { rows } = await q.query<Discussion>(`SELECT ${DISCUSSION_COLS} FROM discussions WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [
      id,
      userId,
    ]);
    if (!rows[0]) throw new DiscussionError('not_found', '존재하지 않는 토론입니다');
    return rows[0];
  };

  return {
    // 사용자 행을 잠그고 진행 중·보관 개수, 텍스트 용량, 하루 생성 횟수를 검사한 뒤 만든다
    async create(input: CreateInput): Promise<Discussion> {
      const { mode, max, min } = settingsOf(input);
      const context = input.context ?? '';
      return db.tx(async (q) => {
        const user = await q.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        if (!user.rows[0]) throw new DiscussionError('not_found', '사용자가 없습니다');
        const usage = await usageOf(q, userId);
        const added = Buffer.byteLength(input.topic) + Buffer.byteLength(context);
        if (usage.active >= CREATE_LIMITS.active) {
          throw new DiscussionError('limit_exceeded', `진행 중인 토론은 ${CREATE_LIMITS.active}개까지입니다`);
        }
        if (usage.stored >= CREATE_LIMITS.stored || usage.bytes + added > CREATE_LIMITS.bytes) {
          throw new DiscussionError('limit_exceeded', '보관 한도(50개·5MB)에 도달했습니다. 웹에서 종료된 토론을 삭제하세요');
        }
        if (!(await hitRateLimit(q, createKey(userId), DAY_SECONDS, CREATE_LIMITS.perDay))) {
          throw new DiscussionError('limit_exceeded', `토론 생성은 하루 ${CREATE_LIMITS.perDay}개까지입니다`);
        }
        const created = await q.query<Discussion>(
          `INSERT INTO discussions (id, owner_id, topic, context, mode, max_rounds, min_rounds)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${DISCUSSION_COLS}`,
          [randomBytes(12).toString('base64url'), userId, input.topic, context, mode, max, min],
        );
        return created.rows[0];
      });
    },

    // 최근 수정 순
    async list(): Promise<Discussion[]> {
      const { rows } = await db.query<Discussion>(
        `SELECT ${DISCUSSION_COLS} FROM discussions WHERE owner_id = $1 ORDER BY updated_at DESC, id`,
        [userId],
      );
      return rows;
    },

    usage: () => usageOf(db, userId),

    // 계정 내보내기용: 모든 토론과 답변
    async all(): Promise<{ discussion: Discussion; turns: Turn[] }[]> {
      const list = await this.list();
      return Promise.all(list.map(async (discussion) => ({ discussion, turns: await turnsOf(db, discussion.id) })));
    },

    // 진행 중인 토론을 수동 종료한다
    async close(id: string): Promise<Discussion> {
      return db.tx(async (q) => {
        const d = await lockOwned(q, id);
        if (d.status !== 'active') throw new DiscussionError('ended', '이미 종료된 토론입니다');
        const { rows } = await q.query<Discussion>(
          `UPDATE discussions SET status = 'closed', ended_at = now(), updated_at = now()
           WHERE id = $1 AND owner_id = $2 RETURNING ${DISCUSSION_COLS}`,
          [id, userId],
        );
        return rows[0];
      });
    },

    // 종료된 토론만 답변까지 함께 지운다(turns는 ON DELETE CASCADE). 진행 중이면 먼저 종료해야 한다.
    async remove(id: string): Promise<void> {
      await db.tx(async (q) => {
        const d = await lockOwned(q, id);
        if (d.status === 'active') throw new DiscussionError('not_ended', '진행 중인 토론은 먼저 종료해야 삭제할 수 있습니다');
        await q.query(`DELETE FROM discussions WHERE id = $1 AND owner_id = $2`, [id, userId]);
      });
    },

    async get(id: string): Promise<{ discussion: Discussion; turns: Turn[] }> {
      const { rows } = await db.query<Discussion>(`SELECT ${DISCUSSION_COLS} FROM discussions WHERE id = $1 AND owner_id = $2`, [id, userId]);
      if (!rows[0]) throw new DiscussionError('not_found', '존재하지 않는 토론입니다');
      return { discussion: rows[0], turns: await turnsOf(db, id) };
    },

    // docs/discussion-flow.md "공통 처리 순서"를 그대로 따른다
    async submit(id: string, me: Participant, input: SubmitInput): Promise<SubmitResult> {
      return db.tx(async (q) => {
        let d = await lockOwned(q, id);
        const values = normalize(d.mode, input);
        const { rows: existing } = await q.query<Turn>(
          `SELECT ${TURN_COLS} FROM turns WHERE discussion_id = $1 AND round = $2 AND participant = $3`,
          [id, input.expected_round, me],
        );
        if (existing[0]) {
          return {
            outcome: sameSubmission(existing[0], values) ? 'retry' : 'conflict',
            turn: existing[0],
            discussion: d,
            turns: await turnsOf(q, id),
          };
        }
        if (d.status !== 'active') throw new DiscussionError('ended', '종료된 토론입니다');
        const turns = await turnsOf(q, id);
        if (d.mode === 'parallel') validateParallel(d, turns, input);
        else validateSequential(d, turns, me, input);

        const { rows: inserted } = await q.query<Turn>(
          `INSERT INTO turns (discussion_id, round, participant, content, proposal, agreement, accepted_proposal_id, sign, open_issues)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${TURN_COLS}`,
          [id, d.current_round, me, values.content, values.proposal, values.agreement, values.accepted_proposal_id, values.sign, JSON.stringify(values.open_issues)],
        );
        const saved = inserted[0];
        const next = nextState(d, turns, saved, me);
        const starter = d.mode === 'sequential' && !d.starter ? me : d.starter;
        if (next || starter !== d.starter) {
          const s = next ?? { status: d.status, current_round: d.current_round, agreed_proposal_id: null };
          const { rows } = await q.query<Discussion>(
            `UPDATE discussions SET status = $2, current_round = $3, agreed_proposal_id = $4, starter = $5,
               ended_at = CASE WHEN $2 = 'active' THEN NULL ELSE now() END, updated_at = now()
             WHERE id = $1 AND owner_id = $6 RETURNING ${DISCUSSION_COLS}`,
            [id, s.status, s.current_round, s.agreed_proposal_id, starter, userId],
          );
          d = rows[0];
        }
        return { outcome: 'accepted', turn: saved, discussion: d, turns: [...turns, saved] };
      });
    },
  };
}
