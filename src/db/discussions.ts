import { randomBytes } from 'node:crypto';
import type { Db, Queryable } from './db.js';
import { ISSUE_ACTIONS, ISSUE_LIMITS, issueRef, replayIssues, type IssueEvent, type IssueStatus, type IssueUpdate } from './issues.js';
import { hitRateLimit } from './rate-limit.js';

export type Mode = 'parallel' | 'sequential';
export type Status = 'active' | 'agreed' | 'max_reached' | 'closed';
export type Agreement = 'agree' | 'partial' | 'disagree';
// 토론 자리. 어떤 AI·세션이 앉을지는 사용자가 지시문으로 정하고, 도구 호출마다 seat 입력으로 받는다
export type Participant = 'A' | 'B';
export const PARTICIPANTS: readonly Participant[] = ['A', 'B'];

export interface Discussion {
  id: string;
  owner_id: string;
  project_id: string | null;
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
  client_name: string | null;
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
  // 프로젝트 토론만. background_ids를 생략하면 아무 항목도 참조하지 않는다(참조마다 get_state 목록과 읽기 비용이 늘어난다)
  project_id?: string;
  background_ids?: string[];
}

// 토론이 참조하는 배경 항목. 본문은 넣지 않는다(삭제된 text 항목만 body를 채워 웹 기록에 남긴다)
export interface Reference {
  id: string;
  kind: 'text' | 'link' | 'file';
  title: string;
  summary: string;
  location: string | null;
  body_length: number;
  revision: number;
  revision_at_start: number;
  deleted: boolean;
  body?: string;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface SubmitInput {
  expected_round: number;
  content: string;
  proposal?: string;
  // deprecated: 자유 문장 이견. 저장·표시만 하고 쟁점 ID는 만들지 않는다
  open_issues: string[];
  issue_updates?: IssueUpdate[];
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
  // bytes 중 삭제됐지만 과거 토론 기록 때문에 보관 중인 배경 항목의 용량
  retainedBytes: number;
  createdToday: number;
}

const createKey = (userId: string) => `discussion-create:${userId}`;
const DAY_SECONDS = 24 * 60 * 60;

// 배경 항목 한 행의 바이트: 제목·요약·본문·위치. 소프트 삭제된 항목도 저장 공간을 쓰므로 센다
const BACKGROUND_BYTES = `octet_length(b.title) + octet_length(b.summary) + octet_length(b.body) + coalesce(octet_length(b.location), 0)`;

// 텍스트 용량: topic·context, 모든 답변의 content·proposal·open_issues 문자열, 쟁점 이벤트의 text·note, 배경 항목의 UTF-8 바이트 합.
// 쟁점 캐시(issues.title)는 이벤트 문구와 겹치므로 세지 않는다.
// owner는 사용자 ID를 가리키는 SQL 식($1 또는 u.id). usageOf와 운영자 화면(listUsersWithUsage)이 같은 식을 쓴다.
export const usageBytesSql = (owner: string) => `((SELECT coalesce(sum(octet_length(topic) + octet_length(context)), 0) FROM discussions d WHERE d.owner_id = ${owner})
        + (SELECT coalesce(sum(octet_length(t.content) + coalesce(octet_length(t.proposal), 0)
             + (SELECT coalesce(sum(octet_length(x)), 0) FROM jsonb_array_elements_text(t.open_issues) x)), 0)
           FROM turns t JOIN discussions d ON d.id = t.discussion_id WHERE d.owner_id = ${owner})
        + (SELECT coalesce(sum(coalesce(octet_length(e.text), 0) + coalesce(octet_length(e.note), 0)), 0)
           FROM issue_events e JOIN issues i ON i.id = e.issue_id JOIN discussions d ON d.id = i.discussion_id WHERE d.owner_id = ${owner})
        + (SELECT coalesce(sum(${BACKGROUND_BYTES}), 0)
           FROM project_backgrounds b JOIN projects p ON p.id = b.project_id WHERE p.owner_id = ${owner}))::float8`;

export async function usageOf(q: Queryable, userId: string): Promise<Usage> {
  const { rows } = await q.query<Usage>(
    `SELECT
       (SELECT count(*) FROM discussions WHERE owner_id = $1 AND status = 'active')::int AS active,
       (SELECT count(*) FROM discussions WHERE owner_id = $1)::int AS stored,
       ${usageBytesSql('$1')} AS bytes,
       (SELECT coalesce(sum(${BACKGROUND_BYTES}), 0) FROM project_backgrounds b JOIN projects p ON p.id = b.project_id
        WHERE p.owner_id = $1 AND b.deleted_at IS NOT NULL)::float8 AS "retainedBytes",
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
      | 'invalid_issue'
      | 'not_ended'
      | 'revision_mismatch'
      | 'in_use',
    message: string,
  ) {
    super(message);
  }
}

const DISCUSSION_COLS = `id, owner_id, project_id, topic, context, mode, starter, status, current_round, max_rounds, min_rounds,
  agreed_proposal_id::text AS agreed_proposal_id, ended_at, created_at, updated_at`;
const TURN_COLS = `id::text AS id, round, participant, client_name, content, proposal, agreement,
  accepted_proposal_id::text AS accepted_proposal_id, sign, open_issues, created_at`;

const turnsOf = async (q: Queryable, discussionId: string) =>
  (await q.query<Turn>(`SELECT ${TURN_COLS} FROM turns WHERE discussion_id = $1 ORDER BY round, id`, [discussionId])).rows;

const eventsOf = async (q: Queryable, discussionId: string) =>
  (
    await q.query<IssueEvent>(
      `SELECT e.id::text AS id, e.issue_id::text AS issue_id, e.turn_id::text AS turn_id, e.participant, e.action, e.text, e.note,
         e.proposal_turn_id::text AS proposal_turn_id
       FROM issue_events e JOIN issues i ON i.id = e.issue_id WHERE i.discussion_id = $1 ORDER BY e.id`,
      [discussionId],
    )
  ).rows;

// 쟁점 캐시. number가 없으면 아직 공개되지 않은 쟁점이다
interface IssueRow {
  id: string;
  number: number | null;
  opened_by: Participant;
  status: IssueStatus;
}
const issueRowsOf = async (q: Queryable, discussionId: string) =>
  (await q.query<IssueRow>(`SELECT id::text AS id, number, opened_by, status FROM issues WHERE discussion_id = $1`, [discussionId])).rows;

const refsOf = async (q: Queryable, discussionId: string) =>
  (
    await q.query<Reference & { body: string | null }>(
      `SELECT b.id, b.kind, b.title, b.summary, b.location, length(b.body) AS body_length, b.revision, r.revision_at_start,
         b.deleted_at IS NOT NULL AS deleted, CASE WHEN b.deleted_at IS NOT NULL AND b.kind = 'text' THEN b.body END AS body
       FROM discussion_backgrounds r JOIN project_backgrounds b ON b.id = r.background_id
       WHERE r.discussion_id = $1 ORDER BY b.created_at, b.id`,
      [discussionId],
    )
  ).rows.map(({ body, ...r }): Reference => (body === null ? r : { ...r, body }));

// 순차 방식의 현재 합의안: 가장 최근 proposal
export const currentProposal = (turns: Turn[]) => turns.findLast((t) => t.proposal !== null);

// 동시 방식: 그 라운드에 양쪽이 서로 다른 안에 agree했으면 자리별 동의 대상을 돌려준다
export function crossedAgreement(turns: Turn[], round: number): Record<Participant, string> | null {
  const [a, b] = PARTICIPANTS.map((p) => turns.find((t) => t.round === round && t.participant === p));
  if (a?.agreement !== 'agree' || b?.agreement !== 'agree' || a.accepted_proposal_id === b.accepted_proposal_id) return null;
  return { A: a.accepted_proposal_id!, B: b.accepted_proposal_id! };
}

// 직전 완료 라운드의 엇갈림에서 고를 안. 완료된 라운드의 답변만 넘겨야 양쪽에 같은 값이 나온다.
// 양쪽 모두 agree한 이력이 있는 안을 우선하고, 같으면 ID가 작은 안(turns.id는 증가 시퀀스)을 고른다. 안을 작성한 것은 동의 이력으로 세지 않는다.
export function recommendProposal(completed: Turn[]) {
  const crossed = crossedAgreement(completed, Math.max(0, ...completed.map((t) => t.round)));
  if (!crossed) return null;
  const agreedByBoth = (id: string) =>
    PARTICIPANTS.every((p) => completed.some((t) => t.participant === p && t.agreement === 'agree' && t.accepted_proposal_id === id));
  const [low, high] = [crossed.A, crossed.B].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  const [lowBoth, highBoth] = [agreedByBoth(low), agreedByBoth(high)];
  if (lowBoth !== highBoth) return { proposal_id: lowBoth ? low : high, crossed, reason: '두 안 중 양쪽 모두 agree한 이력이 있는 안입니다' };
  return { proposal_id: low, crossed, reason: `두 안 모두 양쪽 동의 이력이 ${lowBoth ? '있어' : '없어'} ID가 작은 안을 골랐습니다` };
}

// 마지막 라운드에서 서로 다른 안에 agree한 채 max_reached로 끝났으면 그 동의 대상. 판정은 바꾸지 않고 표시에만 쓴다.
export const finalCrossing = (d: Discussion, turns: Turn[]) =>
  d.mode === 'parallel' && d.status === 'max_reached' ? crossedAgreement(turns, d.current_round) : null;

function settingsOf(input: CreateInput) {
  if (!input.topic.trim() || input.topic.length > INPUT_LIMITS.topic) {
    throw new DiscussionError('invalid_settings', `주제는 1~${INPUT_LIMITS.topic}자여야 합니다`);
  }
  if ((input.context ?? '').length > INPUT_LIMITS.context) {
    throw new DiscussionError('invalid_settings', `배경 설명은 ${INPUT_LIMITS.context}자까지입니다`);
  }
  if (input.background_ids !== undefined && !input.project_id) {
    throw new DiscussionError('invalid_settings', 'background_ids는 project_id와 함께만 씁니다');
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
    issue_updates: (input.issue_updates ?? []).map((u) => ({
      action: u.action,
      id: u.id ?? null,
      text: u.text ?? null,
      note: u.note ?? null,
      proposal_ref: u.proposal_ref ?? null,
    })),
    agreement: mode === 'parallel' ? (input.agreement ?? null) : null,
    accepted_proposal_id: mode === 'parallel' ? (input.accepted_proposal_id ?? null) : null,
    sign: mode === 'sequential' ? (input.sign ?? false) : null,
  };
}
type TurnValues = ReturnType<typeof normalize>;

// 저장된 이벤트를 normalize의 issue_updates 모양으로 되돌린다(재시도 비교용)
const savedUpdates = (t: Turn, events: IssueEvent[], issues: IssueRow[]): TurnValues['issue_updates'] =>
  events
    .filter((e) => e.turn_id === t.id)
    .map((e) => ({
      action: e.action,
      id: e.action === 'open' ? null : issueRef(issues.find((i) => i.id === e.issue_id)!.number!),
      text: e.text,
      note: e.note,
      proposal_ref: e.proposal_turn_id === t.id ? 'this' : e.proposal_turn_id,
    }));

const sameSubmission = (t: Turn, v: TurnValues, updates: TurnValues['issue_updates']) =>
  t.content === v.content &&
  t.proposal === v.proposal &&
  JSON.stringify(t.open_issues) === JSON.stringify(v.open_issues) &&
  JSON.stringify(updates) === JSON.stringify(v.issue_updates) &&
  t.agreement === v.agreement &&
  t.accepted_proposal_id === v.accepted_proposal_id &&
  t.sign === v.sign;

const invalid = (message: string) => new DiscussionError('invalid_combination', message);
const invalidIssue = (message: string) => new DiscussionError('invalid_issue', message);

// 공개된 쟁점(동시 방식은 라운드 시작 시점)과 공개된 proposal만 기준으로 검사한다. 비공개 쟁점은 번호가 없어 참조할 수 없으므로
// 오류 문구로 상대의 대기 중 변경이 드러나지 않는다. closingOnly는 agree·sign=true 제출(resolve·withdraw만 허용)
function validateIssueUpdates(
  input: SubmitInput,
  me: Participant,
  published: IssueRow[],
  publicProposals: Set<string>,
  closingOnly: string | null,
) {
  const updates = input.issue_updates ?? [];
  if (updates.length && input.open_issues.length) throw invalid('open_issues와 issue_updates는 함께 쓸 수 없습니다. issue_updates를 쓰세요');
  if (updates.length > ISSUE_LIMITS.updates) throw invalidIssue(`issue_updates는 ${ISSUE_LIMITS.updates}개까지입니다`);
  const seen = new Set<string>();
  return updates.map((u, i) => {
    const at = `issue_updates[${i}]`;
    if (!ISSUE_ACTIONS.includes(u.action)) throw invalidIssue(`${at}: action은 ${ISSUE_ACTIONS.join('·')} 중 하나입니다`);
    if (closingOnly && u.action !== 'resolve' && u.action !== 'withdraw') {
      throw invalidIssue(`${closingOnly} 제출의 issue_updates에는 resolve·withdraw만 쓸 수 있습니다`);
    }
    const withText = u.action === 'open' || u.action === 'revise';
    if (withText !== (u.text !== undefined)) throw invalidIssue(`${at}: text는 open·revise에만 쓰고 그때는 필수입니다`);
    if (u.text !== undefined && !(u.text.trim() && u.text.length <= ISSUE_LIMITS.text)) throw invalidIssue(`${at}: text는 1~${ISSUE_LIMITS.text}자입니다`);
    if ((u.action === 'open') !== (u.note === undefined)) throw invalidIssue(`${at}: note는 open 외의 변경에 필수이고 open에는 쓰지 않습니다`);
    if (u.note !== undefined && !(u.note.trim() && u.note.length <= ISSUE_LIMITS.note)) throw invalidIssue(`${at}: note는 1~${ISSUE_LIMITS.note}자입니다`);
    if (u.proposal_ref === 'this' ? input.proposal === undefined : u.proposal_ref !== undefined && !publicProposals.has(u.proposal_ref)) {
      throw invalidIssue(`${at}: proposal_ref는 공개된 proposal 답변 ID이거나, 이번 제출에 proposal이 있을 때 "this"입니다`);
    }
    if (u.action === 'open') {
      if (u.id !== undefined) throw invalidIssue(`${at}: open에는 id를 쓰지 않습니다`);
      return { ...u, issue: null };
    }
    const issue = published.find((x) => issueRef(x.number!) === u.id);
    if (!issue) throw invalidIssue(`${at}: 없는 쟁점입니다(${u.id ?? 'id 없음'}). get_state의 issues에서 ID를 확인하세요`);
    if (seen.has(issue.id)) throw invalidIssue(`${at}: 한 제출에서 같은 쟁점(${u.id})을 두 번 바꿀 수 없습니다`);
    seen.add(issue.id);
    if ((u.action === 'reopen') === (issue.status === 'open')) {
      throw invalidIssue(`${at}: ${u.id}는 ${issue.status} 상태라 ${u.action}할 수 없습니다`);
    }
    if (u.action === 'withdraw' && issue.opened_by !== me) throw invalidIssue(`${at}: withdraw는 쟁점을 연 쪽만 할 수 있습니다`);
    return { ...u, issue };
  });
}
type CheckedUpdate = ReturnType<typeof validateIssueUpdates>[number];

// 비차단 안내. 공개 스냅샷에 이번 제출의 변경만 더해 계산한다(동시 방식은 상대의 대기 중 변경을 넣지 않는다)
export interface SubmitWarning {
  code: 'open_issues_remain';
  message: string;
  issues: string[];
  basis_round?: number;
  basis_turn?: number;
}

function issueWarnings(d: Discussion, published: IssueRow[], updates: CheckedUpdate[], closing: boolean): SubmitWarning[] {
  if (!closing) return [];
  const closed = new Set(updates.filter((u) => u.action === 'resolve' || u.action === 'withdraw').map((u) => u.issue!.id));
  const open = published.filter((x) => x.status === 'open' && !closed.has(x.id)).sort((a, b) => a.number! - b.number!);
  if (!open.length) return [];
  const issues = open.map((x) => issueRef(x.number!));
  return [
    {
      code: 'open_issues_remain',
      message: `열린 쟁점 ${issues.join(', ')}이(가) 남은 채 동의합니다. 합의를 막지는 않지만 종료 기록에 미종결로 남습니다`,
      issues,
      ...(d.mode === 'parallel' ? { basis_round: d.current_round - 1 } : { basis_turn: d.current_round }),
    },
  ];
}

// 공개된 이벤트를 다시 적용한 결과로 쟁점 캐시(번호·문구·상태·종결 턴)와 충돌 표시를 맞춘다. 대기 이벤트는 건드리지 않는다
async function syncIssues(q: Queryable, d: Discussion, turns: Turn[]) {
  const r = replayIssues(d, turns, await eventsOf(q, d.id));
  if (!r.issues.length) return;
  await q.query(
    `UPDATE issues i SET number = v.number, title = v.title, status = v.status, closed_turn_id = v.closed_turn_id
     FROM unnest($2::bigint[], $3::int[], $4::text[], $5::text[], $6::bigint[]) AS v(id, number, title, status, closed_turn_id)
     WHERE i.id = v.id AND i.discussion_id = $1`,
    [
      d.id,
      r.issues.map((s) => s.id),
      r.issues.map((s) => s.number),
      r.issues.map((s) => s.title),
      r.issues.map((s) => s.status),
      r.issues.map((s) => s.closed_turn_id),
    ],
  );
  await q.query(
    `UPDATE issue_events SET conflict = (id = ANY($2::bigint[])) WHERE issue_id IN (SELECT id FROM issues WHERE discussion_id = $1)`,
    [d.id, [...r.conflicts]],
  );
}

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
  issueEvents: IssueEvent[];
  warnings: SubmitWarning[];
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
        // 프로젝트 소유와 각 항목의 소속을 사용자 행 잠금 안에서 확인한다. 같은 잠금을 잡는 배경 삭제와 엇갈리지 않는다.
        let backgroundIds: string[] = [];
        if (input.project_id) {
          const project = await q.query(`SELECT id FROM projects WHERE id = $1 AND owner_id = $2`, [input.project_id, userId]);
          if (!project.rows[0]) throw new DiscussionError('not_found', '존재하지 않는 프로젝트입니다');
          const picked = input.background_ids ?? [];
          const { rows } = await q.query<{ id: string }>(
            `SELECT id FROM project_backgrounds WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2)`,
            [input.project_id, picked],
          );
          backgroundIds = rows.map((r) => r.id);
          if (backgroundIds.length !== new Set(picked).size) {
            throw new DiscussionError('not_found', '이 프로젝트에 없는 배경 항목이 있습니다');
          }
        }
        if (!(await hitRateLimit(q, createKey(userId), DAY_SECONDS, CREATE_LIMITS.perDay))) {
          throw new DiscussionError('limit_exceeded', `토론 생성은 하루 ${CREATE_LIMITS.perDay}개까지입니다`);
        }
        const created = await q.query<Discussion>(
          `INSERT INTO discussions (id, owner_id, project_id, topic, context, mode, max_rounds, min_rounds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DISCUSSION_COLS}`,
          [randomBytes(12).toString('base64url'), userId, input.project_id ?? null, input.topic, context, mode, max, min],
        );
        if (backgroundIds.length) {
          await q.query(
            `INSERT INTO discussion_backgrounds (discussion_id, background_id, revision_at_start)
             SELECT $1, id, revision FROM project_backgrounds WHERE id = ANY($2)`,
            [created.rows[0].id, backgroundIds],
          );
        }
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

    // 계정 내보내기용: 모든 토론과 답변, 쟁점 이벤트, 참조 배경
    async all(): Promise<{ discussion: Discussion; turns: Turn[]; issueEvents: IssueEvent[]; refs: Reference[] }[]> {
      const list = await this.list();
      return Promise.all(
        list.map(async (discussion) => ({
          discussion,
          turns: await turnsOf(db, discussion.id),
          issueEvents: await eventsOf(db, discussion.id),
          refs: await refsOf(db, discussion.id),
        })),
      );
    },

    // 진행 중인 토론을 수동 종료한다. 동시 방식 진행 중 라운드의 쟁점 변경은 있는 제출만 같은 트랜잭션에서 공개한다
    async close(id: string): Promise<Discussion> {
      return db.tx(async (q) => {
        const d = await lockOwned(q, id);
        if (d.status !== 'active') throw new DiscussionError('ended', '이미 종료된 토론입니다');
        const { rows } = await q.query<Discussion>(
          `UPDATE discussions SET status = 'closed', ended_at = now(), updated_at = now()
           WHERE id = $1 AND owner_id = $2 RETURNING ${DISCUSSION_COLS}`,
          [id, userId],
        );
        await syncIssues(q, rows[0], await turnsOf(q, id));
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

    // project는 프로젝트 토론일 때만 채운다. issueEvents는 getIssueLedger에 넘겨 viewer별 원장을 만든다
    async get(id: string): Promise<{
      discussion: Discussion;
      turns: Turn[];
      issueEvents: IssueEvent[];
      project: ProjectRef | null;
      refs: Reference[];
    }> {
      const { rows } = await db.query<Discussion>(`SELECT ${DISCUSSION_COLS} FROM discussions WHERE id = $1 AND owner_id = $2`, [id, userId]);
      if (!rows[0]) throw new DiscussionError('not_found', '존재하지 않는 토론입니다');
      const base = { discussion: rows[0], turns: await turnsOf(db, id), issueEvents: await eventsOf(db, id) };
      const projectId = rows[0].project_id;
      if (!projectId) return { ...base, project: null, refs: [] };
      const project = await db.query<ProjectRef>(`SELECT id, name FROM projects WHERE id = $1 AND owner_id = $2`, [projectId, userId]);
      return { ...base, project: project.rows[0], refs: await refsOf(db, id) };
    },

    // docs/discussion-flow.md "공통 처리 순서"를 그대로 따른다
    async submit(id: string, me: Participant, clientName: string, input: SubmitInput): Promise<SubmitResult> {
      return db.tx(async (q) => {
        let d = await lockOwned(q, id);
        const values = normalize(d.mode, input);
        const { rows: existing } = await q.query<Turn>(
          `SELECT ${TURN_COLS} FROM turns WHERE discussion_id = $1 AND round = $2 AND participant = $3`,
          [id, input.expected_round, me],
        );
        const issueRows = await issueRowsOf(q, id);
        if (existing[0]) {
          const issueEvents = await eventsOf(q, id);
          return {
            outcome: sameSubmission(existing[0], values, savedUpdates(existing[0], issueEvents, issueRows)) ? 'retry' : 'conflict',
            turn: existing[0],
            discussion: d,
            turns: await turnsOf(q, id),
            issueEvents,
            warnings: [],
          };
        }
        if (d.status !== 'active') throw new DiscussionError('ended', '종료된 토론입니다');
        const turns = await turnsOf(q, id);
        if (d.mode === 'parallel') validateParallel(d, turns, input);
        else validateSequential(d, turns, me, input);
        // 동시 방식은 진행 중 라운드가 공개되지 않으므로 캐시의 공개 쟁점이 곧 라운드 시작 스냅샷이다
        const published = issueRows.filter((x) => x.number !== null);
        const publicProposals = new Set(
          turns.filter((t) => t.proposal !== null && (d.mode === 'sequential' || t.round < d.current_round)).map((t) => t.id),
        );
        const closing = d.mode === 'parallel' ? (input.agreement === 'agree' ? 'agree' : null) : input.sign ? 'sign=true' : null;
        const updates = validateIssueUpdates(input, me, published, publicProposals, closing);
        const warnings = issueWarnings(d, published, updates, closing !== null);

        const { rows: inserted } = await q.query<Turn>(
          `INSERT INTO turns (discussion_id, round, participant, client_name, content, proposal, agreement, accepted_proposal_id, sign, open_issues)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${TURN_COLS}`,
          [id, d.current_round, me, clientName, values.content, values.proposal, values.agreement, values.accepted_proposal_id, values.sign, JSON.stringify(values.open_issues)],
        );
        const saved = inserted[0];
        for (const u of updates) {
          const issueId =
            u.issue?.id ??
            (
              await q.query<{ id: string }>(
                `INSERT INTO issues (discussion_id, opened_by, opened_turn_id, title) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
                [id, me, saved.id, u.text],
              )
            ).rows[0].id;
          await q.query(
            `INSERT INTO issue_events (issue_id, turn_id, participant, action, text, note, proposal_turn_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [issueId, saved.id, me, u.action, u.text ?? null, u.note ?? null, u.proposal_ref === 'this' ? saved.id : (u.proposal_ref ?? null)],
          );
        }
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
        // 순차 방식은 제출마다, 동시 방식은 라운드가 끝날 때(다음 라운드·합의·최대 도달) 쟁점 변경을 공개한다. 둘 다 next가 있을 때다
        const all = [...turns, saved];
        if (next) await syncIssues(q, d, all);
        return {
          outcome: 'accepted',
          turn: saved,
          discussion: d,
          turns: all,
          issueEvents: await eventsOf(q, id),
          warnings,
        };
      });
    },
  };
}
