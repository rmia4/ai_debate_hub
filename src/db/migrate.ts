import { readFileSync } from 'node:fs';
import type { Queryable } from './db.js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export async function migrate(db: Queryable): Promise<void> {
  for (const stmt of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}
