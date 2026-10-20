import { isIP } from 'node:net';
import Provider, { errors, type Configuration } from 'oidc-provider';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { createAdapterFactory } from './adapter.js';
import { CONNECTION_TTL_SECONDS } from './connections.js';

export const MCP_SCOPE = 'mcp';

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
    findAccount: (_ctx, sub) => ({ accountId: sub, claims: () => ({ sub }) }),
    interactions: { url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
    // 동의 1회 = 연결 1개. 세션의 기존 grant는 재사용하지 않고, 방금 동의한 grant만 쓴다.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    pkce: { required: () => true },
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
  return provider;
}
