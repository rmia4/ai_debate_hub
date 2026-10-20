import { decodeIdToken, GitHub, Google } from 'arctic';
import type { Config } from '../config.js';
import type { SocialProfile, SocialProviderName } from '../db/users.js';

export interface SocialProvider {
  name: SocialProviderName;
  label: string;
  authorizationUrl(state: string, codeVerifier: string): URL;
  fetchProfile(code: string, codeVerifier: string): Promise<SocialProfile>;
}

const callbackUrl = (config: Config, name: SocialProviderName) => `${config.baseUrl}/auth/${name}/callback`;

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'ai-debate-hub' },
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

function github(config: Config): SocialProvider {
  const client = new GitHub(config.github!.clientId, config.github!.clientSecret, callbackUrl(config, 'github'));
  return {
    name: 'github',
    label: 'GitHub',
    // GitHub OAuth 앱은 PKCE를 쓰지 않는다. state 쿠키로 CSRF를 막는다.
    authorizationUrl: (state) => client.createAuthorizationURL(state, ['read:user', 'user:email']),
    async fetchProfile(code) {
      const tokens = await client.validateAuthorizationCode(code);
      const at = tokens.accessToken();
      const user = await getJson<{ id: number; login: string; name: string | null }>('https://api.github.com/user', at);
      const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
        'https://api.github.com/user/emails',
        at,
      ).catch(() => []);
      const primary = emails.find((e) => e.primary && e.verified);
      return {
        provider: 'github',
        providerAccountId: String(user.id),
        email: primary?.email ?? null,
        displayName: user.name || user.login,
      };
    },
  };
}

function google(config: Config): SocialProvider {
  const { clientId, clientSecret } = config.google!;
  const client = new Google(clientId, clientSecret, callbackUrl(config, 'google'));
  return {
    name: 'google',
    label: 'Google',
    authorizationUrl: (state, codeVerifier) => client.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']),
    async fetchProfile(code, codeVerifier) {
      const tokens = await client.validateAuthorizationCode(code, codeVerifier);
      // 토큰 엔드포인트에서 TLS로 직접 받은 ID 토큰이므로 서명 대신 발급자·대상만 확인한다 (OIDC Core 3.1.3.7)
      const claims = decodeIdToken(tokens.idToken()) as {
        iss: string;
        aud: string | string[];
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
      };
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !aud.includes(clientId)) {
        throw new Error('unexpected id token');
      }
      const email = claims.email_verified ? (claims.email ?? null) : null;
      return { provider: 'google', providerAccountId: claims.sub, email, displayName: claims.name || email || 'Google 사용자' };
    },
  };
}

export function createSocialProviders(config: Config): Map<SocialProviderName, SocialProvider> {
  const list = [config.github && github(config), config.google && google(config)].filter((p): p is SocialProvider => !!p);
  return new Map(list.map((p) => [p.name, p]));
}
