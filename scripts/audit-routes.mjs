/**
 * Lists what protects every /partner route (needs no database): the module permission and, for routes that take the id of
 * a partner-owned record, the tenant ownership guard. Exits with an error when a route is unprotected.
 *
 *   node scripts/audit-routes.mjs
 */
import partnerRoutes from '../src/routes/partner.routes.js';

// :id parameters that are NOT a partner-owned record (global catalogue rows, the partner's own users handled inside the service)
const GLOBAL_ID_ROUTES = [/^\/production\/columns\/:stage$/,/^\/(brands|couriers|article-types|articles)\/:id$/, /^\/users\/:id(\/.*)?$/];
// intentionally open to every signed-in partner login: they only describe the caller
const OPEN = new Set(['GET /access', 'GET /badges']);

const rows = [];
let failures = 0;
for (const layer of partnerRoutes.stack) {
  if (!layer.route) continue;
  const path = layer.route.path;
  for (const method of Object.keys(layer.route.methods)) {
    const guards = layer.route.stack.map((l) => l.handle.guard).filter(Boolean);
    const perms = guards.filter((g) => g.type === 'permission').map((g) => g.permissions.join('+')).join(' | ');
    const owns = guards.filter((g) => g.type === 'owns').map((g) => `${g.entity}:${g.param}`).join(', ');
    const key = `${method.toUpperCase()} ${path}`;
    const problems = [];
    if (!perms && !OPEN.has(key)) problems.push('NO PERMISSION GUARD');
    const idParams = (path.match(/:[A-Za-z]+/g) || []).map((p) => p.slice(1));
    if (idParams.length && !owns && !GLOBAL_ID_ROUTES.some((re) => re.test(path))) problems.push('NO OWNERSHIP GUARD');
    if (problems.length) failures++;
    rows.push({ route: key.padEnd(58), needs: (perms || '(any partner login)').padEnd(36), owns: owns || '-', problems: problems.join(', ') });
  }
}
for (const r of rows) console.log(`${r.problems ? 'FAIL' : 'ok  '} ${r.route} ${r.needs} ${r.owns} ${r.problems}`);
console.log(`\n${rows.length} partner routes, ${failures} unprotected.`);
process.exit(failures ? 1 : 0);
