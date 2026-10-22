import express, { type Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import {
  CREATE_LIMITS,
  DiscussionError,
  INPUT_LIMITS,
  PARTICIPANTS,
  RETENTION_DAYS,
  currentProposal,
  discussionsFor,
  finalCrossing,
  type CreateInput,
  type Discussion,
  type ProjectRef,
  type Participant,
  type Reference,
  type Status,
  type Turn,
} from '../db/discussions.js';
import { getIssueLedger, type IssueLedger } from '../db/issues.js';
import { PROJECT_LIMITS, projectsFor, type Background } from '../db/projects.js';
import { deleteUser } from '../db/users.js';
import { crossingText, instructionFor, joinMessage, PARTICIPANT_NAME } from '../instructions.js';
import { formatTime, issueItem, parallelPage, pickView, sequentialPage, VIEW_STYLE } from './discussion-views.js';
import { csrfField, esc, page, settingsPage } from './html.js';
import { projectBackgroundsSection, projectDetailSection, projectHome } from './project-pages.js';
import {
  discussionMarkdown,
  KIND_LABEL,
  MODE_LABEL,
  projectMarkdown,
  renderMarkdown,
  STATUS_LABEL,
} from './markdown.js';
import { checkCsrf, endSession } from './session.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_DAYS = 30;
const formBody = express.urlencoded({ extended: false, limit: '20kb' });

const formatBytes = (n: number) => `${(n / 1_000_000).toFixed(2)}MB`;

// 종료 후 180일이 지나면 정리 작업이 지운다. 삭제 30일 전부터 안내한다.
function retentionNotice(d: Discussion) {
  if (!d.ended_at) return '';
  const deleteAt = new Date(new Date(d.ended_at).getTime() + RETENTION_DAYS * DAY_MS);
  const daysLeft = Math.ceil((deleteAt.getTime() - Date.now()) / DAY_MS);
  return daysLeft <= NOTICE_DAYS ? `<p class="warn">보존 기간(종료 후 ${RETENTION_DAYS}일)이 끝나 ${formatTime(deleteAt)}에 자동 삭제됩니다. 필요하면 내보내기로 저장하세요.</p>` : '';
}

const deleteGuide = `<p class="warn">보관 한도(${CREATE_LIMITS.stored}개·${formatBytes(CREATE_LIMITS.bytes)})에 도달하면 새 토론을 만들 수 없습니다.
  <a href="/app">토론 목록</a>에서 종료된 토론을 열어 <b>삭제</b>하면 한도가 다시 생깁니다. 삭제 전에 내보내기로 기록을 저장하세요.</p>`;

const roundsLabel = (d: Discussion) =>
  d.mode === 'parallel' ? `라운드 ${d.current_round}/${d.max_rounds}` : `턴 ${d.current_round}/${d.max_rounds}`;

// 목록 화면: 왼쪽에 새 토론·상태·프로젝트 필터, 오른쪽에 토론 표. 프로젝트 탭이면 범위 줄 오른쪽에 새 토론 버튼
const LIST_STYLE = `.split{display:grid;grid-template-columns:14rem 1fr;gap:2rem;align-items:start}
.list-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;margin-bottom:1rem}.list-scope{margin:0}
.side .btn{display:block;text-align:center}
.side-nav{font-size:.88rem}
.side-nav a{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:44px;padding:0 .6rem;color:var(--fg);text-decoration:none;border-left:2px solid transparent}
.side-nav a span{font-family:var(--mono);font-size:.8rem;color:var(--mute)}.side-nav a:hover{color:var(--acc)}
.side-nav a.on{border-left-color:var(--acc);background:var(--hl);color:var(--acc)}
.side-nav summary{display:flex;align-items:center;min-height:44px;padding:0 .6rem;list-style:none;cursor:pointer;font-weight:600}
.side-nav summary::-webkit-details-marker{display:none}
.side-nav summary::before{content:"▸";font-family:var(--mono);color:var(--mute);width:1.1rem;flex:none}
.side-nav details[open]>summary::before{content:"▾"}
.side-nav .sub a{margin-left:1.1rem;padding-left:.6rem}
.side-nav .note{margin:.3rem .6rem}
.side-nav summary,.side-nav a{border-bottom:1px solid var(--line)}
.split td:first-child{width:50%}.split .badge{white-space:nowrap}
.badge.b,.turn-chip{color:var(--b)}.turn-chip{font-family:var(--mono);font-size:.78rem;white-space:nowrap}
.when{font-family:var(--mono);font-size:.8rem;color:var(--mute);white-space:nowrap}
@media (max-width:760px){.split{grid-template-columns:1fr;gap:1rem}
.side-nav{display:flex;flex-wrap:wrap;gap:.3rem}.side-nav a{border:1px solid var(--line)}
.hide-sm{display:none}}
details.pj{border-top:1px solid var(--line);padding:.2rem 0 .6rem}
details.pj>summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center;gap:.4rem;list-style:none}
details.pj>summary::-webkit-details-marker{display:none}
details.pj>summary::after{content:"▸";font-family:var(--mono);font-size:1.3em;line-height:1;color:var(--mute)}
details.pj[open]>summary::after{content:"▾"}`;

// 진행 중 토론의 차례. 동시는 현재 라운드에 아직 안 낸 자리, 순차는 마지막 제출의 반대쪽
function turnChip(d: Discussion, state?: { submitted: Participant[]; last: Participant | null }) {
  if (d.status !== 'active' || !state) return '';
  const text =
    d.mode === 'parallel'
      ? state.submitted.length
        ? `${PARTICIPANTS.filter((p) => !state.submitted.includes(p)).map((p) => PARTICIPANT_NAME[p]).join('·')} 대기`
        : '양쪽 대기'
      : state.last
        ? `${PARTICIPANT_NAME[state.last === 'A' ? 'B' : 'A']} 차례`
        : '선공 대기';
  return `<br><span class="turn-chip">${text}</span>`;
}

const STATUS_BADGE: Record<Status, string> = { active: 'badge ok', agreed: 'badge', max_reached: 'badge b', closed: 'badge' };

// 쟁점 요약: 열린 쟁점을 먼저, 종결된 쟁점(종결 턴·처리한 자리별 근거·변경 이력)은 따로. 종료된 토론에서 열린 채 남은 쟁점은 미종결로 표시한다.
// 쟁점 ID가 없는 구 형식 이견(open_issues)은 자리별 마지막 제출의 것만 따로 보여 준다.
function issuesOf(d: Discussion, turns: Turn[], ledger: IssueLedger) {
  const list = (title: string, items: IssueLedger['issues']) =>
    items.length ? `<h3>${title}</h3><ul>${items.map((i) => issueItem(d, i)).join('')}</ul>` : '';
  const legacy = PARTICIPANTS.map((p) => {
    const last = turns.findLast((t) => t.participant === p);
    return last?.open_issues.length
      ? `<li><b>${PARTICIPANT_NAME[p]}</b> (#${esc(last.id)}): <ul>${last.open_issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></li>`
      : '';
  }).join('');
  const html =
    list('열린 쟁점', ledger.issues.filter((i) => i.status === 'open')) +
    list('종결된 쟁점', ledger.issues.filter((i) => i.status !== 'open')) +
    (legacy ? `<h3>구 형식 이견</h3><ul>${legacy}</ul>` : '');
  return html || '<p>남은 쟁점이 없습니다.</p>';
}

function conclusionOf(d: Discussion, turns: Turn[]) {
  const agreed = turns.find((t) => t.id === d.agreed_proposal_id);
  if (agreed?.proposal) return `<p><span class="badge ok">${STATUS_LABEL[d.status]}</span></p>${renderMarkdown(agreed.proposal)}`;
  if (d.status === 'active' && d.mode === 'sequential') {
    const proposal = currentProposal(turns);
    return `<p><span class="badge">${STATUS_LABEL[d.status]}</span></p>${proposal ? `<p>현재 합의안 #${esc(proposal.id)}</p>${renderMarkdown(proposal.proposal!)}` : ''}`;
  }
  const crossing = finalCrossing(d, turns);
  return `<p><span class="badge">${STATUS_LABEL[d.status]}</span></p>${crossing ? `<p class="warn">${esc(crossingText(crossing))}</p>` : ''}`;
}

// 참조 배경 목록. 시작 뒤 바뀐 항목은 "토론 중 수정됨", 삭제된 항목은 "삭제됨"(text 본문은 펼쳐 볼 수 있다)
function referencesSection(refs: Reference[]) {
  if (!refs.length) return '';
  const items = refs.map((r) => {
    const badges = [
      r.deleted ? '<span class="badge">삭제됨</span>' : '',
      r.revision !== r.revision_at_start ? `<span class="badge">토론 중 수정됨 r${r.revision_at_start}→r${r.revision}</span>` : '',
    ].join(' ');
    const title = r.deleted ? esc(r.title) : `<a href="/app/b/${esc(r.id)}">${esc(r.title)}</a>`;
    const where = r.location ? ` · <code>${esc(r.location)}</code>` : '';
    const body = r.body ? `<details><summary>본문</summary>${renderMarkdown(r.body)}</details>` : '';
    return `<li>${title} <small>${KIND_LABEL[r.kind]}${where}</small> ${badges}${body}</li>`;
  });
  return `<h2>참조 배경</h2><ul>${items.join('')}</ul>`;
}

function instructionsSection(d: Discussion, project: ProjectRef | null, refs: Reference[]) {
  return `<h2>참여 방법</h2>
    <p>토론할 두 AI 채팅에 아래 한 줄을 하나씩 입력하세요. 규칙은 AI가 서버에서 받아 갑니다. Claude와 Codex처럼 다른 AI여도 되고, 같은 AI의 다른 채팅이어도 됩니다. 토론 ID 대신 "세비체 토론에 A석으로 참여해"처럼 주제를 대충 말해도 되고, 진행 중인 토론이 이것 하나뿐이면 "토론 참여해, A석"이라고만 해도 됩니다.</p>
    ${PARTICIPANTS.map(
      (p) => `<h3>${PARTICIPANT_NAME[p]} <button type="button" data-copy="join-${p}">복사</button></h3>
      <pre id="join-${p}">${esc(joinMessage(d, p))}</pre>`,
    ).join('')}
    <details><summary>전체 지시문 (AI가 서버 안내를 따르지 않을 때 붙여 넣기)</summary>
    <p>지시문에는 인증 정보가 들어 있지 않습니다.</p>
    ${PARTICIPANTS.map(
      (p) => `<h3>${PARTICIPANT_NAME[p]} <button type="button" data-copy="instr-${p}">복사</button></h3>
      <pre id="instr-${p}">${esc(instructionFor(d, p, project && { project, refs }))}</pre>`,
    ).join('')}
    </details>`;
}

// 프로젝트 토론이면 참조할 배경 항목 체크박스. 기본은 모두 해제(필요한 항목만 고른다)
interface ProjectChoice {
  project: ProjectRef;
  backgrounds: Background[];
  checked?: Set<string>;
}

function backgroundChoices({ project, backgrounds, checked }: ProjectChoice) {
  const boxes = backgrounds.map(
    (b) => `<label><input type="checkbox" name="background_ids" value="${esc(b.id)}"${checked?.has(b.id) ? ' checked' : ''}>
      ${esc(b.title)} <small>${KIND_LABEL[b.kind]}${b.location ? ` · ${esc(b.location)}` : ''}</small></label>`,
  );
  return `<input type="hidden" name="project_id" value="${esc(project.id)}">
    <fieldset><legend>참조할 배경 항목 — 이 토론에 필요한 것만 고르세요 (프로젝트 <a href="${esc(projectHome(project.id))}">${esc(project.name)}</a>)</legend>
      ${boxes.length ? boxes.join('') : '<p>아직 배경 항목이 없습니다.</p>'}
    </fieldset>`;
}

function newForm(csrf: string, values: Record<string, unknown> = {}, error = '', choice: ProjectChoice | null = null) {
  const v = (k: string) => esc(typeof values[k] === 'string' ? values[k] : '');
  const mode = values.mode === 'sequential' ? 'sequential' : 'parallel';
  // 고른 방식의 설명만 보인다. 라디오를 바꾸면 app.js가 hidden과 placeholder를 바꾼다.
  const only = (m: typeof mode) => `data-mode="${m}"${m === mode ? '' : ' hidden'}`;
  const maxPlaceholder = { parallel: '기본 5', sequential: '기본 10' };
  return `${error ? `<p class="warn">${esc(error)}</p>` : ''}
    <p class="warn"><b>기밀이나 개인정보를 넣지 마세요.</b> 주제·배경과 AI 답변은 서버에 저장되며, 참여하는 AI 서비스에도 전달됩니다.</p>
    <form method="post" action="/app/new">${csrfField(csrf)}
      ${choice ? backgroundChoices(choice) : ''}
      <label>주제 (${INPUT_LIMITS.topic}자 이내)<br><input name="topic" required maxlength="${INPUT_LIMITS.topic}" size="60" value="${v('topic')}"></label>
      <label>배경 설명·제약 조건 (선택, ${INPUT_LIMITS.context}자 이내)<br><textarea name="context" maxlength="${INPUT_LIMITS.context}" rows="6" cols="60">${v('context')}</textarea></label>
      <fieldset><legend>진행 방식</legend>
        <label class="inline"><input type="radio" name="mode" value="parallel"${mode === 'parallel' ? ' checked' : ''}> 동시 (기본)</label>
        <label class="inline"><input type="radio" name="mode" value="sequential"${mode === 'sequential' ? ' checked' : ''}> 순차</label>
        <div ${only('parallel')}><b>매 라운드 A석·B석이 상대의 이번 답변을 보지 않고 각자 한 번씩 답변합니다.</b><br>
          <small>다음 라운드에서 직전 라운드의 양쪽 답변을 읽고 반박·수정안·동의를 냅니다. 같은 라운드에 양쪽이 같은 합의안에 동의하면 합의입니다. 서로의 첫 의견에 끌려가지 않는 독립 검토에 맞습니다.</small></div>
        <div ${only('sequential')}><b>한 번에 한 쪽만 답변하며 번갈아 진행합니다.</b><br>
          <small>먼저 제출한 쪽이 선공이 되어 의견과 합의안을 냅니다. 상대는 이의나 수정안을 내거나, 현재 합의안을 수정 없이 받아들이면 사인합니다. 두 턴 연속으로 사인하면 합의입니다. 하나의 안을 주고받으며 다듬는 데 맞습니다.</small></div>
      </fieldset>
      <label><span ${only('parallel')}>최대 라운드 (2~10)</span><span ${only('sequential')}>최대 턴 (4~20, 한쪽의 답변 하나가 한 턴)</span><br>
        <input name="max_rounds" type="number" min="2" max="20" value="${v('max_rounds')}" placeholder="${maxPlaceholder[mode]}" data-parallel="${maxPlaceholder.parallel}" data-sequential="${maxPlaceholder.sequential}"><br>
        <small>여기까지 합의가 안 되면 '최대 도달·합의 미확정'으로 끝납니다.</small></label>
      <div ${only('parallel')}><label>최소 라운드 (2~10)<br><input name="min_rounds" type="number" min="2" max="10" value="${v('min_rounds')}" placeholder="기본 2"><br>
        <small>이 라운드 전에는 양쪽이 동의해도 확정하지 않고 계속합니다.</small></label></div>
      <button type="submit">토론방 만들기</button>
      <a class="btn" href="${esc(choice ? projectHome(choice.project.id) : '/app')}">취소</a>
    </form>`;
}

function parseCreate(body: Record<string, unknown>): CreateInput {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const num = (k: string) => (str(k).trim() === '' ? undefined : Number(str(k)));
  const mode = str('mode') === 'sequential' ? 'sequential' : 'parallel';
  const project = str('project_id');
  return {
    topic: str('topic').trim(),
    context: str('context').trim(),
    mode,
    max_rounds: num('max_rounds'),
    min_rounds: mode === 'parallel' ? num('min_rounds') : undefined,
    // 프로젝트 토론은 체크한 항목만 참조한다(하나도 안 고르면 빈 목록)
    ...(project ? { project_id: project, background_ids: checkedIds(body) } : {}),
  };
}

const checkedIds = (body: Record<string, unknown>) =>
  ([] as unknown[]).concat(body.background_ids ?? []).filter((x): x is string => typeof x === 'string');

export function discussionPagesRouter(config: Config, db: Db) {
  const router = express.Router();

  const rejectCsrf = (res: Response, submitted: unknown) => {
    if (checkCsrf(config, res.locals.web!, submitted)) return false;
    res.status(403).send(page('요청 거부', '<p>보안 토큰이 맞지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.</p>'));
    return true;
  };
  const notFound = (res: Response) => res.status(404).send(page('없는 토론', '<p>존재하지 않는 토론입니다.</p><p><a href="/app">토론 목록</a></p>'));
  // 저장소 오류를 화면으로 바꾼다. 타인·없는 토론은 똑같이 404.
  const handle = (res: Response, next: (e: unknown) => void, e: unknown) => {
    if (!(e instanceof DiscussionError)) return next(e);
    if (e.code === 'not_found') return notFound(res);
    res.status(409).send(page('처리할 수 없음', `<p>${esc(e.message)}</p><p><a href="/app">토론 목록</a></p>`));
  };

  // ?project=<id>는 그 프로젝트의 토론, ?view=active|ended는 진행 중·종료된 토론만 보여 준다. 모르는 값은 무시한다
  router.get('/app', async (req, res, next) => {
    try {
      const web = res.locals.web!;
      const repo = discussionsFor(db, web.user.id);
      const [list, usage, projects, turns] = await Promise.all([
        repo.list(),
        repo.usage(),
        projectsFor(db, web.user.id).list(),
        repo.turnStates(),
      ]);
      const full = usage.stored >= CREATE_LIMITS.stored || usage.bytes >= CREATE_LIMITS.bytes;
      const projectName = new Map(projects.map((p) => [p.id, p.name]));
      const qs = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : '');
      const project = projectName.has(qs('project')) ? qs('project') : null;
      const view = project ? null : qs('view') === 'active' || qs('view') === 'ended' ? qs('view') : null;
      const link = (label: string, n: number, url: string, on: boolean) =>
        `<a href="${url}"${on ? ' class="on" aria-current="page"' : ''}>${esc(label)} <span>${n}</span></a>`;

      // 접히는 "프로젝트" 탭 아래 각 프로젝트 하위 탭. 그 밖에 "전체"(기본 선택)·"진행 중"·"종료". 한 번에 하나만 고른다
      const active = list.filter((d) => d.status === 'active');
      const ended = list.filter((d) => d.status !== 'active');
      const projectLinks = projects
        .map((p) => link(p.name, list.filter((d) => d.project_id === p.id).length, `/app?project=${esc(p.id)}`, project === p.id))
        .join('');

      const shown = project ? list.filter((d) => d.project_id === project) : view === 'active' ? active : view === 'ended' ? ended : list;
      const rows = shown
        .map(
          (d) => `<tr><td><a href="/app/d/${esc(d.id)}">${esc(d.topic)}</a><br><small>${
            d.project_id ? `<a href="${esc(projectHome(d.project_id))}">${esc(projectName.get(d.project_id) ?? '')}</a> · ` : ''
          }${MODE_LABEL[d.mode]}</small></td>
            <td><span class="${STATUS_BADGE[d.status]}">${STATUS_LABEL[d.status]}</span>${turnChip(d, turns.get(d.id))}</td>
            <td class="when hide-sm">${roundsLabel(d)}</td><td class="hide-sm"><small>${formatTime(d.updated_at)}</small></td></tr>`,
        )
        .join('');
      const scope = project ? projectName.get(project)! : view === 'active' ? '진행 중' : view === 'ended' ? '종료' : '';
      const table = shown.length
        ? `<table><tr><th>주제</th><th>상태</th><th class="hide-sm">진행</th><th class="hide-sm">최근 수정</th></tr>${rows}</table>`
        : `<p>${list.length ? '조건에 맞는 토론이 없습니다.' : '아직 토론이 없습니다.'}</p>`;
      // 프로젝트 탭은 정보·설정, 배경 항목, 토론 표를 접이식 구역으로 보여 준다
      let body = table;
      if (project) {
        const { project: p, backgrounds } = await projectsFor(db, web.user.id).get(project);
        body = `<details class="pj"><summary>프로젝트 정보·설정</summary>${projectDetailSection(web.csrf, p)}</details>
            <details class="pj" open><summary>배경 항목 (${backgrounds.length}/${PROJECT_LIMITS.backgrounds})</summary>${projectBackgroundsSection(p, backgrounds)}</details>
            <details class="pj" open><summary>토론 (${shown.length})</summary>${shown.length ? table : '<p>아직 이 프로젝트의 토론이 없습니다.</p>'}</details>`;
      }

      res.send(
        page(
          '토론 목록',
          `<div class="split">
          <aside class="side">
            <a class="btn fill" href="/app/new">새 토론방</a>
            <div class="side-nav" role="navigation" aria-label="토론 거르기">
              <details open><summary>프로젝트</summary><div class="sub">${projectLinks}
              <a href="/app/projects/new">+ 새 프로젝트</a></div></details>
              ${link('전체', list.length, '/app', !project && !view)}
              ${link('진행 중', active.length, '/app?view=active', view === 'active')}
              ${link('종료', ended.length, '/app?view=ended', view === 'ended')}
              ${projects.length ? '' : '<p class="note">프로젝트를 만들면 여러 토론이 긴 배경 자료를 함께 참조할 수 있습니다.</p>'}
            </div>
          </aside>
          <div>
            <div class="list-head"><p class="note list-scope">${scope ? `${esc(scope)} · ` : ''}${shown.length}개 · 최근 수정 순</p>
              ${project ? `<a class="btn" href="/app/new?project=${esc(project)}">이 프로젝트에서 새 토론</a>` : ''}</div>
            ${full ? deleteGuide : ''}
            ${body}
          </div>
          </div>`,
          { nav: web, head: LIST_STYLE },
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  // ?project=<id>이면 그 프로젝트의 배경 항목을 고르는 칸을 더한다
  const projectChoice = async (userId: string, projectId: string, checked?: Set<string>): Promise<ProjectChoice> => {
    const { project, backgrounds } = await projectsFor(db, userId).get(projectId);
    return { project, backgrounds, checked };
  };

  router.get('/app/new', async (req, res, next) => {
    const web = res.locals.web!;
    try {
      const choice = typeof req.query.project === 'string' ? await projectChoice(web.user.id, req.query.project) : null;
      res.send(page('새 토론방', `${newForm(web.csrf, {}, '', choice)}`, { nav: web }));
    } catch (e) {
      handle(res, next, e);
    }
  });

  // 웹 생성도 MCP start_discussion과 같은 저장소 함수(같은 잠금·한도 검사)를 쓴다
  router.post('/app/new', formBody, async (req, res, next) => {
    const web = res.locals.web!;
    if (rejectCsrf(res, req.body?.csrf)) return;
    try {
      const d = await discussionsFor(db, web.user.id).create(parseCreate(req.body ?? {}));
      res.redirect(303, `/app/d/${d.id}?created=1`);
    } catch (e) {
      if (!(e instanceof DiscussionError) || !['invalid_settings', 'limit_exceeded'].includes(e.code)) return handle(res, next, e);
      const status = e.code === 'limit_exceeded' ? 409 : 400;
      const body = req.body ?? {};
      try {
        const choice = typeof body.project_id === 'string' && body.project_id ? await projectChoice(web.user.id, body.project_id, new Set(checkedIds(body))) : null;
        res
          .status(status)
          .send(page('새 토론방', `${e.code === 'limit_exceeded' ? deleteGuide : ''}${newForm(web.csrf, body, e.message, choice)}`, { nav: web }));
      } catch (e2) {
        handle(res, next, e2);
      }
    }
  });

  // 마크다운 내보내기. /app/d/:id보다 먼저 둔다.
  router.get('/app/d/:id.md', async (req, res, next) => {
    try {
      const { discussion, turns, issueEvents, refs } = await discussionsFor(db, res.locals.web!.user.id).get(req.params.id);
      res
        .type('text/markdown; charset=utf-8')
        .attachment(`discussion-${discussion.id}.md`)
        .send(discussionMarkdown(discussion, turns, issueEvents, refs));
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.get('/app/d/:id', async (req, res, next) => {
    try {
      const web = res.locals.web!;
      const snapshot = await discussionsFor(db, web.user.id).get(req.params.id);
      const { discussion: d, turns, project, refs } = snapshot;
      const ledger = getIssueLedger(snapshot, 'web');
      const ended = d.status !== 'active';
      const actions = ended
        ? `<form method="post" action="/app/d/${esc(d.id)}/delete">${csrfField(web.csrf)}
            <p>삭제하면 이 토론과 모든 답변이 즉시 지워지며 복구할 수 없습니다. 먼저 <a href="/app/d/${esc(d.id)}.md">내보내기</a>로 기록을 저장하세요.</p>
            <label><input type="checkbox" name="confirm" value="yes" required> 내보내기를 확인했고 삭제합니다</label>
            <button type="submit">토론 삭제</button></form>`
        : `<form method="post" action="/app/d/${esc(d.id)}/close" class="inline">${csrfField(web.csrf)}<button type="submit">강제 종료</button></form>
           <p><small>진행 중인 토론은 먼저 종료해야 삭제할 수 있습니다.</small></p>`;
      const created = Boolean(req.query.created);
      const notices = `
          ${created ? '<p class="warn">토론방을 만들었습니다. 아래 참여 문구를 각 AI 채팅에 입력하세요.</p>' : ''}
          ${retentionNotice(d)}`;
      const meta = `<p>토론 ID <code>${esc(d.id)}</code> · ${MODE_LABEL[d.mode]} 방식 · <span class="badge">${STATUS_LABEL[d.status]}</span> · ${roundsLabel(d)}${
            d.mode === 'parallel' ? ` (최소 ${d.min_rounds})` : ''
          }${d.starter ? ` · 선공 ${PARTICIPANT_NAME[d.starter]}` : ''}${
            project ? ` · 프로젝트 <a href="${esc(projectHome(project.id))}">${esc(project.name)}</a>` : ''
          }</p>`;
      const background = `${d.context ? `<h2>배경</h2>${renderMarkdown(d.context)}` : ''}
          ${referencesSection(refs)}`;
      const manage = `<p><a href="/app/d/${esc(d.id)}.md">마크다운 내보내기</a></p>
          ${actions}
          ${ended ? '' : instructionsSection(d, project, refs)}`;
      // 동시·순차 모두 사용자가 고른 화면 방식으로 보인다
      const input = {
        d,
        turns,
        ledger,
        notices,
        meta,
        issues: issuesOf(d, turns, ledger),
        conclusion: conclusionOf(d, turns),
        extras: `${background}${manage}`,
        extrasOpen: created,
      };
      const view = pickView(req, res);
      const body = d.mode === 'parallel' ? parallelPage(view, input) : sequentialPage(view, input);
      res.send(page(d.topic, body, { nav: web, head: VIEW_STYLE }));
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.post('/app/d/:id/close', formBody, async (req, res, next) => {
    if (rejectCsrf(res, req.body?.csrf)) return;
    try {
      await discussionsFor(db, res.locals.web!.user.id).close(req.params.id);
      res.redirect(303, `/app/d/${req.params.id}`);
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.post('/app/d/:id/delete', formBody, async (req, res, next) => {
    if (rejectCsrf(res, req.body?.csrf)) return;
    if (req.body?.confirm !== 'yes') {
      res.status(400).send(page('확인 필요', `<p>삭제 확인란을 선택해 주세요.</p><p><a href="/app/d/${esc(req.params.id)}">돌아가기</a></p>`));
      return;
    }
    try {
      await discussionsFor(db, res.locals.web!.user.id).remove(req.params.id);
      res.redirect(303, '/app');
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.get('/app/account', async (_req, res, next) => {
    try {
      const web = res.locals.web!;
      const usage = await discussionsFor(db, web.user.id).usage();
      res.send(
        settingsPage(
          'account',
          `
          <p><b>${esc(web.user.display_name)}</b>${web.user.email ? ` (${esc(web.user.email)})` : ''} · 가입 ${formatTime(web.user.created_at)}</p>
          <h2>사용량</h2>
          <table>
            <tr><td>진행 중인 토론</td><td>${usage.active} / ${CREATE_LIMITS.active}</td></tr>
            <tr><td>보관 토론(종료 포함)</td><td>${usage.stored} / ${CREATE_LIMITS.stored}</td></tr>
            <tr><td>텍스트 용량(UTF-8, 배경 항목 포함)</td><td>${usage.bytes.toLocaleString('ko-KR')} / ${CREATE_LIMITS.bytes.toLocaleString('ko-KR')}바이트</td></tr>
            <tr><td>그중 삭제됐지만 과거 토론 기록 때문에 보관 중인 배경 용량</td><td>${usage.retainedBytes.toLocaleString('ko-KR')}바이트</td></tr>
            <tr><td>오늘 만든 토론</td><td>${usage.createdToday} / ${CREATE_LIMITS.perDay}</td></tr>
          </table>
          <h2>전체 기록 내보내기</h2>
          <p><a href="/app/account/export.md">모든 프로젝트와 토론을 마크다운으로 내려받기</a></p>
          <h2>회원 탈퇴</h2>
          <p class="warn">탈퇴하면 계정, MCP 연결, 모든 토론 기록이 <b>즉시 삭제</b>되며 복구할 수 없습니다. 먼저 위에서 전체 기록을 내려받으세요.</p>
          <form method="post" action="/app/account/delete">${csrfField(web.csrf)}
            <label><input type="checkbox" name="confirm" value="yes" required> 기록을 내려받았고 탈퇴합니다</label>
            <button type="submit">회원 탈퇴</button></form>`,
          web,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/app/account/export.md', async (_req, res, next) => {
    try {
      const userId = res.locals.web!.user.id;
      const [projects, all] = await Promise.all([projectsFor(db, userId).all(), discussionsFor(db, userId).all()]);
      const body = [
        ...projects.map(({ project, backgrounds }) => projectMarkdown(project, backgrounds)),
        ...all.map(({ discussion, turns, issueEvents, refs }) => discussionMarkdown(discussion, turns, issueEvents, refs)),
      ].join('\n---\n\n');
      res
        .type('text/markdown; charset=utf-8')
        .attachment('ai-debate-hub-export.md')
        .send(body || '# 토론 기록 없음\n');
    } catch (e) {
      next(e);
    }
  });

  router.post('/app/account/delete', formBody, async (req, res, next) => {
    const web = res.locals.web!;
    if (rejectCsrf(res, req.body?.csrf)) return;
    if (req.body?.confirm !== 'yes') {
      res.status(400).send(page('확인 필요', '<p>탈퇴 확인란을 선택해 주세요.</p><p><a href="/app/account">돌아가기</a></p>'));
      return;
    }
    try {
      await deleteUser(db, web.user.id);
      await endSession(db, res, web);
      res.send(page('탈퇴 완료', '<p>계정과 모든 기록을 삭제했습니다. 이용해 주셔서 감사합니다.</p>'));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
