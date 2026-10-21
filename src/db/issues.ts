import type { Discussion, Participant, Turn } from './discussions.js';

// 쟁점 원장. 저장된 이벤트를 공개 순서대로 다시 적용해 쟁점 상태와 턴별 변경을 계산한다. DB에 접근하지 않는다.
export const ISSUE_ACTIONS = ['open', 'revise', 'resolve', 'withdraw', 'reopen'] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];
export type IssueStatus = 'open' | 'resolved' | 'withdrawn';
// viewer는 공개 범위만 정한다. 소유권 검증은 호출 전에 discussionsFor가 한다
export type IssueViewer = 'mcp' | 'web';

export const ISSUE_LIMITS = { updates: 10, text: 200, note: 500 };

// submit 입력 한 건. id는 표시 ID(I1…), proposal_ref는 공개된 proposal 답변 ID 또는 "this"(이번 제출의 proposal)
export interface IssueUpdate {
  action: IssueAction;
  id?: string;
  text?: string;
  note?: string;
  proposal_ref?: string;
}

export interface IssueEvent {
  id: string;
  issue_id: string;
  turn_id: string;
  participant: Participant;
  action: IssueAction;
  text: string | null;
  note: string | null;
  proposal_turn_id: string | null;
}

interface Snapshot {
  title: string;
  status: IssueStatus;
}

export interface IssueChange {
  event_id: string;
  turn_id: string;
  turn: number;
  by: Participant;
  ref: string | null;
  action: IssueAction;
  // 요청한 문구. 충돌로 반영되지 않았어도 그대로 둔다
  text: string | null;
  note: string | null;
  proposal_turn_id: string | null;
  conflict: boolean;
  pending: boolean;
  before: Snapshot | null;
  after: Snapshot | null;
}

export interface IssueView {
  ref: string;
  status: IssueStatus;
  title: string;
  initial_title: string;
  opened: { turn: number; by: Participant };
  closed: { turn: number; by: Participant; action: 'resolve' | 'withdraw'; note: string | null } | null;
  unresolved_at_end: boolean;
  history: IssueChange[];
}

export interface IssueLedger {
  issues: IssueView[];
  changesByTurn: Record<string, IssueChange[]>;
}

export const issueRef = (n: number) => `I${n}`;

// 동시 방식 진행 중 라운드의 이벤트는 대기 중이다. 라운드가 끝나거나 토론이 종료될 때 함께 공개된다.
export const pendingRound = (d: Pick<Discussion, 'mode' | 'status' | 'current_round'>) =>
  d.mode === 'parallel' && d.status === 'active' ? d.current_round : null;

interface IssueState extends Omit<IssueView, 'ref' | 'unresolved_at_end'> {
  id: string;
  number: number;
  closed_turn_id: string | null;
}

// 같은 변경인지: action·text·proposal_ref(정규화한 답변 ID)가 같으면 같다. note는 비교하지 않는다
const changeKey = (e: IssueEvent) => JSON.stringify([e.action, e.text, e.proposal_turn_id]);
const snap = (s: IssueState): Snapshot => ({ title: s.title, status: s.status });

function apply(s: IssueState, e: IssueEvent, turn: number) {
  if (e.action === 'revise') s.title = e.text!;
  else if (e.action === 'reopen') {
    s.status = 'open';
    s.closed = null;
    s.closed_turn_id = null;
  } else if (e.action === 'resolve' || e.action === 'withdraw') {
    s.status = e.action === 'resolve' ? 'resolved' : 'withdrawn';
    s.closed = { turn, by: e.participant, action: e.action, note: e.note };
    s.closed_turn_id = e.turn_id;
  }
}

