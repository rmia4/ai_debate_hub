import type { Db } from '../db/db.js';

export type Participant = 'claude' | 'codex';
export const PARTICIPANTS: readonly Participant[] = ['claude', 'codex'];

export const CONNECTION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Connection {
  id: string;
  grant_id: string;
  user_id: string;
  participant: Participant;
  client_id: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
}

// 같은 사용자·역할의 미폐기 연결(만료된 것 포함)을 폐기하고 새 연결을 만든다.
// 사용자 단위 잠금 + 부분 유니크 인덱스로 동시 재연결에서도 1개만 남는다.
export async function replaceConnection(
  db: Db,
  input: { grantId: string; userId: string; participant: Participant; clientId: string },
): Promise<void> {
  await db.tx(async (q) => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.userId]);
    const { rows: old } = await q.query<{ grant_id: string }>(
      `UPDATE oauth_connections SET revoked_at = now(), revoke_reason = 'replaced'
       WHERE user_id = $1 AND participant = $2 AND revoked_at IS NULL
       RETURNING grant_id`,
      [input.userId, input.participant],
    );
    for (const { grant_id } of old) {
      await q.query(`DELETE FROM oidc_models WHERE grant_id = $1 OR (model = 'Grant' AND id = $1)`, [grant_id]);
    }
    await q.query(
      `INSERT INTO oauth_connections (grant_id, user_id, participant, client_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))`,
      [input.grantId, input.userId, input.participant, input.clientId, CONNECTION_TTL_SECONDS],
    );
  });
}

export async function findActiveConnection(db: Db, userId: string, participant: Participant) {
  const { rows } = await db.query<Connection>(
    `SELECT * FROM oauth_connections
     WHERE user_id = $1 AND participant = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [userId, participant],
  );
  return rows[0];
}

// 액세스 토큰 검증 시 매 요청 호출. 폐기·만료된 연결이면 undefined.
export async function touchConnectionByGrant(db: Db, grantId: string) {
  const { rows } = await db.query<Connection>(
    `UPDATE oauth_connections SET last_used_at = now()
     WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING *`,
    [grantId],
  );
  return rows[0];
}
