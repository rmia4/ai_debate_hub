import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Vercel 런타임은 require(esm)을 지원하지 않는다. CJS 의존성이 ESM 전용 패키지를 require하면
// 로컬(Node 24)에서는 통과하고 배포에서만 ERR_REQUIRE_ESM으로 죽으므로 같은 조건으로 불러 본다.
const entries: Record<string, string[]> = {
  '@modelcontextprotocol/sdk': ['@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/streamableHttp.js'],
};

describe('런타임 호환성', () => {
  it('require(esm) 없이 모든 런타임 의존성을 불러올 수 있다', () => {
    const deps = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies as Record<string, string>);
    const specs = deps.flatMap((d) => entries[d] ?? [d]);
    const code = `for (const s of ${JSON.stringify(specs)}) await import(s);`;
    expect(() =>
      execFileSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', code], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
