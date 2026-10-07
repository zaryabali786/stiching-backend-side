/**
 * Applies every SQL file in backend/migrations (0001_…, 0002_…) to the Supabase database, in order.
 * All migrations are written to be safe to run more than once.
 *
 *   1. Supabase dashboard → Project Settings → Database → Connection string → "URI"
 *      (Session pooler, port 5432). Replace [YOUR-PASSWORD] with the database password.
 *   2. Put it in backend/.env as  DATABASE_URL=postgresql://...
 *   3. npm run migrate
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set in backend/.env — see the instructions at the top of scripts/migrate.mjs.');
  process.exit(1);
}

const expectedRef = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (expectedRef && !url.includes(expectedRef)) {
  console.error(`DATABASE_URL does not point at project "${expectedRef}" (the one in SUPABASE_URL). Use that project's connection string.`);
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  for (const file of files) {
    process.stdout.write(`Applying ${file} … `);
    await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    console.log('ok');
  }
  // Make the REST API (PostgREST) see the new tables immediately
  await client.query(`NOTIFY pgrst, 'reload schema'`);
  console.log('\nAll migrations applied. Next: npm run db:check, then npm run seed.');
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
