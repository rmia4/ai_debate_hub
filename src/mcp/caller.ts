import type { Request } from 'express';
import type Provider from 'oidc-provider';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { touchConnectionByGrant } from '../oauth/connections.js';

export interface Caller {
  userId: string;
  clientName: string;
  connectionId: string;
}

// "요청 → 사용자" 판별은 이 함수 한 곳에서만 한다. 토론 자리(A/B)는 도구 입력으로 받는다.
// 토큰 검증만으로 통과시키지 않고 매 요청 연결의 폐기·만료 상태를 DB에서 확인한다.
export async function resolveCaller(req: Request, provider: Provider, config: Config, db: Db): Promise<Caller | null> {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  if (!match) return null;
  const token = await provider.AccessToken.find(match[1]);
  if (!token || token.isExpired || !token.grantId) return null;
  const aud = Array.isArray(token.aud) ? token.aud : [token.aud];
  if (!aud.includes(config.resource)) return null;
  const conn = await touchConnectionByGrant(db, token.grantId);
  if (!conn || conn.user_id !== token.accountId) return null;
  return { userId: conn.user_id, clientName: conn.client_name, connectionId: String(conn.id) };
}
