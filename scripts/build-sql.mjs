/**
 * Builds the two paste-into-Supabase files from backend/migrations:
 *
 *   SETUP_DATABASE.sql          every migration, for a brand new project
 *   UPDATE_DATABASE_<last>.sql  the latest migrations only (0004 onwards), for a project that already has 0001-0003
 *
 * Every migration is safe to run more than once, so running the update file on a project that already has some of it is fine.
 *
 *   npm run db:bundle
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'migrations');
const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const nums = (list) => list.map((f) => f.slice(0, 4)).join(' + ');
const FROM = 4; // the first migration of the "update" file

const lastNum = files[files.length - 1].slice(0, 4);
const update = files.filter((f) => Number(f.slice(0, 4)) >= FROM);

fs.writeFileSync(
  path.join(root, 'SETUP_DATABASE.sql'),
  `-- V360: complete database setup (${nums(files)}). Safe to run more than once.\n-- Paste this whole file into the Supabase SQL Editor of your project and press Run.\n\n\n${files.map(read).join('\n\n')}`,
);

for (const old of fs.readdirSync(root).filter((f) => /^UPDATE_DATABASE.*\.sql$/.test(f))) fs.rmSync(path.join(root, old));
const updateFile = `UPDATE_DATABASE_${lastNum}.sql`;
fs.writeFileSync(
  path.join(root, updateFile),
  `-- V360: run ONLY this if migrations 0001-0003 were already applied (it carries ${nums(update)}). Safe to run more than once.\n${update.map(read).join('\n\n')}`,
);
console.log(`Wrote SETUP_DATABASE.sql (${files.length} migrations) and ${updateFile} (${update.length} migrations).`);
