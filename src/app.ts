import express from 'express';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { hitRateLimit } from './db/rate-limit.js';
import { resolveCaller } from './mcp/caller.js';
import { handleMcp } from './mcp/server.js';
import { interactionRouter } from './oauth/interaction.js';
import { createProvider, MCP_SCOPE } from './oauth/provider.js';
import { authRouter } from './web/auth-routes.js';
import { pagesRouter } from './web/pages.js';

export const REGISTER_RATE_LIMIT = { windowSeconds: 60 * 60, limit: 100 };

export function createApp(config: Config, db: Db) {
  const provider = createProvider(config, db);
  const providerCallback = provider.callback();
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // 브라우저 기반 MCP 클라이언트(예: MCP Inspector)용 CORS
  app.use(['/mcp', '/.well-known'], (req, res, next) => {
    res.set({
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-expose-headers': 'www-authenticate, mcp-session-id',
    });
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const resourceMetadataUrl = `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
    });
  });

  // RFC 8414 경로 삽입 방식과 OIDC 방식 모두로 인가 서버 메타데이터를 노출한다
  app.get(
    ['/.well-known/oauth-authorization-server/oauth', '/.well-known/openid-configuration/oauth', '/oauth/.well-known/oauth-authorization-server'],
    (req, res) => {
      // Express 마운트(/oauth)와 같은 모양으로 맞춰야 oidc-provider가 엔드포인트 주소에 접두어를 붙인다
      req.originalUrl = '/oauth/.well-known/openid-configuration';
      req.url = '/.well-known/openid-configuration';
      void providerCallback(req, res);
    },
  );

  app.post('/mcp', express.json({ limit: '100kb' }), async (req, res, next) => {
    try {
      const caller = await resolveCaller(req, provider, config, db);
      if (!caller) {
        res
          .status(401)
          .set('www-authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${MCP_SCOPE}"`)
          .json({ error: 'invalid_token' });
        return;
      }
      await handleMcp(req, res, caller);
    } catch (e) {
      next(e);
    }
  });
  app.all('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'method_not_allowed' });
  });

  // 동적 클라이언트 등록 횟수 제한 (IP 단위)
  app.post('/oauth/register', async (req, res, next) => {
    try {
      if (await hitRateLimit(db, `register:${req.ip}`, REGISTER_RATE_LIMIT.windowSeconds, REGISTER_RATE_LIMIT.limit)) {
        next();
        return;
      }
      res.status(429).json({ error: 'too_many_requests', error_description: '등록 요청이 너무 많습니다' });
    } catch (e) {
      next(e);
    }
  });

  app.use('/oauth/interaction', interactionRouter(provider, config, db));
  app.use('/oauth', providerCallback);

  app.use(authRouter(config, db));
  app.use(pagesRouter(config, db));

  return app;
}
