import express, { type Request, type Response, type NextFunction } from 'express';
import type Provider from 'oidc-provider';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { loginUrl } from '../web/auth-routes.js';
import { esc, page, suspendedPage } from '../web/html.js';
import { checkCsrf, loadSession, type WebSession } from '../web/session.js';
import { findActiveConnection, replaceConnection } from './connections.js';
import { LOOPBACK_HOSTS, MCP_SCOPE } from './provider.js';

// provider의 scopes 설정에 든 값은 OIDC 범위로도 승인해야 동의 프롬프트가 다시 뜨지 않는다
const OIDC_SCOPES = new Set(['openid', 'offline_access', MCP_SCOPE]);

export function interactionRouter(provider: Provider, config: Config, db: Db) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '10kb' }));
  // oidc-provider는 Koa 기반이라 응답 헤더를 직접 다룬다
  router.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  // 로그인은 웹 세션으로만 한다. 세션이 없으면 로그인 화면을 거쳐 이 화면으로 돌아온다.
  // 정지 계정, oidc-provider 세션과 다른 계정이면 진행하지 않는다. 화면을 보냈으면 undefined.
  async function requireUser(req: Request, res: Response, uid: string, sessionAccountId?: string) {
    const web = await loadSession(config, db, req);
    if (!web) {
      res.redirect(303, loginUrl(`/oauth/interaction/${uid}`));
      return undefined;
    }
    if (web.user.status === 'suspended') {
      res.status(403).send(suspendedPage(web.csrf));
      return undefined;
    }
    if (sessionAccountId && sessionAccountId !== web.user.id) {
      res.status(400).send(page('계정 불일치', '<p>다른 계정으로 시작된 연결 요청입니다. 앱에서 연결을 다시 시작해 주세요.</p>'));
      return undefined;
    }
    return web;
  }

  function rejectCsrf(res: Response, web: WebSession, submitted: unknown) {
    if (checkCsrf(config, web, submitted)) return false;
    res.status(403).send(page('요청 거부', '<p>보안 토큰이 맞지 않습니다. 앱에서 연결을 다시 시작해 주세요.</p>'));
    return true;
  }

  router.get('/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const web = await requireUser(req, res, details.uid, details.session?.accountId);
      if (!web) return;
      const client = await provider.Client.find(String(details.params.client_id));
      if (!client) throw new Error('unknown client');
      const clientName = client.clientName ?? client.clientId;

      const redirectHosts = client.redirectUris?.map((u) => new URL(u).host) ?? [];
      const loopbackOnly =
        (client.redirectUris?.length ?? 0) > 0 &&
        client.redirectUris!.every((u) => LOOPBACK_HOSTS.has(new URL(u).hostname));
      const existing = await findActiveConnection(db, web.user.id, client.clientId);
      const csrf = `<input type="hidden" name="csrf" value="${esc(web.csrf)}">`;

      res.send(
        page(
          '연결 허용',
          `<p><b>${esc(clientName)}</b>이(가) <b>${esc(web.user.display_name)}</b> 계정으로 토론 도구를 쓰려고 합니다.</p>
          <p>돌아갈 주소: ${redirectHosts.map(esc).join(', ')}</p>
          ${
            loopbackOnly
              ? `<p class="warn">이 연결은 현재 기기의 로컬 앱으로 돌아갑니다(${redirectHosts.map(esc).join(', ')}). 직접 시작한 연결인지 확인한 뒤 허용하세요.</p>`
              : ''
          }
          ${existing ? `<p><small>이 앱의 기존 연결을 새 연결로 교체합니다.</small></p>` : ''}
          <form method="post" action="/oauth/interaction/${esc(details.uid)}/consent">
            ${csrf}
            <button type="submit">허용</button>
          </form>
          <form method="post" action="/oauth/interaction/${esc(details.uid)}/abort">${csrf}<button type="submit">거부</button></form>`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/:uid/consent', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const web = await requireUser(req, res, details.uid, details.session?.accountId);
      if (!web || rejectCsrf(res, web, req.body.csrf)) return;
      const clientId = String(details.params.client_id);
      const client = await provider.Client.find(clientId);
      if (!client) throw new Error('unknown client');
      const accountId = web.user.id;
      const grant = new provider.Grant({ accountId, clientId });
      // 요청된 범위를 그대로 승인한다. resource는 provider에서 이 서비스 주소만 허용한다.
      const oidcScopes = String(details.params.scope ?? '')
        .split(' ')
        .filter((s) => OIDC_SCOPES.has(s));
      if (oidcScopes.length) grant.addOIDCScope(oidcScopes.join(' '));
      grant.addResourceScope(config.resource, MCP_SCOPE);
      const grantId = await grant.save();
      await replaceConnection(db, { grantId, userId: accountId, clientId, clientName: client.clientName ?? clientId });
      // 로그인과 동의를 한 번에 끝낸다
      await provider.interactionFinished(req, res, { login: { accountId }, consent: { grantId } }, { mergeWithLastSubmission: false });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:uid/abort', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const web = await requireUser(req, res, details.uid, details.session?.accountId);
      if (!web || rejectCsrf(res, web, req.body.csrf)) return;
      await provider.interactionFinished(
        req,
        res,
        { error: 'access_denied', error_description: '사용자가 거부했습니다' },
        { mergeWithLastSubmission: false },
      );
    } catch (e) {
      next(e);
    }
  });

  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('interaction error', err);
    res.status(400).send(page('오류', `<p>연결 요청을 처리할 수 없습니다. 앱에서 연결을 다시 시작해 주세요.</p>`));
  });

  return router;
}
