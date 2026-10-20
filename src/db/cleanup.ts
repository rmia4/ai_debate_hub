import type { Db } from './db.js';
import { RETENTION_DAYS } from './discussions.js';

export const TOKEN_HISTORY_DAYS = 30;
// 가장 긴 횟수 제한 구간(하루)보다 넉넉히 둔다
export const RATE_LIMIT_KEEP_DAYS = 2;

export interface CleanupRun {
  id: string;
  ran_at: Date;
  deleted: Record<string, number>;
  error: string | null;
}

// docs/architecture.md "정리 작업". 항목별 삭제 건수를 cleanup_runs에 남기고, 실패도 기록한 뒤 다시 던진다.
export async function runCleanup(db: Db): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  const step = async (name: string, sql: string, params: unknown[] = []) => {
    deleted[name] = (await db.query(sql, params)).rowCount;
  };
  try {
    // 1. 보존 기간이 지난 토론방 (답변은 ON DELETE CASCADE)
    await step(
      'discussions',
      `DELETE FROM discussions WHERE status <> 'active' AND ended_at < now() - make_interval(days => $1::int)`,
      [RETENTION_DAYS],
    );
    // 2. 만료된 인가 요청·코드·세션 등 (토큰 이력은 3에서 따로)
    await step('sessions', `DELETE FROM sessions WHERE expires_at < now()`);
    await step(
      'oauth_records',
      `DELETE FROM oidc_models WHERE model NOT IN ('AccessToken', 'RefreshToken') AND expires_at < now()`,
    );
    // 3. 만료 후 30일 지난 토큰 이력과, 폐기·만료 후 30일 지난 연결
    await step(
      'token_history',
      `DELETE FROM oidc_models WHERE model IN ('AccessToken', 'RefreshToken') AND expires_at < now() - make_interval(days => $1::int)`,
      [TOKEN_HISTORY_DAYS],
    );
    await step(
      'connections',
      `DELETE FROM oauth_connections
       WHERE least(coalesce(revoked_at, 'infinity'), expires_at) < now() - make_interval(days => $1::int)`,
      [TOKEN_HISTORY_DAYS],
    );
    // 4. 오래된 횟수 제한 기록
    await step('rate_limits', `DELETE FROM rate_limits WHERE window_start < now() - make_interval(days => $1::int)`, [
      RATE_LIMIT_KEEP_DAYS,
    ]);
  } catch (e) {
    await db.query(`INSERT INTO cleanup_runs (deleted, error) VALUES ($1, $2)`, [JSON.stringify(deleted), String(e)]);
    throw e;
  }
  await db.query(`INSERT INTO cleanup_runs (deleted) VALUES ($1)`, [JSON.stringify(deleted)]);
  return deleted;
}

export async function recentCleanupRuns(db: Db, limit = 10) {
  const { rows } = await db.query<CleanupRun>(
    `SELECT id::text AS id, ran_at, deleted, error FROM cleanup_runs ORDER BY ran_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
