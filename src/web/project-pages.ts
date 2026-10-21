import express, { type Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { DiscussionError } from '../db/discussions.js';
import { BACKGROUND_KINDS, PROJECT_INPUT_LIMITS as L, PROJECT_LIMITS, projectsFor, type Background, type BackgroundKind } from '../db/projects.js';
import { csrfField, esc, page } from './html.js';
import { KIND_LABEL, renderMarkdown, STATUS_LABEL } from './markdown.js';
import { checkCsrf } from './session.js';

const formBody = express.urlencoded({ extended: false, limit: '20kb' });
// 배경 저장 경로만 크게 둔다. 한글 5만 자를 URL 인코딩하면 약 450KB다
const backgroundBody = express.urlencoded({ extended: false, limit: '600kb' });

const WEB_EDITOR = '웹';
const FILE_NOTE = 'file 항목은 참여 AI가 이 파일이 있는 컴퓨터에서 실행 중이어야 읽을 수 있습니다. 서버는 링크·파일의 내용을 가져오지 않습니다.';

const formatTime = (d: Date | null) =>
  d ? new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '없음';

const str = (body: Record<string, unknown>, k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');

function projectForm(csrf: string, action: string, values: Record<string, unknown>, submit: string) {
  return `<form method="post" action="${action}">${csrfField(csrf)}
      <label>이름 (${L.name}자 이내)<br><input name="name" required maxlength="${L.name}" size="60" value="${esc(str(values, 'name'))}"></label>
      <label>설명 (선택, ${L.description}자 이내)<br><textarea name="description" maxlength="${L.description}" rows="4" cols="60">${esc(str(values, 'description'))}</textarea></label>
      <button type="submit">${submit}</button>
    </form>`;
}

// 종류에 맞는 칸만 읽는다: text는 body, link·file은 location
function parseBackground(kind: BackgroundKind, body: Record<string, unknown>) {
  return {
    title: str(body, 'title'),
    summary: str(body, 'summary'),
    ...(kind === 'text' ? { body: str(body, 'body') } : { location: str(body, 'location') }),
  };
}

function backgroundFields(values: Record<string, unknown>, kind: BackgroundKind | null) {
  const v = (k: string) => esc(str(values, k));
  return `<label>제목 (${L.title}자 이내)<br><input name="title" required maxlength="${L.title}" size="60" value="${v('title')}"></label>
      <label>요약 (선택, ${L.summary}자 이내. AI가 열기 전에 필요한지 판단하는 한 줄 설명)<br><input name="summary" maxlength="${L.summary}" size="60" value="${v('summary')}"></label>
      ${kind === null || kind === 'text' ? `<label>본문 (text만, ${L.body.toLocaleString('ko-KR')}자 이내)<br><textarea name="body" maxlength="${L.body}" rows="16" cols="60">${v('body')}</textarea></label>` : ''}
      ${kind === null || kind !== 'text' ? `<label>위치 (link는 http·https URL, file은 C:\\…·/… 같은 절대경로)<br><input name="location" maxlength="${L.location}" size="60" value="${v('location')}"></label>` : ''}`;
}

function newBackgroundForm(csrf: string, projectId: string, values: Record<string, unknown> = {}, error = '') {
  const kind = BACKGROUND_KINDS.includes(values.kind as BackgroundKind) ? (values.kind as BackgroundKind) : 'text';
  return `${error ? `<p class="warn">${esc(error)}</p>` : ''}
    <p class="warn"><b>기밀이나 개인정보를 넣지 마세요.</b> text 본문은 서버에 저장되고 참여하는 AI 서비스에 전달됩니다. ${FILE_NOTE}</p>
    <form method="post" action="/app/p/${esc(projectId)}/backgrounds/new">${csrfField(csrf)}
      <fieldset><legend>종류</legend>
        ${BACKGROUND_KINDS.map(
          (k) => `<label><input type="radio" name="kind" value="${k}"${k === kind ? ' checked' : ''}> ${k} (${KIND_LABEL[k]})</label>`,
        ).join('')}
      </fieldset>
      ${backgroundFields(values, null)}
      <button type="submit">배경 추가</button>
    </form>`;
}

function backgroundRows(list: Background[]) {
  return list
    .map(
      (b) => `<tr><td><a href="/app/b/${esc(b.id)}">${esc(b.title)}</a></td><td>${KIND_LABEL[b.kind]}</td>
        <td>${b.location ? `<code>${esc(b.location)}</code>` : esc(b.summary)}</td><td>r${b.revision}</td>
        <td>${formatTime(b.updated_at)}</td><td>${esc(b.updated_by)}</td></tr>`,
    )
    .join('');
}

// 구조와 오류 처리는 discussionPagesRouter를 따른다. 남의 프로젝트·항목은 없는 것과 같은 404다.
export function projectPagesRouter(config: Config, db: Db) {
  const router = express.Router();

  const rejectCsrf = (res: Response, submitted: unknown) => {
    if (checkCsrf(config, res.locals.web!, submitted)) return false;
    res.status(403).send(page('요청 거부', '<p>보안 토큰이 맞지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.</p>'));
    return true;
  };
  const notFound = (res: Response) => res.status(404).send(page('없는 항목', '<p>존재하지 않는 프로젝트 또는 배경 항목입니다.</p><p><a href="/app">목록</a></p>'));
  const handle = (res: Response, next: (e: unknown) => void, e: unknown) => {
    if (!(e instanceof DiscussionError)) return next(e);
    if (e.code === 'not_found') return notFound(res);
    const status = e.code === 'invalid_settings' ? 400 : 409;
    res.status(status).send(page('처리할 수 없음', `<p>${esc(e.message)}</p><p><a href="/app">목록</a></p>`));
  };
  const needConfirm = (res: Response, back: string) =>
    res.status(400).send(page('확인 필요', `<p>삭제 확인란을 선택해 주세요.</p><p><a href="${esc(back)}">돌아가기</a></p>`));

  router.get('/app/projects/new', (_req, res) => {
    const web = res.locals.web!;
    res.send(page('새 프로젝트', `<p>프로젝트는 사용자당 ${PROJECT_LIMITS.projects}개까지 만들 수 있습니다.</p>${projectForm(web.csrf, '/app/projects/new', {}, '프로젝트 만들기')}`, { nav: web.user.role }));
  });

  router.post('/app/projects/new', formBody, async (req, res, next) => {
    const web = res.locals.web!;
    if (rejectCsrf(res, req.body?.csrf)) return;
    const body = req.body ?? {};
    try {
      const p = await projectsFor(db, web.user.id).create({ name: str(body, 'name').trim(), description: str(body, 'description').trim() });
      res.redirect(303, `/app/p/${p.id}`);
    } catch (e) {
      if (!(e instanceof DiscussionError) || !['invalid_settings', 'limit_exceeded'].includes(e.code)) return handle(res, next, e);
      res
        .status(e.code === 'limit_exceeded' ? 409 : 400)
        .send(page('새 프로젝트', `<p class="warn">${esc(e.message)}</p>${projectForm(web.csrf, '/app/projects/new', body, '프로젝트 만들기')}`, { nav: web.user.role }));
    }
  });

  router.get('/app/p/:id', async (req, res, next) => {
    try {
      const web = res.locals.web!;
      const { project: p, backgrounds, discussions } = await projectsFor(db, web.user.id).get(req.params.id);
      const id = esc(p.id);
      const discussionRows = discussions
        .map((d) => `<tr><td><a href="/app/d/${esc(d.id)}">${esc(d.topic)}</a></td><td>${STATUS_LABEL[d.status]}</td><td>${formatTime(d.updated_at)}</td></tr>`)
        .join('');
      res.send(
        page(
          p.name,
          `
          <p>프로젝트 ID <code>${id}</code></p>
          ${p.description ? renderMarkdown(p.description) : ''}
          <h2>배경 항목 (${backgrounds.length}/${PROJECT_LIMITS.backgrounds})</h2>
          <p><a class="btn" href="/app/p/${id}/backgrounds/new">배경 추가</a> <a class="btn" href="/app/new?project=${id}">이 프로젝트에서 새 토론</a></p>
          <p><small>${FILE_NOTE}</small></p>
          ${backgrounds.length ? `<table><tr><th>제목</th><th>종류</th><th>요약 또는 위치</th><th>revision</th><th>최근 수정</th><th>수정한 쪽</th></tr>${backgroundRows(backgrounds)}</table>` : '<p>아직 배경 항목이 없습니다.</p>'}
          <h2>토론</h2>
          ${discussions.length ? `<table><tr><th>주제</th><th>상태</th><th>최근 수정</th></tr>${discussionRows}</table>` : '<p>아직 이 프로젝트의 토론이 없습니다.</p>'}
          <h2>프로젝트 수정</h2>
          ${projectForm(web.csrf, `/app/p/${id}/edit`, p as unknown as Record<string, unknown>, '저장')}
          <h2>프로젝트 삭제</h2>
          <form method="post" action="/app/p/${id}/delete">${csrfField(web.csrf)}
            <p>삭제하면 이 프로젝트의 배경 항목과 <b>종료된 토론 기록까지 모두</b> 즉시 지워지며 복구할 수 없습니다. 진행 중인 토론이 있으면 삭제할 수 없습니다. 먼저 <a href="/app/account/export.md">내보내기</a>로 기록을 저장하세요.</p>
            <label><input type="checkbox" name="confirm" value="yes" required> 종료된 토론까지 함께 삭제됨을 확인했습니다</label>
            <button type="submit">프로젝트 삭제</button></form>`,
          { nav: web.user.role },
        ),
      );
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.post('/app/p/:id/edit', formBody, async (req, res, next) => {
    if (rejectCsrf(res, req.body?.csrf)) return;
    const body = req.body ?? {};
    try {
      await projectsFor(db, res.locals.web!.user.id).update(req.params.id, { name: str(body, 'name').trim(), description: str(body, 'description').trim() });
      res.redirect(303, `/app/p/${req.params.id}`);
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.post('/app/p/:id/delete', formBody, async (req, res, next) => {
    if (rejectCsrf(res, req.body?.csrf)) return;
    if (req.body?.confirm !== 'yes') return void needConfirm(res, `/app/p/${req.params.id}`);
    try {
      await projectsFor(db, res.locals.web!.user.id).remove(req.params.id);
      res.redirect(303, '/app');
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.get('/app/p/:id/backgrounds/new', async (req, res, next) => {
    try {
      const web = res.locals.web!;
      const { project } = await projectsFor(db, web.user.id).get(req.params.id);
      res.send(page(`배경 추가 · ${project.name}`, `${newBackgroundForm(web.csrf, project.id)}`, { nav: web.user.role }));
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.post('/app/p/:id/backgrounds/new', backgroundBody, async (req, res, next) => {
    const web = res.locals.web!;
    if (rejectCsrf(res, req.body?.csrf)) return;
    const body = req.body ?? {};
    const kind = str(body, 'kind') as BackgroundKind;
    try {
      if (!BACKGROUND_KINDS.includes(kind)) throw new DiscussionError('invalid_settings', '종류를 고르세요');
      await projectsFor(db, web.user.id).addBackground(req.params.id, { kind, ...parseBackground(kind, body) }, WEB_EDITOR);
      res.redirect(303, `/app/p/${req.params.id}`);
    } catch (e) {
      if (!(e instanceof DiscussionError) || !['invalid_settings', 'limit_exceeded'].includes(e.code)) return handle(res, next, e);
      res
        .status(e.code === 'limit_exceeded' ? 409 : 400)
        .send(page('배경 추가', `${newBackgroundForm(web.csrf, req.params.id, body, e.message)}`, { nav: web.user.role }));
    }
  });

  router.get('/app/b/:bid', async (req, res, next) => {
    try {
      const web = res.locals.web!;
      const b = await projectsFor(db, web.user.id).getBackground(req.params.bid);
      const id = esc(b.id);
      const content =
        b.kind === 'text'
          ? `<h2>본문</h2>${b.body ? renderMarkdown(b.body) : '<p>(비어 있음)</p>'}`
          : `<h2>위치</h2><p><code>${esc(b.location)}</code></p><p><small>${FILE_NOTE}</small></p>`;
      res.send(
        page(
          b.title,
          `
          <p><a href="/app/p/${esc(b.project_id)}">프로젝트로</a> · 항목 ID <code>${id}</code> · ${KIND_LABEL[b.kind]} · r${b.revision} · ${formatTime(b.updated_at)} ${esc(b.updated_by)}</p>
          ${b.summary ? `<p>${esc(b.summary)}</p>` : ''}
          ${content}
          <h2>수정</h2>
          <form method="post" action="/app/b/${id}">${csrfField(web.csrf)}
            <input type="hidden" name="revision" value="${b.revision}">
            ${backgroundFields(b as unknown as Record<string, unknown>, b.kind)}
            <button type="submit">저장</button>
          </form>
          <h2>삭제</h2>
          <form method="post" action="/app/b/${id}/delete">${csrfField(web.csrf)}
            <p>진행 중인 토론이 참조하면 삭제할 수 없습니다. 종료된 토론이 참조하면 목록에서만 사라지고, 그 토론 기록에는 "삭제됨"으로 남습니다.</p>
            <label><input type="checkbox" name="confirm" value="yes" required> 이 항목을 삭제합니다</label>
            <button type="submit">항목 삭제</button></form>`,
          { nav: web.user.role },
        ),
      );
    } catch (e) {
      handle(res, next, e);
    }
  });

  // hidden revision으로 그사이 다른 쪽(AI 포함)이 고친 내용을 덮어쓰지 않는다
  router.post('/app/b/:bid', backgroundBody, async (req, res, next) => {
    if (rejectCsrf(res, req.body?.csrf)) return;
    const body = req.body ?? {};
    try {
      const repo = projectsFor(db, res.locals.web!.user.id);
      const cur = await repo.getBackground(req.params.bid);
      await repo.updateBackground(cur.id, Number(str(body, 'revision')), parseBackground(cur.kind, body), WEB_EDITOR);
      res.redirect(303, `/app/b/${cur.id}`);
    } catch (e) {
      handle(res, next, e);
    }
  });

  router.post('/app/b/:bid/delete', formBody, async (req, res, next) => {
    if (rejectCsrf(res, req.body?.csrf)) return;
    if (req.body?.confirm !== 'yes') return void needConfirm(res, `/app/b/${req.params.bid}`);
    try {
      const repo = projectsFor(db, res.locals.web!.user.id);
      const { project_id } = await repo.getBackground(req.params.bid);
      await repo.removeBackground(req.params.bid);
      res.redirect(303, `/app/p/${project_id}`);
    } catch (e) {
      handle(res, next, e);
    }
  });

  return router;
}
