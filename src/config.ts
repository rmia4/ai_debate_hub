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

// 서버를 띄우는 데 꼭 필요한데 비어 있는 환경변수 이름 (값은 다루지 않는다)
export function missingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = ['DATABASE_URL', 'COOKIE_KEYS'].filter((name) => !env[name]);
  const hasPair = (prefix: string) => env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`];
  if (!hasPair('GITHUB') && !hasPair('GOOGLE')) {
    missing.push('GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET 또는 GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET');
  }
  return missing;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // BASE_URL이 없으면 Vercel이 자동으로 넣는 운영 도메인을 쓴다
  const vercelDomain = env.VERCEL_PROJECT_PRODUCTION_URL;
  const baseUrl = (env.BASE_URL ?? (vercelDomain ? `https://${vercelDomain}` : 'http://localhost:3000')).replace(/\/$/, '');
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
