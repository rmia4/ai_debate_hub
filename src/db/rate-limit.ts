import type { Queryable } from './db.js';

// 고정 시간 구간 카운터. 원자적 UPSERT의 반환값으로 허용 여부를 정하므로 인스턴스 간 동시 요청에도 정확하다.
export async function hitRateLimit(db: Queryable, key: string, windowSeconds: number, limit: number): Promise<boolean> {
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSeconds],
  );
  return rows[0].count <= limit;
}
