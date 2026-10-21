import express from 'express';
import type { Config } from '../config.js';
import { recentCleanupRuns } from '../db/cleanup.js';
import type { Db } from '../db/db.js';
import { databaseSize, listUsersWithUsage, setUserStatus } from '../db/users.js';
import { loginUrl } from './auth-routes.js';
import { csrfField, esc, page, suspendedPage } from './html.js';
import { checkCsrf, loadSession } from './session.js';

// Neon Free 프로젝트당 저장 용량
const DB_QUOTA_BYTES = 512 * 1024 * 1024;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const formatTime = (d: Date) => new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

// /admin은 admin 역할만. 다른 사용자에게는 화면이 있는지도 드러내지 않는다(404).
export function adminRouter(config: Config, db: Db) {
  const router = express.Router();

  router.use('/admin', async (req, res, next) => {
    try {
      const web = await loadSession(config, db, req);
      if (!web) {
        res.redirect(303, loginUrl(req.originalUrl));
        return;
      }
      if (web.user.status === 'suspended') {
        res.status(403).send(suspendedPage(web.csrf));
        return;
      }
      if (web.user.role !== 'admin') {
        res.status(404).send(page('없는 페이지', '<p>페이지를 찾을 수 없습니다.</p>'));
        return;
      }
      res.locals.web = web;
      next();
    } catch (e) {
      next(e);
    }
  });

  router.get('/admin', async (_req, res, next) => {
    try {
      const web = res.locals.web!;
      const [users, size, runs] = await Promise.all([listUsersWithUsage(db), databaseSize(db), recentCleanupRuns(db)]);
      const userRows = users
        .map((u) => {
          const next = u.status === 'active' ? 'suspended' : 'active';
          const action =
            u.id === web.user.id
              ? ''
              : `<form method="post" action="/admin/users/${esc(u.id)}/status" class="inline">${csrfField(web.csrf)}
                <input type="hidden" name="status" value="${next}"><button type="submit">${next === 'suspended' ? '정지' : '정지 해제'}</button></form>`;
          return `<tr><td>${esc(u.display_name)}<br><small>${esc(u.email ?? '')}</small></td><td>${u.role}</td><td>${
            u.status === 'active' ? '정상' : '정지'
          }</td><td>${u.discussions}</td><td>${u.bytes.toLocaleString('ko-KR')}</td><td>${formatTime(u.created_at)}</td><td>${action}</td></tr>`;
        })
        .join('');
      const runRows = runs
        .map(
          (r) => `<tr><td>${formatTime(r.ran_at)}</td><td>${r.error ? `<b>실패</b>: ${esc(r.error)}` : '성공'}</td><td>${esc(
            Object.entries(r.deleted)
              .map(([k, v]) => `${k} ${v}`)
              .join(', '),
          )}</td></tr>`,
        )
        .join('');
      res.send(
        page(
          '운영자',
          `
          <h2>DB 용량</h2>
          <p>${mb(size)} / ${mb(DB_QUOTA_BYTES)} (${((size / DB_QUOTA_BYTES) * 100).toFixed(1)}%)</p>
          <h2>정리 작업</h2>
          ${runs.length ? `<table><tr><th>실행</th><th>결과</th><th>삭제 건수</th></tr>${runRows}</table>` : '<p>실행 기록이 없습니다.</p>'}
          <h2>사용자</h2>
          <table><tr><th>이름</th><th>역할</th><th>상태</th><th>토론</th><th>용량(바이트)</th><th>가입</th><th></th></tr>${userRows}</table>`,
          { nav: web.user.role },
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/admin/users/:id/status', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res, next) => {
    try {
      const web = res.locals.web!;
      if (!checkCsrf(config, web, req.body?.csrf)) {
        res.status(403).send(page('요청 거부', '<p>보안 토큰이 맞지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.</p>'));
        return;
      }
      const status = req.body?.status;
      if ((status !== 'active' && status !== 'suspended') || req.params.id === web.user.id) {
        res.status(400).send(page('잘못된 요청', '<p>바꿀 수 없는 상태입니다.</p>'));
        return;
      }
      if (!(await setUserStatus(db, req.params.id, status))) {
        res.status(404).send(page('없는 사용자', '<p>사용자를 찾을 수 없습니다.</p>'));
        return;
      }
      res.redirect(303, '/admin');
    } catch (e) {
      next(e);
    }
  });

  return router;
}
