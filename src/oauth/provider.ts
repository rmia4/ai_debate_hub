import { isIP } from 'node:net';
import Provider, { errors, type Configuration } from 'oidc-provider';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { findActiveUser } from '../db/users.js';
import { esc, page } from '../web/html.js';
import { createAdapterFactory } from './adapter.js';
import { CONNECTION_TTL_SECONDS, isConnectionUsable } from './connections.js';

export const MCP_SCOPE = 'mcp';

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const ERROR_MESSAGES: Record<string, string> = {
  invalid_client: '등록되지 않았거나 확인할 수 없는 앱입니다.',
  invalid_redirect_uri: '앱이 보낸 돌아갈 주소가 등록된 주소와 다릅니다.',
  invalid_request: '연결 요청 형식이 올바르지 않습니다.',
  invalid_target: '이 서비스에 대한 연결 요청이 아닙니다.',
  invalid_scope: '요청한 권한 범위를 허용할 수 없습니다.',
  access_denied: '연결이 거부되었습니다.',
  session_not_found: '연결 요청이 만료되었습니다.',
  unauthorized_client: '이 앱은 해당 방식으로 연결할 수 없습니다.',
};

export function createProvider(config: Config, db: Db): Provider {
  const configuration: Configuration = {
    adapter: createAdapterFactory(db),
    ...(config.jwks ? { jwks: config.jwks as Configuration['jwks'] } : {}),
    cookies: { keys: config.cookieKeys },
    routes: {
      authorization: '/authorize',
      token: '/token',
      registration: '/register',
      revocation: '/revoke',
      jwks: '/jwks',
    },
    responseTypes: ['code'],
    scopes: [MCP_SCOPE, 'offline_access'],
    claims: { openid: ['sub'] },
    // 정지된 사용자, 폐기·만료된 연결이면 계정을 찾지 못한 것으로 보고 토큰을 발급하지 않는다(invalid_grant).
    // 코드 교환·리프레시 모두 토큰 소비 전에 호출되므로, 정지 중에도 토큰은 소모되지 않고 남는다.
    findAccount: async (_ctx, sub, token) => {
      const usable = token?.grantId ? await isConnectionUsable(db, token.grantId, sub) : !!(await findActiveUser(db, sub));
      return usable ? { accountId: sub, claims: () => ({ sub }) } : undefined;
    },
    interactions: { url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
    // 동의 1회 = 연결 1개. 세션의 기존 grant는 재사용하지 않고, 방금 동의한 grant만 쓴다.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    pkce: { required: () => true },
    rotateRefreshToken: true,
    // 토큰 수명은 oidc-provider 세션이 아니라 연결(30일)을 따른다. 인가가 끝나면 세션을 지우므로 꼭 필요하다.
    expiresWithSession: () => false,
    // web 유형 클라이언트(기본값)의 리디렉트 주소는 HTTPS 또는 루프백 HTTP만 허용한다. DCR과 CIMD 모두 적용된다.
    extraClientMetadata: {
      properties: ['redirect_uris'],
      validator: (_ctx, key, value, metadata) => {
        if (key !== 'redirect_uris' || (metadata.application_type ?? 'web') !== 'web' || !Array.isArray(value)) return;
        for (const uri of value as string[]) {
          const url = URL.parse(uri);
          if (url && url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
            throw new errors.InvalidRedirectUri('redirect_uris must use https or a loopback http address');
          }
        }
      },
    },
    renderError: (ctx, out) => {
      ctx.type = 'html';
      const message = ERROR_MESSAGES[out.error] ?? '연결 요청을 처리할 수 없습니다.';
      ctx.body = page(
        '연결 오류',
        `<p>${esc(message)} 앱에서 연결을 처음부터 다시 시작해 주세요.</p><p><small>오류 코드: ${esc(out.error)}</small></p>`,
      );
    },
    clientBasedCORS: () => true,
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    ttl: {
      AccessToken: 60 * 60,
      AuthorizationCode: 10 * 60,
      Interaction: 10 * 60,
      Session: 7 * 24 * 60 * 60,
      Grant: CONNECTION_TTL_SECONDS,
      // 첫 발급 시점(iiat) 기준 30일 고정. 갱신으로 연장되지 않는다.
      RefreshToken: (_ctx, token) => {
        const iiat = (token as { iiat?: number }).iiat ?? Math.floor(Date.now() / 1000);
        return Math.max(1, iiat + CONNECTION_TTL_SECONDS - Math.floor(Date.now() / 1000));
      },
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      // 라이브러리가 접속 시점에 비공개 IP를 차단하고(DNS 재해석 포함) 리디렉션을 따르지 않는다.
      // IP 리터럴·localhost는 조회 전에 바로 거부한다.
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        allowFetch: (_ctx, clientId) => {
          const host = new URL(clientId).hostname.replace(/^\[|\]$/g, '');
          return !isIP(host) && host !== 'localhost' && !host.endsWith('.localhost');
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resourceIndicator) => {
          if (resourceIndicator !== config.resource) {
            throw new errors.InvalidTarget('unknown resource');
          }
          return { scope: MCP_SCOPE, audience: config.resource, accessTokenFormat: 'opaque', accessTokenTTL: 60 * 60 };
        },
      },
    },
  };
  const provider = new Provider(config.issuer, configuration);
  provider.proxy = true;
  // 로그인 상태의 기준은 웹 세션 하나다. 인가가 끝나면 oidc-provider 세션을 지워서
  // 다음 인가 요청이 이전 계정으로 진행되지 않고 늘 웹 세션으로 다시 로그인하게 한다.
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.oidc?.route === 'resume' && !String(ctx.response.get('location')).includes('/oauth/interaction/')) {
      await ctx.oidc.session?.destroy();
    }
  });
  return provider;
}
