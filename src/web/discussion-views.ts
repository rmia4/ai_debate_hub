import type { Request, Response } from 'express';
import { currentProposal, PARTICIPANTS, type Discussion, type Participant, type Turn } from '../db/discussions.js';
import type { IssueChange, IssueLedger } from '../db/issues.js';
import { PARTICIPANT_NAME } from '../instructions.js';
import { esc } from './html.js';
import { issueChangeFlags, issueChangeText, ISSUE_STATUS_LABEL, renderMarkdown, STATUS_LABEL } from './markdown.js';
import { cookieOptions, readCookie } from './session.js';

// 토론 상세 화면의 조각(주장 상자·라운드 쟁점 박스)과 동시·순차 토론의 화면 방식 다섯 가지

export const formatTime = (d: Date | null) =>
  d ? new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '없음';

// 쟁점 변경 한 줄. 반영 제안은 그 답변으로 가는 링크, 대기·충돌은 배지로 구분한다. 이월(미언급)은 표시하지 않는다
function issueChangeItem(c: IssueChange, by = '') {
  const link = c.proposal_turn_id ? ` · 반영 제안 <a href="#t${esc(c.proposal_turn_id)}">#${esc(c.proposal_turn_id)}</a>` : '';
  return `<li>${by ? `<b>${by}</b>` : ''}${esc(issueChangeText(c))}${link}${flagBadges(c)}</li>`;
}

const flagBadges = (c: IssueChange) => issueChangeFlags(c).map((f) => ` <span class="badge">${f}</span>`).join('');

// 머리줄을 눌러 주장을 접고 편다
// 동시 토론에서 같은 라운드의 A석·B석 주장은 함께 접고 편다(app.js가 data-pair로 맞춘다)
const pairAttr = (t: Turn, d: Discussion) => (d.mode === 'parallel' ? ` data-pair="r${t.round}"` : '');

