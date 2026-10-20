export interface Config {
  baseUrl: string;
  issuer: string;
  resource: string;
  stage1Passcode: string;
  cookieKeys: string[];
  jwks?: { keys: Record<string, unknown>[] };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  return {
    baseUrl,
    issuer: `${baseUrl}/oauth`,
    resource: `${baseUrl}/mcp`,
    stage1Passcode: required('STAGE1_PASSCODE'),
    cookieKeys: required('COOKIE_KEYS').split(','),
    jwks: env.JWKS ? JSON.parse(env.JWKS) : undefined,
  };
}
