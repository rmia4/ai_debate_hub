export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  baseUrl: string;
  issuer: string;
  resource: string;
  cookieKeys: string[];
  jwks?: { keys: Record<string, unknown>[] };
  // 설정된 소셜 로그인만 로그인 화면에 표시한다
  github?: OAuthAppCredentials;
  google?: OAuthAppCredentials;
  // 약관·개인정보 처리방침에 표시할 운영자 연락처
  contactEmail?: string;
  // Vercel Cron이 Authorization: Bearer로 보내는 값. 없으면 정리 작업 엔드포인트를 막는다
  cronSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const credentials = (prefix: string): OAuthAppCredentials | undefined => {
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const config: Config = {
    baseUrl,
    issuer: `${baseUrl}/oauth`,
    resource: `${baseUrl}/mcp`,
    cookieKeys: required('COOKIE_KEYS').split(','),
    jwks: env.JWKS ? JSON.parse(env.JWKS) : undefined,
    github: credentials('GITHUB'),
    google: credentials('GOOGLE'),
    contactEmail: env.CONTACT_EMAIL || undefined,
    cronSecret: env.CRON_SECRET || undefined,
  };
  if (!config.github && !config.google) throw new Error('GITHUB_* or GOOGLE_* credentials are required');
  return config;
}