// anchor=false는 같은 주장을 한 화면에 두 번 보일 때 두 번째 것의 id를 뺀다
function turnBox(t: Turn, d: Discussion, changes: IssueChange[] = [], open = true, anchor = true) {
  const badges = [
    t.agreement ? `<span class="badge">${esc(t.agreement)}${t.accepted_proposal_id ? ` → #${esc(t.accepted_proposal_id)}` : ''}</span>` : '',
    t.sign ? '<span class="badge ok">사인</span>' : '',
    d.agreed_proposal_id === t.id ? '<span class="badge ok">합의된 안</span>' : '',
  ].join(' ');
  const app = t.client_name ? ` <small>${esc(t.client_name)}</small>` : '';
  return `<details class="turn seat-${t.participant}"${anchor ? ` id="t${esc(t.id)}"` : ''}${pairAttr(t, d)}${open ? ' open' : ''}><summary><b>${PARTICIPANT_NAME[t.participant]}</b>${app} <small>#${esc(t.id)} · ${formatTime(t.created_at)}</small> ${badges}</summary>
    ${renderMarkdown(t.content)}
    ${t.proposal ? `<p><b>제안 #${esc(t.id)}</b></p>${renderMarkdown(t.proposal)}` : ''}
    ${changes.length ? `<p>쟁점 변경</p><ul>${changes.map((c) => issueChangeItem(c)).join('')}</ul>` : ''}
    ${t.open_issues.length ? `<p>구 형식 이견</p><ul>${t.open_issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</details>`;
}

// ---------- 화면 방식 ----------

export const VIEWS = { a: '정보 위계', b: '분할', c: '표', d: '탭', e: '타임라인' } as const;
export type View = keyof typeof VIEWS;
const VIEW_COOKIE = 'parallel_view';
const isView = (v: unknown): v is View => typeof v === 'string' && Object.hasOwn(VIEWS, v);

// ?view=로 고르면 쿠키에 1년 기억한다(동시·순차 공통). 고른 적이 없으면 A(정보 위계)
export function pickView(req: Request, res: Response): View {
  if (isView(req.query.view)) {
    res.cookie(VIEW_COOKIE, req.query.view, cookieOptions(365 * 24 * 60 * 60));
    return req.query.view;
  }
  const saved = readCookie(req, VIEW_COOKIE);
  return isView(saved) ? saved : 'a';
}

// 화면 방식에 넘기는 재료. 안내·요약 줄·쟁점·결론·부가 정보는 상세 화면이 만든 HTML을 그대로 받는다
export interface ViewInput {
  d: Discussion;
  turns: Turn[];
  ledger: IssueLedger;
  notices: string;
  meta: string;
  issues: string;
  conclusion: string;
  extras: string;
  extrasOpen: boolean;
}

// 각 방식은 안내와 요약 줄·화면 선택을 묶은 head를 맨 위에 둔다
interface ViewPage {
  d: Discussion;
  turns: Turn[];
  ledger: IssueLedger;
  head: string;
  issues: string;
  conclusion: string;
  extras: string;
  extrasOpen: boolean;
}

// ---------- 동시 토론 ----------

interface Round {
  r: number;
  inRound: Turn[];
  ongoing: boolean;
  agreed: boolean;
}

// 기록이 있는 라운드와 진행 중 라운드. 웹은 진행 중 라운드의 제출도 보여 준다
function roundsOf(d: Discussion, turns: Turn[]): Round[] {
  const lastRound = Math.max(d.current_round, ...turns.map((t) => t.round));
  const rounds: Round[] = [];
  for (let r = 1; r <= lastRound; r++) {
    const inRound = turns.filter((t) => t.round === r);
    const ongoing = d.status === 'active' && r === d.current_round;
    if (inRound.length || ongoing) rounds.push({ r, inRound, ongoing, agreed: d.status === 'agreed' && r === d.current_round });
  }
  return rounds;
}

const roundBadges = (x: Round) => `${x.ongoing ? ' <span class="badge b">진행 중</span>' : ''}${x.agreed ? ' <span class="badge ok">합의</span>' : ''}`;
const roundChanges = (x: Round, ledger: IssueLedger) => x.inRound.flatMap((t) => ledger.changesByTurn[t.id] ?? []);

function seatCell(x: Round, p: Participant, d: Discussion, open = true, anchor = true) {
  const t = x.inRound.find((t) => t.participant === p);
  return t ? turnBox(t, d, [], open, anchor) : `<div class="turn seat-${p}"><b>${PARTICIPANT_NAME[p]}</b> <small>아직 제출 안 함</small></div>`;
}

const pair = (x: Round, d: Discussion, anchor = true) => `<div class="cols">${PARTICIPANTS.map((p) => seatCell(x, p, d, true, anchor)).join('')}</div>`;

// 라운드 끝 쟁점 상태: 쟁점마다 이 라운드까지 공개된 마지막 변경의 결과와 이 라운드에서 생긴 일
function roundEnd(r: number, ledger: IssueLedger) {
  return ledger.issues.flatMap((i) => {
    const last = i.history.findLast((c) => c.turn <= r);
    if (!last?.after) return [];
    const here = i.history.filter((c) => c.turn === r);
    const mark =
      i.opened.turn === r ? '새로 열림' : here.some((c) => c.after?.status !== 'open' && c.before?.status === 'open') ? '이번 라운드 종결' : here.length ? '이번 라운드 변경' : '';
    return [{ ref: i.ref, ...last.after, mark }];
  });
}

// 라운드 쟁점 박스: 이번 라운드에 양쪽이 낸 변경과 라운드 끝 쟁점 상태. 진행 중 라운드의 끝 상태는 아직 공개 전이다
function roundIssueBox(x: Round, ledger: IssueLedger) {
  const changes = roundChanges(x, ledger);
  const changeList = changes.length
    ? `<ul>${changes.map((c) => issueChangeItem(c, `${PARTICIPANT_NAME[c.by]} `)).join('')}</ul>`
    : '<p class="note">이 라운드에는 쟁점 변경이 없습니다.</p>';
  const states = roundEnd(x.r, ledger);
  const stateList = (title: string, items: typeof states) =>
    items.length
      ? `<p>${title}</p><ul>${items
          .map(
            (s) =>
              `<li>${esc(`${s.ref} ${s.title}`)}${s.status !== 'open' ? ` <span class="badge">${ISSUE_STATUS_LABEL[s.status]}</span>` : ''}${s.mark ? ` <span class="badge ok">${s.mark}</span>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  const stateHtml = x.ongoing
    ? '<p class="note">라운드가 끝나면 공개됩니다.</p>'
    : stateList('열린 쟁점', states.filter((s) => s.status === 'open')) + stateList('종결된 쟁점', states.filter((s) => s.status !== 'open')) ||
      '<p class="note">쟁점이 없습니다.</p>';
  return fold(`라운드 ${x.r} 쟁점`, `<p>이번 라운드 변경</p>${changeList}<p>라운드 끝 상태</p>${stateHtml}`);
}

// 진행 중이면 이번 라운드에 아직 안 낸 자리, 끝났으면 상태
function turnText(d: Discussion, turns: Turn[]) {
  if (d.status !== 'active') return STATUS_LABEL[d.status];
  const done = turns.filter((t) => t.round === d.current_round).map((t) => t.participant);
  return `${PARTICIPANTS.filter((p) => !done.includes(p)).map((p) => PARTICIPANT_NAME[p]).join('·')} 차례`;
}

const meter = (d: Discussion) =>
  `<span class="meter" aria-hidden="true">${Array.from({ length: d.max_rounds }, (_, i) => {
    const r = i + 1;
    return `<i class="${r < d.current_round || (r === d.current_round && d.status !== 'active') ? 'done' : r === d.current_round ? 'now' : ''}"></i>`;
  }).join('')}</span>`;

const statusBadge = (d: Discussion) => `<span class="badge${d.status === 'active' ? ' ok' : ''}">${STATUS_LABEL[d.status]}</span>`;
const openIssues = (ledger: IssueLedger) => ledger.issues.filter((i) => i.status === 'open');
const closedIssues = (ledger: IssueLedger) => ledger.issues.filter((i) => i.status !== 'open');

// 자리별 최신 제안. 합의로 끝났으면 상세 화면의 결론을 그대로 쓴다
function proposalBox(p: ViewPage) {
  if (p.d.status !== 'active') return fold('결론', p.conclusion);
  const latest = PARTICIPANTS.map((s) => p.turns.findLast((t) => t.participant === s && t.proposal)).filter((t) => t !== undefined);
  return fold(
    '최신 제안',
    latest.length
      ? latest.map((t) => `<p><b class="seat-${t.participant}">${PARTICIPANT_NAME[t.participant]}</b> <a href="#t${esc(t.id)}">#${esc(t.id)}</a> <small>라운드 ${t.round}</small></p>${renderMarkdown(t.proposal!)}`).join('')
      : '<p class="note">아직 제안이 없습니다.</p>',
  );
}

// 결론·쟁점 상자: 테두리 위 라벨을 눌러 접고 편다. 처음엔 펼친 상태
const fold = (label: string, body: string) => `<details class="box fold" open><summary class="lbl">${label}</summary>${body}</details>`;

const extrasBox = (p: ViewPage) =>
  `<details class="box extras"${p.extrasOpen ? ' open' : ''}><summary>배경·참여 방법·관리</summary>${p.extras}</details>`;

const plain = (md: string, n = 60) => {
  const s = md.replace(/[#>*_`[\]-]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// A · 정보 위계: 현황 줄과 최신 제안을 맨 위에, 기록은 최신 라운드부터(최신만 펼침), 부가 정보는 맨 아래 하나로
function viewA(p: ViewPage) {
  const { d, turns, ledger } = p;
  const rounds = roundsOf(d, turns).reverse();
  return `${p.head}
    <div class="pv-status">
      <div><span class="k">STATUS</span>${statusBadge(d)}</div>
      <div><span class="k">ROUND</span><b>${d.current_round} / ${d.max_rounds}</b>${meter(d)}</div>
      <div><span class="k">TURN</span><b>${turnText(d, turns)}</b></div>
      <div><span class="k">ISSUES</span><b>열림 ${openIssues(ledger).length}</b> <small>· 종결 ${closedIssues(ledger).length}</small></div>
    </div>
    ${proposalBox(p)}
    ${fold('쟁점', p.issues)}
    <h2>기록</h2>
    ${rounds.length ? '' : '<p>아직 제출이 없습니다.</p>'}
    ${rounds
      .map(
        (x, i) => `<details class="pv-round"${i === 0 ? ' open' : ''}><summary>라운드 ${x.r}${roundBadges(x)}<span class="sum">쟁점 변경 ${roundChanges(x, ledger).length}건</span></summary>
      ${pair(x, d)}${roundIssueBox(x, ledger)}</details>`,
      )
      .join('')}
    ${extrasBox(p)}`;
}

// B · 분할: 왼쪽 상황판(상태·라운드 목차·쟁점·제안)은 스크롤을 따라오고, 오른쪽은 기록만 흐른다
function viewB(p: ViewPage) {
  const { d, turns, ledger } = p;
  const rounds = roundsOf(d, turns);
  const proposals = PARTICIPANTS.map((s) => turns.findLast((t) => t.participant === s && t.proposal)).filter((t) => t !== undefined);
  return `${p.head}
    <div class="pv-split"><aside class="pv-side">
      <section><span class="k">STATUS</span>${statusBadge(d)} 라운드 ${d.current_round}/${d.max_rounds}${meter(d)}<p><b>${turnText(d, turns)}</b></p></section>
      <section><span class="k">ROUNDS</span>${rounds
        .map((x) => `<a href="#r${x.r}"${x.ongoing ? ' aria-current="step"' : ''}>라운드 ${x.r}<small>${x.ongoing ? '진행 중' : `변경 ${roundChanges(x, ledger).length}`}</small></a>`)
        .join('')}</section>
      <section><span class="k">ISSUES</span><ul>${openIssues(ledger)
        .map((i) => `<li><b>${esc(i.ref)}</b> ${esc(i.title)}</li>`)
        .join('')}${closedIssues(ledger)
        .map((i) => `<li class="closed">${esc(i.ref)} ${esc(i.title)} <span class="badge">${ISSUE_STATUS_LABEL[i.status]}</span></li>`)
        .join('')}</ul>${ledger.issues.length ? '' : '<small>쟁점 없음</small>'}</section>
      <section><span class="k">PROPOSALS</span>${
        proposals.map((t) => `<a href="#t${esc(t.id)}">${PARTICIPANT_NAME[t.participant]} #${esc(t.id)}<small>라운드 ${t.round}</small></a>`).join('') || '<small>제안 없음</small>'
      }</section>
    </aside>
    <div>
      ${d.status === 'active' ? '' : proposalBox(p)}
      ${rounds.length ? '' : '<p>아직 제출이 없습니다.</p>'}
      ${rounds.map((x) => `<section class="pv-anchor" id="r${x.r}"><h3>라운드 ${x.r}${roundBadges(x)}</h3>${pair(x, d)}${roundIssueBox(x, ledger)}</section>`).join('')}
      ${fold('쟁점', p.issues)}
      ${extrasBox(p)}
    </div></div>`;
}

// C · 표: 라운드를 행, A석·B석·쟁점 변경을 열로. 주장은 한 줄 요약만 보이고 눌러야 본문이 열린다
function viewC(p: ViewPage) {
  const { d, turns, ledger } = p;
  const cell = (x: Round, s: Participant) => {
    const t = x.inRound.find((t) => t.participant === s);
    if (!t) return '<small>아직 제출 안 함</small>';
    return `<details id="t${esc(t.id)}"${pairAttr(t, d)}><summary><small>#${esc(t.id)}</small> ${esc(plain(t.proposal ?? t.content))}</summary>${renderMarkdown(t.content)}${
      t.proposal ? `<p><b>제안 #${esc(t.id)}</b></p>${renderMarkdown(t.proposal)}` : ''
    }</details>${t.agreement ? `<span class="badge">${esc(t.agreement)}</span>` : ''}${t.sign ? ' <span class="badge ok">사인</span>' : ''}`;
  };
  const issueCell = (x: Round) => {
    const lines = roundChanges(x, ledger).map((c) => `<div><b class="seat-${c.by}">${c.by}</b> ${esc(issueChangeText(c))}${flagBadges(c)}</div>`);
    const open = roundEnd(x.r, ledger).filter((s) => s.status === 'open').map((s) => s.ref);
    return `${lines.join('') || '<small>변경 없음</small>'}<div class="end">→ ${x.ongoing ? '공개 전' : open.length ? `열림 ${esc(open.join(' '))}` : '열린 쟁점 없음'}</div>`;
  };
  const rows = roundsOf(d, turns)
    .map((x) => {
      const c = x.ongoing ? ' class="cur"' : '';
      return `<tr${c}><th scope="row">R${x.r}${roundBadges(x)}</th><td>${cell(x, 'A')}</td><td>${cell(x, 'B')}</td><td>${issueCell(x)}</td></tr>`;
    })
    .join('');
  return `${p.head}
    <p class="pv-kv"><span><b>STATUS</b>${statusBadge(d)}</span><span><b>ROUND</b>${d.current_round}/${d.max_rounds}</span><span><b>TURN</b>${turnText(d, turns)}</span><span><b>OPEN</b>${
      esc(openIssues(ledger).map((i) => i.ref).join(' ')) || '-'
    }</span></p>
    ${proposalBox(p)}
    <h2>기록</h2>
    ${rows ? `<div class="pv-table"><table><thead><tr><th>R</th><th>A석</th><th>B석</th><th>쟁점 변경 → 끝 상태</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>아직 제출이 없습니다.</p>'}
    ${fold('쟁점', p.issues)}
    ${extrasBox(p)}`;
}

// D · 탭: [현황] [기록] [쟁점] [정보]. 기록은 라운드를 골라 하나씩 본다. 스크립트 없이 라디오 버튼과 CSS로 동작한다
function viewD(p: ViewPage) {
  const { d, turns, ledger } = p;
  const rounds = roundsOf(d, turns);
  const latest = rounds.at(-1);
  const tab = (n: number, label: string, checked: boolean) =>
    `<input type="radio" name="pv-tab" id="pv-t${n}"${checked ? ' checked' : ''}><label for="pv-t${n}">${label}</label>`;
  return `${p.head}
    <div class="pv-tabs">
      ${tab(1, '현황', !p.extrasOpen)}${tab(2, '기록', false)}${tab(3, `쟁점 ${openIssues(ledger).length}`, false)}${tab(4, '정보', p.extrasOpen)}
      <div class="pv-pane pv-p1">
        <p>${statusBadge(d)} 라운드 ${d.current_round}/${d.max_rounds} · <b>${turnText(d, turns)}</b>${meter(d)}</p>
        ${proposalBox(p)}
        ${latest ? `<h3>최신 라운드 ${latest.r}${roundBadges(latest)}</h3>${pair(latest, d, false)}${roundIssueBox(latest, ledger)}` : '<p>아직 제출이 없습니다.</p>'}
      </div>
      <div class="pv-pane pv-p2"><div class="pv-rounds">
        ${rounds.map((x) => `<input type="radio" name="pv-round" id="pv-r${x.r}"${x === latest ? ' checked' : ''}><label for="pv-r${x.r}">R${x.r}</label>`).join('')}
        ${rounds.map((x) => `<div class="pv-rp pv-r${x.r}"><h3>라운드 ${x.r}${roundBadges(x)}</h3>${pair(x, d)}${roundIssueBox(x, ledger)}</div>`).join('')}
      </div></div>
      <div class="pv-pane pv-p3">${p.issues}</div>
      <div class="pv-pane pv-p4">${p.extras}</div>
    </div>`;
}

// E · 타임라인: 가운데 축에 라운드를 찍고 A석은 왼쪽, B석은 오른쪽. 쟁점 변경은 두 주장 사이 축 위의 칩으로
function viewE(p: ViewPage) {
  const { d, turns, ledger } = p;
  const rounds = roundsOf(d, turns);
  const body = rounds
    .map((x, i) => {
      const last = i === rounds.length - 1;
      const chips = roundChanges(x, ledger).map(
        (c) =>
          `<span class="chip${c.conflict ? ' cf' : c.action === 'resolve' && !c.pending ? ' res' : ''}"><b class="seat-${c.by}">${c.by}</b> ${esc(issueChangeText(c))}${flagBadges(c)}</span>`,
      );
      const end = roundEnd(x.r, ledger);
      const endText = x.ongoing
        ? ''
        : `<span class="note">끝: 열림 ${esc(end.filter((s) => s.status === 'open').map((s) => s.ref).join(' ') || '없음')}</span>`;
      return `<div class="node${x.ongoing ? ' now' : ''}"><span>ROUND ${x.r}</span>${roundBadges(x)}</div>
        <div class="cols">${PARTICIPANTS.map((s) => seatCell(x, s, d, last)).join('')}</div>
        <div class="chips">${chips.join('')}${endText}</div>`;
    })
    .join('');
  return `${p.head}
    <p>${statusBadge(d)} 라운드 ${d.current_round}/${d.max_rounds} · <b>${turnText(d, turns)}</b> · 열린 쟁점 ${esc(openIssues(ledger).map((i) => i.ref).join(' ') || '없음')}</p>
    <div class="pv-line">${body || '<p>아직 제출이 없습니다.</p>'}</div>
    ${proposalBox(p)}
    ${fold('쟁점', p.issues)}
    ${extrasBox(p)}`;
}

const RENDER: Record<View, (p: ViewPage) => string> = { a: viewA, b: viewB, c: viewC, d: viewD, e: viewE };

// 요약 줄 오른쪽에 화면 보기 설정 드롭다운. 고르면 app.js가 폼을 보내 ?view=로 다시 연다
function withHead(view: View, { notices, meta, ...p }: ViewInput): ViewPage {
  const picker = `<form method="get" class="pv-view"><label for="pv-view">화면</label><span class="pv-select"><select id="pv-view" name="view" data-autosubmit>${Object.entries(VIEWS)
    .map(([k, label]) => `<option value="${k}"${k === view ? ' selected' : ''}>${label}</option>`)
    .join('')}</select></span></form>`;
  return { ...p, head: `${notices}<div class="pv-meta">${meta}${picker}</div>` };
}

export const parallelPage = (view: View, input: ViewInput) => RENDER[view](withHead(view, input));

// ---------- 순차 토론 ----------
// 턴 번호는 round에 들어 있고, 쟁점 변경은 제출 즉시 공개된다. 마지막 제안이 현재 합의안이다

// 다음 차례: 마지막 제출의 반대쪽. 아직 제출이 없으면 먼저 내는 쪽이 선공이다
function nextSeat(d: Discussion, turns: Turn[]): Participant | null {
  const last = turns.at(-1);
  return d.status === 'active' && last ? (last.participant === 'A' ? 'B' : 'A') : null;
}

function seqTurnText(d: Discussion, turns: Turn[]) {
  if (d.status !== 'active') return STATUS_LABEL[d.status];
  const next = nextSeat(d, turns);
  return next ? `${PARTICIPANT_NAME[next]} 차례` : '선공 대기';
}

const turnNo = (d: Discussion) => `${Math.min(d.current_round, d.max_rounds)}/${d.max_rounds}`;

// 진행 중이면 다음 턴 자리를 점선 상자로 보인다
function nextBox(d: Discussion, turns: Turn[]) {
  if (d.status !== 'active') return '';
  const next = nextSeat(d, turns);
  return `<div class="turn sq-next${next ? ` seat-${next}` : ''}"><b>${next ? PARTICIPANT_NAME[next] : '먼저 제출하는 쪽(선공)'}</b> <small>턴 ${d.current_round} · 아직 제출 안 함 · 차례</small></div>`;
}

const seqChanges = (t: Turn, ledger: IssueLedger) => ledger.changesByTurn[t.id] ?? [];
const openAfter = (n: number, ledger: IssueLedger) =>
  roundEnd(n, ledger)
    .filter((s) => s.status === 'open')
    .map((s) => s.ref)
    .join(' ');
const seqTurn = (t: Turn, p: ViewPage, open = true, anchor = true) => turnBox(t, p.d, seqChanges(t, p.ledger), open, anchor);
const noTurns = '<p>아직 제출이 없습니다.</p>';

// 현재 합의안(마지막 제안)과 사인 상태. 양쪽이 연속으로 사인하면 합의다. 끝났으면 결론
function seqProposalBox(p: ViewPage) {
  if (p.d.status !== 'active') return fold('결론', p.conclusion);
  const current = currentProposal(p.turns);
  if (!current) return fold('현재 합의안', '<p class="note">아직 제안이 없습니다.</p>');
  const last = p.turns.at(-1)!;
  const next = nextSeat(p.d, p.turns);
  const note = last.sign
    ? `${PARTICIPANT_NAME[last.participant]} 턴 ${last.round}에 사인 · ${next ? PARTICIPANT_NAME[next] : '상대'}가 이어서 사인하면 합의`
    : '아직 사인 없음 · 양쪽이 연속으로 사인하면 합의';
  return fold(
    `현재 합의안 #${esc(current.id)}`,
    `<p><b class="seat-${current.participant}">${PARTICIPANT_NAME[current.participant]}</b> <a href="#t${esc(current.id)}">턴 ${current.round}</a></p>${renderMarkdown(current.proposal!)}
    <p class="note">${note}</p>`,
  );
}

// A · 정보 위계: 현황 4칸·현재 합의안·제안 흐름·쟁점을 위에, 기록은 최신 턴부터(마지막 주고받기 2턴만 펼침)
function seqA(p: ViewPage) {
  const { d, turns, ledger } = p;
  const proposals = turns.filter((t) => t.proposal);
  return `${p.head}
    <div class="pv-status">
      <div><span class="k">STATUS</span>${statusBadge(d)}</div>
      <div><span class="k">TURN</span><b>${turnNo(d)}</b>${meter(d)}</div>
      <div><span class="k">NEXT</span><b>${seqTurnText(d, turns)}</b></div>
      <div><span class="k">ISSUES</span><b>열림 ${openIssues(ledger).length}</b> <small>· 종결 ${closedIssues(ledger).length}</small></div>
    </div>
    ${seqProposalBox(p)}
    ${
      proposals.length > 1
        ? `<div class="box"><span class="lbl">제안 흐름</span><p class="sq-flow">${proposals
            .map((t) => `<a href="#t${esc(t.id)}" class="seat-${t.participant}">#${esc(t.id)}</a> <small>턴 ${t.round}</small>`)
            .join(' <span>→</span> ')}</p></div>`
        : ''
    }
    ${fold('쟁점', p.issues)}
    <h2>기록</h2>${d.status === 'active' ? `<div class="sq-no">TURN ${d.current_round}</div>` : ''}${nextBox(d, turns)}
    ${turns.length ? [...turns].reverse().map((t, i) => `<div class="sq-no">TURN ${t.round}</div>${seqTurn(t, p, i < 2)}`).join('') : noTurns}
    ${extrasBox(p)}`;
}

// B · 분할: 왼쪽 상황판(상태·턴 목차·쟁점·제안)은 스크롤을 따라오고, 오른쪽은 턴 1부터 대화가 흐른다
function seqB(p: ViewPage) {
  const { d, turns, ledger } = p;
  const next = nextSeat(d, turns);
  const current = currentProposal(turns);
  return `${p.head}
    <div class="pv-split"><aside class="pv-side">
      <section><span class="k">STATUS</span>${statusBadge(d)} 턴 ${turnNo(d)}${meter(d)}<p><b>${seqTurnText(d, turns)}</b></p></section>
      <section><span class="k">TURNS</span>${turns
        .map(
          (t) =>
            `<a href="#t${esc(t.id)}"><span><b class="seat-${t.participant}">${t.participant}</b> 턴 ${t.round}</span><small>${t.proposal ? `제안 #${esc(t.id)}` : t.sign ? '사인' : ''}</small></a>`,
        )
        .join('')}${
        d.status === 'active'
          ? `<a href="#sq-next" aria-current="step"><span>${next ? `<b class="seat-${next}">${next}</b> ` : ''}턴 ${d.current_round}</span><small>차례</small></a>`
          : ''
      }</section>
      <section><span class="k">ISSUES</span><ul>${openIssues(ledger)
        .map((i) => `<li><b>${esc(i.ref)}</b> ${esc(i.title)}</li>`)
        .join('')}${closedIssues(ledger)
        .map((i) => `<li class="closed">${esc(i.ref)} ${esc(i.title)} <span class="badge">${ISSUE_STATUS_LABEL[i.status]}</span></li>`)
        .join('')}</ul>${ledger.issues.length ? '' : '<small>쟁점 없음</small>'}</section>
      <section><span class="k">PROPOSALS</span>${
        turns
          .filter((t) => t.proposal)
          .map((t) => `<a href="#t${esc(t.id)}">${PARTICIPANT_NAME[t.participant]} #${esc(t.id)}<small>${t === current ? '현재' : `턴 ${t.round}`}</small></a>`)
          .join('') || '<small>제안 없음</small>'
      }</section>
    </aside>
    <div>
      ${seqProposalBox(p)}
      ${turns.length ? turns.map((t) => `<h3>턴 ${t.round}</h3>${seqTurn(t, p)}`).join('') : noTurns}
      ${d.status === 'active' ? `<h3 id="sq-next" class="pv-anchor">턴 ${d.current_round}</h3>${nextBox(d, turns)}` : ''}
      ${fold('쟁점', p.issues)}
      ${extrasBox(p)}
    </div></div>`;
}

// C · 표: 턴을 행으로, 자리·요약(제안 또는 본문 앞부분)·쟁점 변경 → 그 턴 뒤 열린 쟁점을 열로. 다음 차례 행은 강조한다
function seqC(p: ViewPage) {
  const { d, turns, ledger } = p;
  const next = nextSeat(d, turns);
  const current = currentProposal(turns);
  const rows = turns
    .map((t) => {
      const lines = seqChanges(t, ledger).map((c) => `<div>${esc(issueChangeText(c))}${flagBadges(c)}</div>`);
      const open = openAfter(t.round, ledger);
      return `<tr><th scope="row">${t.round}</th><td><b class="seat-${t.participant}">${PARTICIPANT_NAME[t.participant]}</b></td>
        <td><details id="t${esc(t.id)}"><summary><small>#${esc(t.id)}</small> ${t.proposal ? '<b>제안</b> ' : ''}${esc(plain(t.proposal ?? t.content))}</summary>${renderMarkdown(t.content)}${
          t.proposal ? `<p><b>제안 #${esc(t.id)}</b></p>${renderMarkdown(t.proposal)}` : ''
        }</details>${t.sign ? '<span class="badge ok">사인</span>' : ''}</td>
        <td>${lines.join('') || '<small>변경 없음</small>'}<div class="end">→ ${open ? `열림 ${esc(open)}` : '열린 쟁점 없음'}</div></td></tr>`;
    })
    .join('');
  const nextRow =
    d.status === 'active'
      ? `<tr class="cur"><th scope="row">${d.current_round}</th><td>${next ? `<b class="seat-${next}">${PARTICIPANT_NAME[next]}</b>` : '선공'}</td><td><small>아직 제출 안 함 · 차례</small></td><td></td></tr>`
      : '';
  return `${p.head}
    <p class="pv-kv"><span><b>STATUS</b>${statusBadge(d)}</span><span><b>TURN</b>${turnNo(d)}</span><span><b>NEXT</b>${seqTurnText(d, turns)}</span><span><b>OPEN</b>${
      esc(openIssues(ledger).map((i) => i.ref).join(' ')) || '-'
    }</span><span><b>PROPOSAL</b>${current ? `#${esc(current.id)}` : '-'}</span></p>
    ${seqProposalBox(p)}
    <h2>기록</h2>
    ${
      rows || nextRow
        ? `<div class="pv-table sq-table"><table><thead><tr><th>턴</th><th>자리</th><th>요약</th><th>쟁점 변경 → 열린 쟁점</th></tr></thead><tbody>${rows}${nextRow}</tbody></table></div>`
        : noTurns
    }
    ${fold('쟁점', p.issues)}
    ${extrasBox(p)}`;
}

// D · 탭: [현황]은 현재 합의안과 마지막 주고받기 2턴, [기록]은 턴 번호를 골라 한 턴씩 본다. 스크립트 없이 동작한다
function seqD(p: ViewPage) {
  const { d, turns, ledger } = p;
  const last = turns.at(-1);
  const tab = (n: number, label: string, checked: boolean) =>
    `<input type="radio" name="pv-tab" id="pv-t${n}"${checked ? ' checked' : ''}><label for="pv-t${n}">${label}</label>`;
  return `${p.head}
    <div class="pv-tabs">
      ${tab(1, '현황', !p.extrasOpen)}${tab(2, '기록', false)}${tab(3, `쟁점 ${openIssues(ledger).length}`, false)}${tab(4, '정보', p.extrasOpen)}
      <div class="pv-pane pv-p1">
        <p>${statusBadge(d)} 턴 ${turnNo(d)} · <b>${seqTurnText(d, turns)}</b>${meter(d)}</p>
        ${seqProposalBox(p)}
        ${turns.length ? `<h3>마지막 주고받기</h3>${turns.slice(-2).map((t) => seqTurn(t, p, true, false)).join('')}` : noTurns}${nextBox(d, turns)}
      </div>
      <div class="pv-pane pv-p2"><div class="pv-rounds">
        ${turns
          .map((t) => `<input type="radio" name="pv-round" id="pv-r${t.round}"${t === last ? ' checked' : ''}><label for="pv-r${t.round}" class="sq-step seat-${t.participant}">${t.round}</label>`)
          .join('')}
        ${
          turns
            .map((t) => `<div class="pv-rp pv-r${t.round}"><h3>턴 ${t.round}</h3>${seqTurn(t, p)}<p class="note">이 턴 뒤 열린 쟁점: ${esc(openAfter(t.round, ledger) || '없음')}</p></div>`)
            .join('') || noTurns
        }
      </div></div>
      <div class="pv-pane pv-p3">${p.issues}</div>
      <div class="pv-pane pv-p4">${p.extras}</div>
    </div>`;
}

// E · 타임라인: 메신저처럼 A석은 왼쪽, B석은 오른쪽에 번갈아 쌓고, 턴이 바꾼 쟁점은 말풍선 사이 칩으로. 최근 2턴만 펼친다
function seqE(p: ViewPage) {
  const { d, turns, ledger } = p;
  const next = nextSeat(d, turns);
  const current = currentProposal(turns);
  const body = turns
    .map((t, i) => {
      const chips = seqChanges(t, ledger).map(
        (c) => `<span class="chip${c.conflict ? ' cf' : c.action === 'resolve' ? ' res' : ''}"><b class="seat-${c.by}">${c.by}</b> ${esc(issueChangeText(c))}${flagBadges(c)}</span>`,
      );
      return `<div class="sq-msg seat-${t.participant}"><div class="no">TURN ${t.round}</div>${turnBox(t, d, [], i >= turns.length - 2)}</div>${
        chips.length ? `<div class="chips">${chips.join('')}</div>` : ''
      }`;
    })
    .join('');
  const waiting =
    d.status === 'active'
      ? `<div class="sq-msg${next ? ` seat-${next}` : ''}"><div class="no">TURN ${d.current_round}</div><div class="sq-typing">${next ? PARTICIPANT_NAME[next] : '선공'} 차례 · 아직 제출 안 함</div></div>`
      : '';
  return `${p.head}
    <p>${statusBadge(d)} 턴 ${turnNo(d)} · <b>${seqTurnText(d, turns)}</b> · 열린 쟁점 ${esc(openIssues(ledger).map((i) => i.ref).join(' ') || '없음')}${
      current ? ` · 현재 안 <a href="#t${esc(current.id)}">#${esc(current.id)}</a>` : ''
    }</p>
    <div class="sq-chat">${body || noTurns}${waiting}</div>
    ${seqProposalBox(p)}
    ${fold('쟁점', p.issues)}
    ${extrasBox(p)}`;
}

const SEQ_RENDER: Record<View, (p: ViewPage) => string> = { a: seqA, b: seqB, c: seqC, d: seqD, e: seqE };

export const sequentialPage = (view: View, input: ViewInput) => SEQ_RENDER[view](withHead(view, input));

// 화면 방식 스타일. 라운드·턴 수 상한(순차 20)만큼 기록 탭 선택자를 만든다
const MAX_ROUNDS_CSS = 20;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
export const VIEW_STYLE = `.box{position:relative;background:var(--panel);border:1px solid var(--line);padding:1.1rem 1rem .7rem;margin:1.3rem 0;overflow-wrap:anywhere}
.box>.lbl{position:absolute;top:-.75rem;left:.7rem;background:var(--bg);padding:0 .4rem;font-family:var(--mono);font-size:.8rem;color:var(--acc);font-weight:600}
.box h3:first-child{margin-top:0}
details.fold>summary.lbl{cursor:pointer;list-style:none;display:flex;align-items:center;gap:.3rem}
details.fold>summary.lbl::-webkit-details-marker{display:none}
details.fold>summary.lbl::before{content:"▾";font-weight:400;color:var(--mute)}details.fold:not([open])>summary.lbl::before{content:"▸"}
details.fold>summary.lbl:hover::before{color:var(--acc)}
details.fold:not([open]){padding:.4rem 1rem 0;min-height:1.2rem}
.seat-A{color:var(--acc)}.seat-B{color:var(--b)}.turn.seat-A,.turn.seat-B{color:inherit}
.badge.b{color:var(--b)}
.pv-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.4rem 1rem}.pv-meta>p{margin:0}
.pv-view{display:flex;align-items:center;gap:.45rem;font-size:.82rem}.pv-view label{margin:0;color:var(--mute)}
.pv-select{position:relative;display:inline-flex}.pv-select::after{content:"▾";position:absolute;right:.5rem;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:.75rem;color:var(--mute);pointer-events:none}
.pv-select select{appearance:none;height:2rem;padding:0 1.6rem 0 .6rem;font-size:.82rem;line-height:1;border-radius:2px;cursor:pointer;transition:border-color .15s}
.pv-select select:hover{border-color:var(--acc)}.pv-select:hover::after{color:var(--acc)}
.meter{display:flex;gap:3px;margin-top:.3rem}.meter i{flex:1;height:6px;background:var(--line)}.meter i.done{background:var(--acc)}.meter i.now{background:var(--b)}
.k{display:block;font-family:var(--mono);font-size:.75rem;color:var(--mute)}
details.extras>summary{color:var(--fg);font-weight:700;min-height:44px;display:flex;align-items:center;gap:.4rem;list-style:none}
details.extras>summary::-webkit-details-marker{display:none}
details.extras>summary::before{content:"▸";font-family:var(--mono);color:var(--mute);font-weight:400}details.extras[open]>summary::before{content:"▾"}
.pv-p1 .meter{max-width:20rem}
.pv-status{display:grid;grid-template-columns:repeat(4,1fr);background:var(--panel);border:1px solid var(--line)}
.pv-status>div{padding:.6rem .9rem;border-right:1px dashed var(--line)}.pv-status>div:last-child{border-right:0}
.pv-round>summary{display:flex;align-items:center;gap:.5rem;min-height:44px;color:var(--fg);font-weight:700;border-bottom:1px dashed var(--line);list-style:none}
.pv-round>summary::-webkit-details-marker{display:none}
.pv-round>summary::before{content:"▸";font-family:var(--mono);color:var(--mute)}.pv-round[open]>summary::before{content:"▾"}
.pv-round .sum{margin-left:auto;font-weight:400;font-size:.85rem;color:var(--mute)}
.pv-split{display:grid;grid-template-columns:16rem minmax(0,1fr);gap:1.8rem;align-items:start}
.pv-side{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto;background:var(--panel);border:1px solid var(--line);font-size:.88rem}
.pv-side section{padding:.6rem .8rem;border-bottom:1px dashed var(--line)}.pv-side section:last-child{border-bottom:0}
.pv-side a{display:flex;justify-content:space-between;align-items:center;min-height:36px;padding:0 .4rem;color:var(--fg);text-decoration:none;border-left:2px solid transparent}
.pv-side a:hover{color:var(--acc)}.pv-side a[aria-current]{border-left-color:var(--acc);background:var(--hl);color:var(--acc)}
.pv-side ul{list-style:none;padding:0;margin:0}.pv-side li{padding:.1rem 0}.pv-side li.closed{color:var(--mute)}
.pv-anchor{scroll-margin-top:1rem}
.pv-kv{display:flex;flex-wrap:wrap;gap:.2rem 1.4rem;background:var(--panel);border:1px solid var(--line);padding:.5rem .8rem;font-size:.88rem}
.pv-kv b{font-family:var(--mono);font-weight:400;font-size:.78rem;color:var(--mute);margin-right:.35rem}
.pv-table{overflow-x:auto}.pv-table table{font-size:.88rem;table-layout:fixed;min-width:40rem}
.pv-table th:first-child{width:4.5rem}.pv-table th:last-child{width:30%}.pv-table tr.cur>*{background:var(--hl)}
.pv-table details{margin:0}.pv-table summary{color:var(--fg)}.pv-table .end{font-family:var(--mono);font-size:.8rem;color:var(--mute);margin-top:.2rem}
.pv-tabs{display:flex;flex-wrap:wrap;align-items:flex-end}
.pv-tabs>input,.pv-rounds>input{position:absolute;opacity:0;pointer-events:none}
.pv-tabs>label{margin:0;font-family:var(--mono);font-size:.88rem;padding:0 1rem;min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--mute);border:1px solid transparent;border-bottom:1px solid var(--line)}
.pv-tabs>input:checked+label{color:var(--acc);border-color:var(--line);border-bottom-color:transparent;background:var(--panel)}
.pv-tabs>input:focus-visible+label,.pv-rounds>input:focus-visible+label{outline:2px solid var(--acc);outline-offset:3px}
.pv-pane{display:none;order:1;width:100%;padding-top:1rem;border-top:1px solid var(--line);margin-top:-1px}
${range(4).map((n) => `#pv-t${n}:checked~.pv-p${n}`).join(',')}{display:block}
.pv-rounds{display:flex;flex-wrap:wrap;gap:.3rem}.pv-rounds>label{margin:0;font-family:var(--mono);font-size:.82rem;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--panel);cursor:pointer}
.pv-rounds>input:checked+label{border-color:var(--acc);color:var(--acc);background:var(--hl)}
.pv-rp{display:none;width:100%}
${range(MAX_ROUNDS_CSS).map((n) => `#pv-r${n}:checked~.pv-r${n}`).join(',')}{display:block}
.pv-line{position:relative}.pv-line::before{content:"";position:absolute;left:50%;top:0;bottom:0;border-left:1px dashed var(--line)}
.pv-line .node{position:relative;text-align:center;margin:1.8rem 0 .6rem}
.pv-line .node span:first-child{display:inline-block;background:var(--bg);border:1px solid var(--line);font-family:var(--mono);font-size:.8rem;padding:.1rem .7rem}
.pv-line .node.now span:first-child{border-color:var(--b);color:var(--b)}
.pv-line .cols{gap:3rem;position:relative}.pv-line .turn{margin:0}
.pv-line .chips{position:relative;display:flex;flex-direction:column;align-items:center;gap:.3rem;margin:.7rem 0}
.pv-line .chip{background:var(--panel);border:1px solid var(--line);font-size:.82rem;padding:.15rem .6rem;max-width:34rem;text-align:center}
.pv-line .chip.res{border-color:var(--acc)}.pv-line .chip.cf{border-color:var(--b)}.pv-line .chips .note{background:var(--bg);padding:0 .4rem}
.sq-next{border-style:dashed;color:inherit}.sq-no{font-family:var(--mono);font-size:.75rem;color:var(--mute);margin:.9rem 0 -.3rem}.sq-flow{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .5rem}.sq-flow>span{font-family:var(--mono);color:var(--mute)}
.sq-table th:nth-child(2){width:4.5rem}.sq-table th:last-child{width:32%}
.pv-rounds>label.sq-step{border-top-width:3px}.pv-rounds>label.seat-A{border-top-color:var(--acc)}.pv-rounds>label.seat-B{border-top-color:var(--b)}
.sq-chat .sq-msg{width:72%;color:inherit}.sq-chat .sq-msg.seat-B{margin-left:auto}.sq-chat .turn{margin:0}
.sq-chat .seat-A>.turn{border-top:1px solid var(--line);border-left:3px solid var(--acc)}.sq-chat .seat-B>.turn{border-top:1px solid var(--line);border-right:3px solid var(--b)}
.sq-chat .no{font-family:var(--mono);font-size:.75rem;color:var(--mute);margin:.9rem 0 .2rem}.sq-chat .seat-B>.no{text-align:right}
.sq-chat .chips{display:flex;flex-direction:column;align-items:center;gap:.3rem;margin:.6rem 0}
.sq-chat .chip{background:var(--panel);border:1px solid var(--line);font-size:.82rem;padding:.15rem .6rem;max-width:34rem;text-align:center}
.sq-chat .chip.res{border-color:var(--acc)}.sq-chat .chip.cf{border-color:var(--b)}
.sq-typing{border:1px dashed var(--line);padding:.6rem .9rem;color:var(--mute);font-size:.88rem}.sq-msg.seat-A .sq-typing{border-color:var(--acc)}.sq-msg.seat-B .sq-typing{border-color:var(--b)}
@media (max-width:760px){.pv-status{grid-template-columns:1fr 1fr}.pv-status>div:nth-child(2){border-right:0}
.pv-split{grid-template-columns:1fr}.pv-side{position:static;max-height:none}.pv-line::before{display:none}.pv-line .cols{gap:.6rem}.sq-chat .sq-msg{width:100%}}`;
