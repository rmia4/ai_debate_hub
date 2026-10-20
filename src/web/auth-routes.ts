import express from 'express';
import { generateCodeVerifier, generateState } from 'arctic';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { hitRateLimit } from '../db/rate-limit.js';
import { findOrCreateUser, type SocialProviderName } from '../db/users.js';
import { esc, page, suspendedPage } from './html.js';
import { checkCsrf, cookieOptions, endSession, loadSession, readCookie, sign, startSession, unsign } from './session.js';
import { createSocialProviders } from './social.js';

const LOGIN_STATE_COOKIE = 'login_state';
const LOGIN_STATE_TTL_SECONDS = 10 * 60;
export const LOGIN_RATE_LIMIT = { windowSeconds: 10 * 60, limit: 30 };

// 같은 사이트 안의 경로만 돌아갈 곳으로 받는다 (열린 리디렉트 방지)
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/app/connections';
}

export const loginUrl = (returnTo: string) => `/login?${new URLSearchParams({ return_to: returnTo })}`;

interface LoginState {
  provider: SocialProviderName;
  state: string;
  verifier: string;
  returnTo: string;
}

export function authRouter(config: Config, db: Db) {
  const providers = createSocialProviders(config);
  const router = express.Router();

  router.get('/login', async (req, res, next) => {
    try {
      const returnTo = safeReturnTo(req.query.return_to);
      const session = await loadSession(config, db, req);
      if (session?.user.status === 'suspended') {
        res.status(403).send(suspendedPage(session.csrf));
        return;
      }
      if (session) {
        res.redirect(303, returnTo);
        return;
      }
      const buttons = [...providers.values()]
        .map((p) => `<p><a class="btn" href="/auth/${p.name}?${new URLSearchParams({ return_to: returnTo })}">${esc(p.label)}로 로그인</a></p>`)
        .join('');
      res.send(
        page(
          '로그인',
          `${buttons}
          <p><small>처음 로그인하면 계정이 만들어지며, <a href="/terms">이용약관</a>과 <a href="/privacy">개인정보 처리방침</a>에 동의한 것으로 봅니다.</small></p>`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/auth/:provider', async (req, res, next) => {
    try {
      const provider = providers.get(req.params.provider as SocialProviderName);
      if (!provider) {
        res.status(404).send(page('없는 로그인 방식', '<p>지원하지 않는 로그인 방식입니다.</p>'));
        return;
      }
      if (!(await hitRateLimit(db, `login:${req.ip}`, LOGIN_RATE_LIMIT.windowSeconds, LOGIN_RATE_LIMIT.limit))) {
        res.status(429).send(page('잠시 후 다시 시도', '<p>로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.</p>'));
        return;
      }
      const loginState: LoginState = {
        provider: provider.name,
        state: generateState(),
        verifier: generateCodeVerifier(),
        returnTo: safeReturnTo(req.query.return_to),
      };
      res.cookie(
        LOGIN_STATE_COOKIE,
        sign(config, Buffer.from(JSON.stringify(loginState)).toString('base64url')),
        { ...cookieOptions(LOGIN_STATE_TTL_SECONDS), path: '/auth' },
      );
      res.redirect(303, provider.authorizationUrl(loginState.state, loginState.verifier).href);
    } catch (e) {
      next(e);
    }
  });

  router.get('/auth/:provider/callback', async (req, res, next) => {
    try {
      const raw = unsign(config, readCookie(req, LOGIN_STATE_COOKIE));
      res.clearCookie(LOGIN_STATE_COOKIE, { ...cookieOptions(0), maxAge: undefined, path: '/auth' });
      const loginState = raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString()) as LoginState) : undefined;
      const provider = providers.get(req.params.provider as SocialProviderName);
      if (!loginState || !provider || loginState.provider !== provider.name || loginState.state !== req.query.state) {
        res.status(400).send(page('로그인 실패', '<p>로그인 요청이 만료되었거나 올바르지 않습니다. <a href="/login">다시 로그인</a>해 주세요.</p>'));
        return;
      }
      if (typeof req.query.code !== 'string') {
        res.status(400).send(page('로그인 취소', '<p>로그인이 취소되었습니다. <a href="/login">다시 로그인</a></p>'));
        return;
      }
      let profile;
      try {
        profile = await provider.fetchProfile(req.query.code, loginState.verifier);
      } catch (e) {
        console.error('social login failed', e);
        res.status(400).send(page('로그인 실패', `<p>${esc(provider.label)} 로그인을 확인하지 못했습니다. <a href="/login">다시 로그인</a>해 주세요.</p>`));
        return;
      }
      const user = await findOrCreateUser(db, profile);
      if (user.status === 'suspended') {
        res.status(403).send(suspendedPage());
        return;
      }
      // 로그인할 때마다 세션을 새로 만든다 (세션 고정 방지)
      await endSession(db, res, await loadSession(config, db, req));
      await startSession(config, db, res, user.id);
      res.redirect(303, loginState.returnTo);
    } catch (e) {
      next(e);
    }
  });

  router.post('/logout', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res, next) => {
    try {
      const session = await loadSession(config, db, req);
      if (session && !checkCsrf(config, session, req.body?.csrf)) {
        res.status(403).send(page('요청 거부', '<p>보안 토큰이 맞지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.</p>'));
        return;
      }
      await endSession(db, res, session);
      res.redirect(303, '/');
    } catch (e) {
      next(e);
    }
  });

  return router;
}
