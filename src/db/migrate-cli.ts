import { createPgDb } from './db.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await migrate(createPgDb(url));
console.log('migrated');
process.exit(0);
