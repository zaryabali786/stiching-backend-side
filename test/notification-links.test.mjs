/**
 * Every page a notification opens must exist in the app that opens it. A link to a page that is not there (the shop alerts once
 * pointed at /admin/ecommerce) lands the person on the home page instead of the thing the notification is about.
 * The route lists are read from the app sources next to the backend; the test is skipped where they are not checked out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:').replace(/%20/g, ' ');
const adminRoutes = join(root, 'admin side/src/app/app.routes.ts');
const clientRoutes = join(root, 'client side/src/app/app.routes.ts');
const have = existsSync(adminRoutes) && existsSync(clientRoutes);

const pathsOf = (file) => new Set([...readFileSync(file, 'utf8').matchAll(/path: '([^']+)'/g)].map((m) => m[1]));
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.js') ? [join(dir, f)] : []));

test('notification links lead to pages that exist', { skip: !have && 'the app sources are not next to the backend' }, () => {
  const admin = pathsOf(adminRoutes);
  const client = pathsOf(clientRoutes);
  admin.add('messages'); // matched by a custom matcher (messages and messages/:orderId)
  const bad = [];
  for (const file of walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:').replace(/%20/g, ' '))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:link|admin|partner_staff|customer|partner):\s*[`'"]\/(admin|partner|app)\/([a-z0-9-]+)/g)) {
      const [, portal, page] = m;
      const known = portal === 'app' ? client : admin;
      const ok = [...known].some((p) => p === page || p.startsWith(`${page}/`));
      if (!ok) bad.push(`${file.split('src')[1]}: /${portal}/${page}`);
    }
  }
  assert.deepEqual(bad, []);
});
