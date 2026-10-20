import express, { type Request, type Response, type NextFunction } from 'express';
import type Provider from 'oidc-provider';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { findActiveConnection, PARTICIPANTS, replaceConnection, type Participant } from './connections.js';
import { MCP_SCOPE } from './provider.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AI Debate Hub</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
label{display:block;margin:.75rem 0}input[type=text],input[type=password]{width:100%;padding:.4rem}
.warn{background:#fff4e5;border:1px solid #f0b000;padding:.75rem}button{padding:.5rem 1rem}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;

export function interactionRouter(provider: Provider, config: Config, db: Db) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '10kb' }));
  // oidc-provider는 Koa 기반이라 응답 헤더를 직접 다룬다
  router.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  router.get('/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const client = await provider.Client.find(String(details.params.client_id));
      if (!client) throw new Error('unknown client');
      const clientName = client.clientName ?? client.clientId;

      if (details.prompt.name === 'login') {
        res.send(
          page(
            '로그인',
            `<p><b>${esc(clientName)}</b> 연결을 위해 로그인합니다.</p>
            <p>1단계 시험용 로그인입니다. 2단계에서 GitHub·Google 로그인으로 바뀝니다.</p>
            <form method="post" action="/oauth/interaction/${esc(details.uid)}/login">
              <label>사용자 이름 <input type="text" name="username" required maxlength="40" pattern="[A-Za-z0-9_-]+"></label>
              <label>시험용 암호 <input type="password" name="passcode" required></label>
              <button type="submit">로그인</button>
            </form>`,
          ),
        );
        return;
      }

      const userId = String(details.session?.accountId);
      const redirectHosts = client.redirectUris?.map((u) => new URL(u).host) ?? [];
      const loopbackOnly =
        (client.redirectUris?.length ?? 0) > 0 &&
        client.redirectUris!.every((u) => LOOPBACK_HOSTS.has(new URL(u).hostname));
      const suggested: Participant = /codex|openai/i.test(`${clientName} ${client.clientId}`) ? 'codex' : 'claude';
      const existing = await Promise.all(PARTICIPANTS.map((p) => findActiveConnection(db, userId, p)));

      res.send(
        page(
          '연결 허용',
          `<p><b>${esc(clientName)}</b>이(가) <b>${esc(userId)}</b> 계정으로 토론 도구를 쓰려고 합니다.</p>
          <p>돌아갈 주소: ${redirectHosts.map(esc).join(', ')}</p>
          ${
            loopbackOnly
              ? `<p class="warn">이 연결은 현재 기기의 로컬 앱으로 돌아갑니다(${redirectHosts.map(esc).join(', ')}). 직접 시작한 연결인지 확인한 뒤 허용하세요.</p>`
              : ''
          }
          <form method="post" action="/oauth/interaction/${esc(details.uid)}/consent">
            <p>이 앱의 역할을 고르세요.</p>
            ${PARTICIPANTS.map((p, i) => {
              const label = p === 'claude' ? 'Claude용' : 'Codex용';
              const old = existing[i];
              const note = old ? ` <small>(기존 연결 ${esc(old.client_id)}을(를) 교체합니다)</small>` : '';
              return `<label><input type="radio" name="participant" value="${p}"${p === suggested ? ' checked' : ''}> ${label}${note}</label>`;
            }).join('')}
            <button type="submit">허용</button>
          </form>
          <form method="post" action="/oauth/interaction/${esc(details.uid)}/abort"><button type="submit">거부</button></form>`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/:uid/login', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== 'login') throw new Error('unexpected prompt');
      const username = String(req.body.username ?? '');
      if (req.body.passcode !== config.stage1Passcode || !/^[A-Za-z0-9_-]{1,40}$/.test(username)) {
        res.status(401).send(page('로그인 실패', `<p>이름 또는 암호가 틀렸습니다.</p><a href="/oauth/interaction/${esc(details.uid)}">다시 시도</a>`));
        return;
      }
      await provider.interactionFinished(req, res, { login: { accountId: `stage1:${username}` } }, { mergeWithLastSubmission: false });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:uid/consent', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== 'consent' || !details.session) throw new Error('unexpected prompt');
      const participant = req.body.participant as Participant;
      if (!PARTICIPANTS.includes(participant)) {
        res.status(400).send(page('오류', '<p>역할을 골라 주세요.</p>'));
        return;
      }
      const clientId = String(details.params.client_id);
      const grant = new provider.Grant({ accountId: details.session.accountId, clientId });
      // 요청된 범위를 그대로 승인한다. resource는 provider에서 이 서비스 주소만 허용한다.
      const missing = details.prompt.details as { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> };
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
        grant.addResourceScope(resource, scopes.join(' '));
      }
      grant.addResourceScope(config.resource, MCP_SCOPE);
      const grantId = await grant.save();
      await replaceConnection(db, { grantId, userId: details.session.accountId, participant, clientId });
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:uid/abort', async (req, res, next) => {
    try {
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
