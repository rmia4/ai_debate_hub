import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Db } from '../db/db.js';

// oidc-provider 저장소 어댑터. 모든 모델을 oidc_models 한 테이블에 둔다.
export function createAdapterFactory(db: Db) {
  return class PgAdapter implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      await db.query(
        `INSERT INTO oidc_models (model, id, payload, grant_id, user_code, uid, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(secs => $7::int) END)
         ON CONFLICT (model, id) DO UPDATE SET
           payload = EXCLUDED.payload, grant_id = EXCLUDED.grant_id, user_code = EXCLUDED.user_code,
           uid = EXCLUDED.uid, expires_at = EXCLUDED.expires_at`,
        [this.model, id, payload, payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, expiresIn || null],
      );
    }

    private async findWhere(column: 'id' | 'user_code' | 'uid', value: string) {
      const { rows } = await db.query<{ payload: AdapterPayload; consumed_at: Date | null }>(
        `SELECT payload, consumed_at FROM oidc_models
         WHERE model = $1 AND ${column} = $2 AND (expires_at IS NULL OR expires_at > now())`,
        [this.model, value],
      );
      const row = rows[0];
      if (!row) return undefined;
      return row.consumed_at ? { ...row.payload, consumed: true } : row.payload;
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

    // 조건부 UPDATE: 동시 요청 중 한 번만 성공한다. 나머지는 예외로 요청 실패.
    async consume(id: string): Promise<void> {
      const { rowCount } = await db.query(
        `UPDATE oidc_models SET consumed_at = now() WHERE model = $1 AND id = $2 AND consumed_at IS NULL`,
        [this.model, id],
      );
      if (rowCount === 0) throw new Error(`${this.model} already consumed`);
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