// 라운드(순차 방식은 턴) 단위로 공개된 이벤트를 적용한다. 한 라운드 안에서는 A→B, 제출 내 배열 순서다.
// 동시 방식에서 두 자리가 같은 쟁점을 바꿨으면 같은 변경은 한 번만 적용하고, 다른 변경은 둘 다 충돌로 두고 문구는 그대로, 상태는 open으로 둔다.
export function replayIssues(d: Pick<Discussion, 'mode' | 'status' | 'current_round'>, turns: Turn[], events: IssueEvent[]) {
  const turnOf = new Map(turns.map((t) => [t.id, t]));
  const sorted = events
    .map((e) => ({ e, t: turnOf.get(e.turn_id)! }))
    .sort((x, y) => x.t.round - y.t.round || x.t.participant.localeCompare(y.t.participant) || Number(BigInt(x.e.id) - BigInt(y.e.id)));
  const pending = pendingRound(d);
  const issues = new Map<string, IssueState>();
  const published: IssueChange[] = [];
  const conflicts = new Set<string>();
  const change = (e: IssueEvent, turn: number, ref: string | null, before: Snapshot | null, after: Snapshot | null): IssueChange => ({
    event_id: e.id,
    turn_id: e.turn_id,
    turn,
    by: e.participant,
    ref,
    action: e.action,
    text: e.text,
    note: e.note,
    proposal_turn_id: e.proposal_turn_id,
    conflict: conflicts.has(e.id),
    pending: false,
    before,
    after,
  });
  const record = (s: IssueState, e: IssueEvent, turn: number, before: Snapshot | null) => {
    const c = change(e, turn, issueRef(s.number), before, snap(s));
    s.history.push(c);
    published.push(c);
  };

  for (const round of [...new Set(sorted.map((x) => x.t.round))]) {
    if (round === pending) continue;
    const groups = new Map<string, IssueEvent[]>();
    for (const { e } of sorted.filter((x) => x.t.round === round)) {
      if (e.action !== 'open') {
        groups.set(e.issue_id, [...(groups.get(e.issue_id) ?? []), e]);
        continue;
      }
      const s: IssueState = {
        id: e.issue_id,
        number: issues.size + 1,
        status: 'open',
        title: e.text!,
        initial_title: e.text!,
        opened: { turn: round, by: e.participant },
        closed: null,
        closed_turn_id: null,
        history: [],
      };
      issues.set(s.id, s);
      record(s, e, round, null);
    }
    for (const [issueId, group] of groups) {
      const s = issues.get(issueId)!;
      const before = snap(s);
      if (group.every((e) => changeKey(e) === changeKey(group[0]))) apply(s, group[0], round);
      else {
        s.status = 'open';
        s.closed = null;
        s.closed_turn_id = null;
        for (const e of group) conflicts.add(e.id);
      }
      for (const e of group) record(s, e, round, before);
    }
  }

  // 대기 이벤트: 직전 공개 상태만 before로 둔다. 새 쟁점은 번호가 없고, 결과(after)는 공개 전이라 비운다
  const waiting = sorted
    .filter((x) => x.t.round === pending)
    .map(({ e, t }) => {
      const s = e.action === 'open' ? undefined : issues.get(e.issue_id);
      return { ...change(e, t.round, s ? issueRef(s.number) : null, s ? snap(s) : null, null), pending: true };
    });
  return { issues: [...issues.values()], published, waiting, conflicts };
}

export function getIssueLedger(
  snapshot: { discussion: Discussion; turns: Turn[]; issueEvents: IssueEvent[] },
  viewer: IssueViewer,
): IssueLedger {
  const { discussion: d } = snapshot;
  const r = replayIssues(d, snapshot.turns, snapshot.issueEvents);
  const changesByTurn: Record<string, IssueChange[]> = {};
  for (const c of viewer === 'web' ? [...r.published, ...r.waiting] : r.published) (changesByTurn[c.turn_id] ??= []).push(c);
  return {
    issues: r.issues.map(({ id: _id, number, closed_turn_id: _closed, ...s }) => ({
      ref: issueRef(number),
      ...s,
      unresolved_at_end: d.status !== 'active' && s.status === 'open',
    })),
    changesByTurn,
  };
}
