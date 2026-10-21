import type { Db, Queryable } from '../db/db.js';

export const CONNECTION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Connection {
  id: string;
  grant_id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
}

// 연결에서 파생된 grant·인가 코드·토큰을 모두 지운다
async function deleteGrantModels(q: Queryable, grantId: string) {
  await q.query(`DELETE FROM oidc_models WHERE grant_id = $1 OR (model = 'Grant' AND id = $1)`, [grantId]);
}

// 같은 사용자·같은 앱(client_id)의 미폐기 연결(만료된 것 포함)을 폐기하고 새 연결을 만든다.
// 다른 앱의 연결은 그대로 둔다. 사용자 단위 잠금으로 동시 재연결에서도 1개만 남는다.
export async function replaceConnection(
  db: Db,
  input: { grantId: string; userId: string; clientId: string; clientName: string },
): Promise<void> {
  await db.tx(async (q) => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.userId]);
    const { rows: old } = await q.query<{ grant_id: string }>(
      `UPDATE oauth_connections SET revoked_at = now(), revoke_reason = 'replaced'
       WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL
       RETURNING grant_id`,
      [input.userId, input.clientId],
    );
    for (const { grant_id } of old) await deleteGrantModels(q, grant_id);
    await q.query(
      `INSERT INTO oauth_connections (grant_id, user_id, client_id, client_name, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))`,
      [input.grantId, input.userId, input.clientId, input.clientName, CONNECTION_TTL_SECONDS],
    );
  });
}

// 연결 설정 화면의 해제. 본인 연결만 폐기하며, 없거나 이미 폐기됐으면 false.
export async function revokeConnection(db: Db, userId: string, connectionId: string): Promise<boolean> {
  return db.tx(async (q) => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [userId]);
    const { rows } = await q.query<{ grant_id: string }>(
      `UPDATE oauth_connections SET revoked_at = now(), revoke_reason = 'user_revoked'
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING grant_id`,
      [connectionId, userId],
    );
    for (const { grant_id } of rows) await deleteGrantModels(q, grant_id);
    return rows.length > 0;
  });
}

export async function findActiveConnection(db: Db, userId: string, clientId: string) {
  const { rows } = await db.query<Connection>(
    `SELECT * FROM oauth_connections
     WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [userId, clientId],
  );
  return rows[0];
}

// 연결 설정 화면용: 미폐기 연결(만료된 것 포함)
export async function listConnections(db: Db, userId: string) {
  const { rows } = await db.query<Connection & { expired: boolean }>(
    `SELECT *, expires_at <= now() AS expired FROM oauth_connections
     WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [userId],
  );
  return rows;
}

// 토큰 발급(코드 교환·갱신) 전에 확인: 연결이 미폐기·미만료이고 사용자가 정지되지 않았는가
export async function isConnectionUsable(db: Db, grantId: string, userId: string) {
  const { rows } = await db.query(
    `SELECT 1 FROM oauth_connections c JOIN users u ON u.id = c.user_id
     WHERE c.grant_id = $1 AND c.user_id = $2 AND c.revoked_at IS NULL AND c.expires_at > now() AND u.status = 'active'`,
    [grantId, userId],
  );
  return rows.length > 0;
}

// 액세스 토큰 검증 시 매 요청 호출. 폐기·만료된 연결이거나 정지된 사용자면 undefined.
export async function touchConnectionByGrant(db: Db, grantId: string) {
  const { rows } = await db.query<Connection>(
    `UPDATE oauth_connections c SET last_used_at = now()
     FROM users u
     WHERE c.grant_id = $1 AND c.revoked_at IS NULL AND c.expires_at > now()
       AND u.id = c.user_id AND u.status = 'active'
     RETURNING c.*`,
    [grantId],
  );
  return rows[0];
}
