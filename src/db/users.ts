import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { usageBytesSql } from './discussions.js';

export type SocialProviderName = 'github' | 'google';

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  created_at: Date;
}

export interface SocialProfile {
  provider: SocialProviderName;
  providerAccountId: string;
  email: string | null;
  displayName: string;
}

async function findByAccount(db: Db, provider: SocialProviderName, providerAccountId: string) {
  const { rows } = await db.query<User>(
    `SELECT u.* FROM accounts a JOIN users u ON u.id = a.user_id
     WHERE a.provider = $1 AND a.provider_account_id = $2`,
    [provider, providerAccountId],
  );
  return rows[0];
}

// 첫 로그인이면 가입시킨다. 로그인 화면의 약관 고지에 동의한 것으로 보고 terms_agreed_at을 남긴다.
// 같은 소셜 계정의 동시 첫 로그인은 accounts 기본 키로 한쪽만 가입되고, 다른 쪽은 그 사용자를 읽는다.
export async function findOrCreateUser(db: Db, profile: SocialProfile): Promise<User> {
  const existing = await findByAccount(db, profile.provider, profile.providerAccountId);
  if (existing) return existing;
  try {
    await db.tx(async (q) => {
      const id = randomUUID();
      await q.query(`INSERT INTO users (id, email, display_name, terms_agreed_at) VALUES ($1, $2, $3, now())`, [
        id,
        profile.email,
        profile.displayName,
      ]);
      await q.query(`INSERT INTO accounts (provider, provider_account_id, user_id) VALUES ($1, $2, $3)`, [
        profile.provider,
        profile.providerAccountId,
        id,
      ]);
    });
  } catch (e) {
    const raced = await findByAccount(db, profile.provider, profile.providerAccountId);
    if (raced) return raced;
    throw e;
  }
  return (await findByAccount(db, profile.provider, profile.providerAccountId))!;
}

export async function findActiveUser(db: Db, userId: string) {
  const { rows } = await db.query<User>(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [userId]);
  return rows[0];
}

// 회원 탈퇴: 계정과 연결·세션·토론 기록(ON DELETE CASCADE), oidc-provider의 grant·토큰·로그인 세션을 즉시 지운다
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.tx(async (q) => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [userId]);
    await q.query(
      `DELETE FROM oidc_models
       WHERE payload->>'accountId' = $1
          OR grant_id IN (SELECT grant_id FROM oauth_connections WHERE user_id = $1)
          OR (model = 'Grant' AND id IN (SELECT grant_id FROM oauth_connections WHERE user_id = $1))`,
      [userId],
    );
    await q.query(`DELETE FROM rate_limits WHERE key LIKE '%:' || $1`, [userId]);
    await q.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });
}

export async function setUserStatus(db: Db, userId: string, status: User['status']): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);
  return rowCount > 0;
}

// 운영자 화면용: 사용자별 토론 수와 텍스트 용량(UTF-8 바이트)
export async function listUsersWithUsage(db: Db) {
  const { rows } = await db.query<User & { discussions: number; bytes: number }>(
    `SELECT u.*,
       (SELECT count(*) FROM discussions d WHERE d.owner_id = u.id)::int AS discussions,
       ${usageBytesSql('u.id')} AS bytes
     FROM users u ORDER BY u.created_at`,
  );
  return rows;
}

export async function databaseSize(db: Db): Promise<number> {
  const { rows } = await db.query<{ bytes: number }>(`SELECT pg_database_size(current_database())::float8 AS bytes`);
  return rows[0].bytes;
}
