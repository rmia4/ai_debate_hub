import express, { type Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import {
  CREATE_LIMITS,
  DiscussionError,
  INPUT_LIMITS,
  RETENTION_DAYS,
  currentProposal,
  discussionsFor,
  type CreateInput,
  type Discussion,
  type Turn,
} from '../db/discussions.js';
import { deleteUser } from '../db/users.js';
import { instructionFor, PARTICIPANT_NAME } from '../instructions.js';
import { PARTICIPANTS } from '../oauth/connections.js';
import { appNav, csrfField, esc, page } from './html.js';
import { discussionMarkdown, MODE_LABEL, renderMarkdown, STATUS_LABEL } from './markdown.js';
import { checkCsrf, endSession } from './session.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_DAYS = 30;
const formBody = express.urlencoded({ extended: false, limit: '20kb' });

const formatTime = (d: Date | null) =>
  d ? new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '없음';
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

function turnBox(t: Turn, d: Discussion) {
  const badges = [
    t.agreement ? `<span class="badge">${esc(t.agreement)}${t.accepted_proposal_id ? ` → #${esc(t.accepted_proposal_id)}` : ''}</span>` : '',
    t.sign ? '<span class="badge ok">사인</span>' : '',
    d.agreed_proposal_id === t.id ? '<span class="badge ok">합의된 안</span>' : '',
  ].join(' ');
  return `<div class="turn"><p><b>${PARTICIPANT_NAME[t.participant]}</b> <small>#${esc(t.id)} · ${formatTime(t.created_at)}</small> ${badges}</p>
    ${renderMarkdown(t.content)}
    ${t.proposal ? `<p><b>제안 #${esc(t.id)}</b></p>${renderMarkdown(t.proposal)}` : ''}
    ${t.open_issues.length ? `<p>남은 이견</p><ul>${t.open_issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
}

// 동시: 라운드별 2열 비교. 웹은 진행 중 라운드의 제출도 보여 준다.
function parallelRecord(d: Discussion, turns: Turn[]) {
  const lastRound = Math.max(d.current_round, ...turns.map((t) => t.round));
  const rows: string[] = [];
  for (let r = 1; r <= lastRound; r++) {
    const inRound = turns.filter((t) => t.round === r);
    if (!inRound.length && !(d.status === 'active' && r === d.current_round)) continue;
    const ongoing = d.status === 'active' && r === d.current_round;
    const agreed = d.status === 'agreed' && r === d.current_round;
    const cell = (p: (typeof PARTICIPANTS)[number]) => {
      const t = inRound.find((x) => x.participant === p);
      return t ? turnBox(t, d) : `<div class="turn"><b>${PARTICIPANT_NAME[p]}</b> <small>아직 제출 안 함</small></div>`;
    };
    rows.push(`<h3>라운드 ${r}${ongoing ? ' <span class="badge">진행 중</span>' : ''}${agreed ? ' <span class="badge ok">합의</span>' : ''}</h3>
      <div class="cols">${PARTICIPANTS.map(cell).join('')}</div>`);
  }
  return rows.join('');
}

// 순차: 대화형 타임라인과 다음 차례
function sequentialRecord(d: Discussion, turns: Turn[]) {
  const timeline = turns.map((t) => `<h3>턴 ${t.round}</h3>${turnBox(t, d)}`).join('');
  if (d.status !== 'active') return timeline;
  const last = turns.at(-1);
  const next = last ? PARTICIPANT_NAME[last.participant === 'claude' ? 'codex' : 'claude'] : '먼저 제출하는 쪽(선공)';
  return `${timeline}<p><span class="badge">다음 차례</span> 턴 ${d.current_round}: ${next}</p>`;
}

function issuesOf(turns: Turn[]) {
  const items = PARTICIPANTS.map((p) => {
    const last = turns.findLast((t) => t.participant === p);
    return last?.open_issues.length
      ? `<li><b>${PARTICIPANT_NAME[p]}</b> (#${esc(last.id)}): <ul>${last.open_issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></li>`
      : '';
  }).join('');
  return items ? `<ul>${items}</ul>` : '<p>남은 이견이 없습니다.</p>';
}

function conclusionOf(d: Discussion, turns: Turn[]) {
  const agreed = turns.find((t) => t.id === d.agreed_proposal_id);
  if (agreed?.proposal) return `<p><span class="badge ok">${STATUS_LABEL[d.status]}</span></p>${renderMarkdown(agreed.proposal)}`;
  if (d.status === 'active' && d.mode === 'sequential') {
    const proposal = currentProposal(turns);
    return `<p><span class="badge">${STATUS_LABEL[d.status]}</span></p>${proposal ? `<p>현재 합의안 #${esc(proposal.id)}</p>${renderMarkdown(proposal.proposal!)}` : ''}`;
  }
  return `<p><span class="badge">${STATUS_LABEL[d.status]}</span></p>`;
}

function instructionsSection(d: Discussion) {
  return `<h2>참여자별 지시문</h2>
    <p>각 AI 채팅에 붙여 넣으세요. 지시문에는 인증 정보가 들어 있지 않습니다. 참여자는 연결할 때 고른 역할로 정해집니다.</p>
    ${PARTICIPANTS.map(
      (p) => `<h3>${PARTICIPANT_NAME[p]}용 <button type="button" data-copy="instr-${p}">복사</button></h3>
      <pre id="instr-${p}">${esc(instructionFor(d, p))}</pre>`,
    ).join('')}`;
}

function newForm(csrf: string, values: Record<string, string> = {}, error = '') {
  const v = (k: string) => esc(values[k] ?? '');
  const mode = values.mode === 'sequential' ? 'sequential' : 'parallel';
  return `${error ? `<p class="warn">${esc(error)}</p>` : ''}
    <p class="warn"><b>기밀이나 개인정보를 넣지 마세요.</b> 주제·배경과 AI 답변은 서버에 저장되며, 두 AI 서비스에도 전달됩니다.</p>
    <form method="post" action="/app/new">${csrfField(csrf)}
      <label>주제 (${INPUT_LIMITS.topic}자 이내)<br><input name="topic" required maxlength="${INPUT_LIMITS.topic}" size="60" value="${v('topic')}"></label>
      <label>배경 설명·제약 조건 (선택, ${INPUT_LIMITS.context}자 이내)<br><textarea name="context" maxlength="${INPUT_LIMITS.context}" rows="6" cols="60">${v('context')}</textarea></label>
      <fieldset><legend>진행 방식</legend>
        <label><input type="radio" name="mode" value="parallel"${mode === 'parallel' ? ' checked' : ''}> 동시: 매 라운드 양쪽이 한 번씩 독립적으로 답변</label>
        <label><input type="radio" name="mode" value="sequential"${mode === 'sequential' ? ' checked' : ''}> 순차: 한 턴씩 번갈아 답변, 사인 두 번으로 합의</label>
      </fieldset>
      <label>최대 라운드(동시 2~10, 기본 5) 또는 최대 턴(순차 4~20, 기본 10)<br><input name="max_rounds" type="number" min="2" max="20" value="${v('max_rounds')}"></label>
      <label>최소 라운드 (동시 방식만, 기본 2)<br><input name="min_rounds" type="number" min="2" max="10" value="${v('min_rounds')}"></label>
      <button type="submit">토론방 만들기</button>
    </form>`;
}

function parseCreate(body: Record<string, unknown>): CreateInput {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const num = (k: string) => (str(k).trim() === '' ? undefined : Number(str(k)));
  const mode = str('mode') === 'sequential' ? 'sequential' : 'parallel';
  return {
    topic: str('topic').trim(),
    context: str('context').trim(),
    mode,
    max_rounds: num('max_rounds'),
    min_rounds: mode === 'parallel' ? num('min_rounds') : undefined,
  };
}

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

  router.get('/app', async (_req, res, next) => {
    try {
      const web = res.locals.web!;
      const repo = discussionsFor(db, web.user.id);
      const [list, usage] = await Promise.all([repo.list(), repo.usage()]);
      const full = usage.stored >= CREATE_LIMITS.stored || usage.bytes >= CREATE_LIMITS.bytes;
      const rows = list
        .map(
          (d) => `<tr><td><a href="/app/d/${esc(d.id)}">${esc(d.topic)}</a></td><td>${MODE_LABEL[d.mode]}</td>
            <td>${STATUS_LABEL[d.status]}</td><td>${roundsLabel(d)}</td><td>${formatTime(d.updated_at)}</td></tr>`,
        )
        .join('');
      res.send(
        page(
          '내 토론',
          `${appNav(web.user.role)}
          <p>진행 중 ${usage.active}/${CREATE_LIMITS.active} · 보관 ${usage.stored}/${CREATE_LIMITS.stored} · 용량 ${formatBytes(usage.bytes)}/${formatBytes(CREATE_LIMITS.bytes)}</p>
          ${full ? deleteGuide : ''}
          <p><a class="btn" href="/app/new">새 토론방 만들기</a></p>
          ${list.length ? `<table><tr><th>주제</th><th>방식</th><th>상태</th><th>진행</th><th>최근 수정</th></tr>${rows}</table>` : '<p>아직 토론이 없습니다.</p>'}`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/app/new', (_req, res) => {
    const web = res.locals.web!;
    res.send(page('새 토론방', `${appNav(web.user.role)}${newForm(web.csrf)}`));
  });

  // 웹 생성도 MCP start_discussion과 같은 저장소 함수(같은 잠금·한도 검사)를 쓴다
  router.post('/app/new', formBody, async (req, res, next) => {
    const web = res.locals.web!;
    if (rejectCsrf(res, req.body?.csrf)) return;
    try {
      const d = await discussionsFor(db, web.user.id).create(parseCreate(req.body ?? {}));
      res.redirect(303, `/app/d/${d.id}?created=1`);
    } catch (e) {
      if (!(e instanceof DiscussionError) || !['invalid_settings', 'limit_exceeded'].includes(e.code)) return next(e);
      const status = e.code === 'limit_exceeded' ? 409 : 400;
      res
        .status(status)
        .send(page('새 토론방', `${appNav(web.user.role)}${e.code === 'limit_exceeded' ? deleteGuide : ''}${newForm(web.csrf, req.body ?? {}, e.message)}`));
    }
  });

  // 마크다운 내보내기. /app/d/:id보다 먼저 둔다.
  router.get('/app/d/:id.md', async (req, res, next) => {
    try {
      const { discussion, turns } = await discussionsFor(db, res.locals.web!.user.id).get(req.params.id);
      res
        .type('text/markdown; charset=utf-8')
        .attachment(`discussion-${discussion.id}.md`)
        .send(discussionMarkdown(discussion, turns));
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.get('/app/d/:id', async (req, res, next) => {
    try {
      const web = res.locals.web!;
      const { discussion: d, turns } = await discussionsFor(db, web.user.id).get(req.params.id);
      const ended = d.status !== 'active';
      const actions = ended
        ? `<form method="post" action="/app/d/${esc(d.id)}/delete">${csrfField(web.csrf)}
            <p>삭제하면 이 토론과 모든 답변이 즉시 지워지며 복구할 수 없습니다. 먼저 <a href="/app/d/${esc(d.id)}.md">내보내기</a>로 기록을 저장하세요.</p>
            <label><input type="checkbox" name="confirm" value="yes" required> 내보내기를 확인했고 삭제합니다</label>
            <button type="submit">토론 삭제</button></form>`
        : `<form method="post" action="/app/d/${esc(d.id)}/close" class="inline">${csrfField(web.csrf)}<button type="submit">강제 종료</button></form>
           <p><small>진행 중인 토론은 먼저 종료해야 삭제할 수 있습니다.</small></p>`;
      res.send(
        page(
          d.topic,
          `${appNav(web.user.role)}
          ${req.query.created ? '<p class="warn">토론방을 만들었습니다. 아래 지시문을 각 AI 채팅에 붙여 넣으세요.</p>' : ''}
          ${retentionNotice(d)}
          <p>토론 ID <code>${esc(d.id)}</code> · ${MODE_LABEL[d.mode]} 방식 · <span class="badge">${STATUS_LABEL[d.status]}</span> · ${roundsLabel(d)}${
            d.mode === 'parallel' ? ` (최소 ${d.min_rounds})` : ''
          }${d.starter ? ` · 선공 ${PARTICIPANT_NAME[d.starter]}` : ''}</p>
          ${d.context ? `<h2>배경</h2>${renderMarkdown(d.context)}` : ''}
          <h2>결론</h2>${conclusionOf(d, turns)}
          <h2>쟁점</h2>${issuesOf(turns)}
          <h2>기록</h2>${d.mode === 'parallel' ? parallelRecord(d, turns) : sequentialRecord(d, turns)}
          ${turns.length || ended ? '' : '<p>아직 제출이 없습니다.</p>'}
          <p><a href="/app/d/${esc(d.id)}.md">마크다운 내보내기</a></p>
          ${actions}
          ${ended ? '' : instructionsSection(d)}`,
        ),
      );
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
        page(
          '계정',
          `${appNav(web.user.role)}
          <p><b>${esc(web.user.display_name)}</b>${web.user.email ? ` (${esc(web.user.email)})` : ''} · 가입 ${formatTime(web.user.created_at)}</p>
          <h2>사용량</h2>
          <table>
            <tr><td>진행 중인 토론</td><td>${usage.active} / ${CREATE_LIMITS.active}</td></tr>
            <tr><td>보관 토론(종료 포함)</td><td>${usage.stored} / ${CREATE_LIMITS.stored}</td></tr>
            <tr><td>텍스트 용량(UTF-8)</td><td>${usage.bytes.toLocaleString('ko-KR')} / ${CREATE_LIMITS.bytes.toLocaleString('ko-KR')}바이트</td></tr>
            <tr><td>오늘 만든 토론</td><td>${usage.createdToday} / ${CREATE_LIMITS.perDay}</td></tr>
          </table>
          <h2>전체 기록 내보내기</h2>
          <p><a href="/app/account/export.md">모든 토론을 마크다운으로 내려받기</a></p>
          <h2>회원 탈퇴</h2>
          <p class="warn">탈퇴하면 계정, MCP 연결, 모든 토론 기록이 <b>즉시 삭제</b>되며 복구할 수 없습니다. 먼저 위에서 전체 기록을 내려받으세요.</p>
          <form method="post" action="/app/account/delete">${csrfField(web.csrf)}
            <label><input type="checkbox" name="confirm" value="yes" required> 기록을 내려받았고 탈퇴합니다</label>
            <button type="submit">회원 탈퇴</button></form>`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/app/account/export.md', async (_req, res, next) => {
    try {
      const all = await discussionsFor(db, res.locals.web!.user.id).all();
      const body = all.map(({ discussion, turns }) => discussionMarkdown(discussion, turns)).join('\n---\n\n');
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
