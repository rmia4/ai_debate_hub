import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import type { Db, Queryable } from '../db/db.js';

// 응답 유실 재시도·동시 갱신을 위한 유예 시간. 이 안에서 직전 리프레시 토큰이 다시 오면
// 재사용으로 보지 않고 새 토큰을 발급하며, 아직 쓰지 않은 후속 토큰은 무효가 된다.
export const REFRESH_GRACE_SECONDS = 30;

// 직전에 쓰인 리프레시 토큰인가: 유예 시간 안에 쓰였고, 같은 연결에서 그 뒤에 쓰인 토큰이 없다
const IN_GRACE = `r.consumed_at > now() - make_interval(secs => ${REFRESH_GRACE_SECONDS})
  AND NOT EXISTS (SELECT 1 FROM oidc_models o
                  WHERE o.model = 'RefreshToken' AND o.grant_id = r.grant_id AND o.consumed_at > r.consumed_at)`;

// oidc-provider 저장소 어댑터. 모든 모델을 oidc_models 한 테이블에 둔다.
export function createAdapterFactory(db: Db) {
  return class PgAdapter implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      const insert = (q: Queryable) =>
        q.query(
          `INSERT INTO oidc_models (model, id, payload, grant_id, user_code, uid, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(secs => $7::int) END)
           ON CONFLICT (model, id) DO UPDATE SET
             payload = EXCLUDED.payload, grant_id = EXCLUDED.grant_id, user_code = EXCLUDED.user_code,
             uid = EXCLUDED.uid, expires_at = EXCLUDED.expires_at`,
          [this.model, id, payload, payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, expiresIn || null],
        );
      if (this.model !== 'RefreshToken' || !payload.grantId) {
        await insert(db);
        return;
      }
      // 연결마다 쓰지 않은 리프레시 토큰은 1개만 둔다. 유예 재발급·동시 갱신에서 먼저 발급된 쪽을 지운다.
      await db.tx(async (q) => {
        await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [payload.grantId]);
        await q.query(
          `DELETE FROM oidc_models WHERE model = 'RefreshToken' AND grant_id = $1 AND id <> $2 AND consumed_at IS NULL`,
          [payload.grantId, id],
        );
        await insert(q);
      });
    }

    private async findWhere(column: 'id' | 'user_code' | 'uid', value: string) {
      const graceSql = this.model === 'RefreshToken' ? IN_GRACE : 'false';
      const { rows } = await db.query<{ payload: AdapterPayload; consumed_at: Date | null; in_grace: boolean }>(
        `SELECT payload, consumed_at, (${graceSql}) AS in_grace FROM oidc_models r
         WHERE model = $1 AND ${column} = $2 AND (expires_at IS NULL OR expires_at > now())`,
        [this.model, value],
      );
      const row = rows[0];
      if (!row) return undefined;
      return row.consumed_at && !row.in_grace ? { ...row.payload, consumed: true } : row.payload;
    }

    find(id: string) {
      return this.findWhere('id', id);
    }

    findByUserCode(userCode: string) {
      return this.findWhere('user_code', userCode);
    }

    findByUid(uid: string) {
      return this.findWhere('uid', uid);
    }

    // 조건부 UPDATE: 동시 요청 중 한 번만 성공한다. 진 쪽은 invalid_grant.
    // 리프레시 토큰은 유예 조건을 만족하면 이미 쓰였어도 통과시킨다(consumed_at은 처음 값 유지).
    async consume(id: string): Promise<void> {
      const { rowCount } = await db.query(
        `UPDATE oidc_models SET consumed_at = now() WHERE model = $1 AND id = $2 AND consumed_at IS NULL`,
        [this.model, id],
      );
      if (rowCount > 0) return;
      if (this.model === 'RefreshToken') {
        const { rows } = await db.query(`SELECT 1 FROM oidc_models r WHERE model = 'RefreshToken' AND id = $1 AND ${IN_GRACE}`, [id]);
        if (rows.length > 0) return;
      }
      throw new errors.InvalidGrant(`${this.model} already used`);
    }

    async destroy(id: string): Promise<void> {
      await db.query(`DELETE FROM oidc_models WHERE model = $1 AND id = $2`, [this.model, id]);
    }

    // 리프레시 토큰 재사용 감지·grant 폐기 시 호출된다. 연결도 함께 폐기한다.
    async revokeByGrantId(grantId: string): Promise<void> {
      await db.tx(async (q) => {
        await q.query(`DELETE FROM oidc_models WHERE grant_id = $1 OR (model = 'Grant' AND id = $1)`, [grantId]);
        await q.query(
          `UPDATE oauth_connections SET revoked_at = now(), revoke_reason = 'grant_revoked'
           WHERE grant_id = $1 AND revoked_at IS NULL`,
          [grantId],
        );
      });
    }
  };
}
