/**
 * End-to-end test (HTTP + Socket.IO) of: brands, couriers, article types + articles, the new order rules,
 * and the order conversation (text + voice). The backend must be running and migration 0004 applied.
 * Uses the accounts from `npm run seed`. Everything it creates is prefixed "E2E " and cleaned up.
 *
 *   npm run test:catalogue
 */
import 'dotenv/config';
import { io } from 'socket.io-client';
import { supabaseAdmin } from '../src/config/supabase.js';

const ORIGIN = process.env.API_ORIGIN || 'http://localhost:5000';
const BASE = `${ORIGIN}/api`;
const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  ✗ ${m}`);
};
const expect = (c, m) => (c ? ok(m) : fail(m));
const section = (t) => console.log(`\n${t}`);

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${json.message}`), { status: res.status, body: json });
  return json;
}
/** Expect the call to be rejected with `status` (and optionally a message matching `re`). */
const rejects = async (label, promise, status, re) => {
  try {
    await promise;
    fail(`${label}: should have failed (${status})`);
  } catch (e) {
    expect(e.status === status && (!re || re.test(e.message)), `${label} → ${e.status} ${(e.body?.message || '').slice(0, 90)}`);
  }
};
const login = async (email) => (await call(null, 'POST', '/auth/login', { email, password: PASSWORD })).data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(ORIGIN, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(Object.assign(e, { socket: s })));
  });
const emit = (s, event, payload) => new Promise((resolve) => s.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'timeout' } : res)));
const waitFor = (s, event, pred = () => true, ms = 6000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    const h = (p) => {
      if (pred(p)) {
        clearTimeout(t);
        s.off(event, h);
        resolve(p);
      }
    };
    s.on(event, h);
  });

const created = { brands: [], couriers: [], types: [], articles: [] };

async function main() {
  section('Login');
  const [customer, partner, admin] = await Promise.all([login('customer@v360.test'), login('partner@v360.test'), login('admin@v360.test')]);
  const C = customer.tokens.accessToken;
  const P = partner.tokens.accessToken;
  const A = admin.tokens.accessToken;
  ok('three roles signed in');

  // ───────────────────────── Brands ─────────────────────────
  section('Brands (partner CRUD, server-side search + pagination)');
  const b1 = (await call(P, 'POST', '/partner/brands', { name: '  E2E   Brand One ' })).data;
  created.brands.push(b1.id);
  expect(b1.name === 'E2E Brand One' && b1.status === 'active', 'create trims and collapses spaces');
  await rejects('duplicate (other case)', call(P, 'POST', '/partner/brands', { name: 'e2e brand one' }), 409, /already exists/);
  await rejects('empty name', call(P, 'POST', '/partner/brands', { name: '   ' }), 400);
  await rejects('name too long', call(P, 'POST', '/partner/brands', { name: 'x'.repeat(81) }), 400);
  await rejects('bad status', call(P, 'POST', '/partner/brands', { name: 'E2E Bad', status: 'maybe' }), 400);
  await rejects('customer cannot manage brands', call(C, 'POST', '/partner/brands', { name: 'E2E Nope' }), 403);
  for (let i = 2; i <= 23; i++) created.brands.push((await call(P, 'POST', '/partner/brands', { name: `E2E Brand ${String(i).padStart(2, '0')}` })).data.id);
  const page1 = await call(P, 'GET', '/partner/brands?search=E2E Brand&limit=10&page=1');
  const page3 = await call(P, 'GET', '/partner/brands?search=E2E Brand&limit=10&page=3');
  expect(page1.data.length === 10 && page1.meta.total === 23 && page1.meta.totalPages === 3 && page1.meta.hasMore === true, 'page 1 of 3 (10 of 23)');
  expect(page3.data.length === 3 && page3.meta.hasMore === false, 'last page has the remaining 3');
  expect(page1.pagination?.total === 23 && page1.pagination.totalPages === 3, 'response also carries `pagination`');
  const found = await call(P, 'GET', '/partner/brands?search=brand 07');
  expect(found.data.length === 1 && found.data[0].name === 'E2E Brand 07', 'search is case-insensitive and server-side');
  const renamed = (await call(P, 'PATCH', `/partner/brands/${b1.id}`, { name: 'E2E Brand Uno' })).data;
  expect(renamed.name === 'E2E Brand Uno', 'rename');
  await rejects('rename to an existing name', call(P, 'PATCH', `/partner/brands/${b1.id}`, { name: 'e2e brand 02' }), 409);
  await call(P, 'PATCH', `/partner/brands/${created.brands[1]}`, { status: 'inactive' });

  section('Brands (customer lookup + "add new brand")');
  const look = await call(C, 'GET', '/client/brands?search=E2E Brand&limit=5');
  expect(look.data.length === 5 && look.meta.total === 22, 'inactive brand hidden, paginated (5 of 22)');
  expect(look.data.every((b) => Object.keys(b).sort().join() === 'id,name'), 'lookup exposes only id + name');
  const added = await call(C, 'POST', '/client/brands', { name: 'E2E Customer Brand' });
  created.brands.push(added.data.id);
  expect(added.statusCode === 201 && added.data.name === 'E2E Customer Brand', 'customer can add a new brand (201)');
  const again = await call(C, 'POST', '/client/brands', { name: 'e2e customer brand' });
  expect(again.statusCode === 200 && again.data.id === added.data.id, 'same name returns the existing brand (200)');
  await rejects('add a switched-off brand', call(C, 'POST', '/client/brands', { name: 'E2E Brand 02' }), 409);

  // ───────────────────────── Couriers ─────────────────────────
  section('Couriers');
  const c1 = (await call(P, 'POST', '/partner/couriers', { name: 'E2E Courier A', requires_tracking: true })).data;
  const c2 = (await call(P, 'POST', '/partner/couriers', { name: 'E2E Courier B (no tracking)', requires_tracking: false })).data;
  created.couriers.push(c1.id, c2.id);
  expect(c1.requires_tracking === true && c2.requires_tracking === false, 'requires_tracking stored');
  await rejects('duplicate courier', call(P, 'POST', '/partner/couriers', { name: 'E2E COURIER A' }), 409);
  const cl = await call(C, 'GET', '/client/couriers?search=E2E Courier');
  expect(cl.data.length === 2 && cl.data.every((c) => 'requires_tracking' in c), 'customer lookup includes requires_tracking');
  const cu = (await call(P, 'PATCH', `/partner/couriers/${c2.id}`, { requires_tracking: true })).data;
  expect(cu.requires_tracking === true, 'toggle requires_tracking');
  await call(P, 'PATCH', `/partner/couriers/${c2.id}`, { requires_tracking: false });

  // ───────────────────────── Article types + articles ─────────────────────────
  section('Article types and articles (generic)');
  const base = await call(C, 'GET', '/client/article-types?limit=50');
  const names = base.data.map((t) => t.name);
  expect(['Neckline', 'Sleeves', 'Trouser'].every((n) => names.includes(n)), `default types present for customers (${names.join(', ')})`);
  const collar = (await call(P, 'POST', '/partner/article-types', { name: 'E2E Collar' })).data;
  created.types.push(collar.id);
  await rejects('duplicate type', call(P, 'POST', '/partner/article-types', { name: 'e2e collar' }), 409);
  const lookupBefore = await call(C, 'GET', '/client/article-types?search=E2E Collar');
  expect(lookupBefore.data.length === 0, 'a type with no active article is not offered to customers');
  const mk = async (name, extra = {}) => {
    const a = (await call(P, 'POST', '/partner/articles', { article_type_id: collar.id, name, ...extra })).data;
    created.articles.push(a.id);
    return a;
  };
  const chinese = await mk('E2E Chinese Collar', { customer_price: 150.5, partner_cost: 100, image_upload: { name: 'c.png', dataUrl: PNG } });
  const peter = await mk('E2E Peter Pan Collar', { customer_price: 0 });
  const shirt = await mk('E2E Shirt Collar');
  expect(chinese.customer_price === 150.5 && chinese.partner_cost === 100 && chinese.margin === 50.5 && /^https?:\/\//.test(chinese.image_url || ''), 'article with price and uploaded image');
  const img = await fetch(chinese.image_url);
  expect(img.status === 200 && /image\/png/.test(img.headers.get('content-type') || ''), 'uploaded image is publicly reachable');
  await rejects('negative price', call(P, 'POST', '/partner/articles', { article_type_id: collar.id, name: 'E2E Bad Price', partner_cost: -5 }), 400);
  await rejects('non-image upload', call(P, 'POST', '/partner/articles', { article_type_id: collar.id, name: 'E2E Bad Img', image_upload: { name: 'x', dataUrl: 'data:text/plain;base64,aGk=' } }), 400);
  await rejects('duplicate article in a type', call(P, 'POST', '/partner/articles', { article_type_id: collar.id, name: 'e2e chinese collar' }), 409);
  await rejects('unknown article type', call(P, 'POST', '/partner/articles', { article_type_id: '00000000-0000-0000-0000-000000000000', name: 'E2E X' }), 404);
  for (let i = 1; i <= 24; i++) await mk(`E2E Cuff ${String(i).padStart(2, '0')}`);
  const list = await call(P, 'GET', `/partner/articles?type_id=${collar.id}&limit=10&page=2&search=E2E`);
  expect(list.data.length === 10 && list.meta.total === 27 && list.data.every((a) => 'customer_price' in a && 'partner_cost' in a && 'margin' in a), 'partner list is paginated and includes customer price, partner cost and margin');
  const types = await call(P, 'GET', '/partner/article-types?search=E2E Collar');
  expect(types.data[0]?.articles_count === 27, 'article type shows articles_count');

  const clientTypes = await call(C, 'GET', '/client/article-types?search=E2E Collar');
  expect(clientTypes.data.length === 1, 'type appears for customers as soon as it has an active article (no code change)');
  const clientArticles = await call(C, 'GET', `/client/articles?type_id=${collar.id}&limit=10&search=Collar`);
  expect(clientArticles.data.length === 3 && clientArticles.meta.total === 3, 'customer article search (3 collars)');
  expect(clientArticles.data.every((a) => !('customer_price' in a) && !('partner_cost' in a) && !('margin' in a) && Object.keys(a).sort().join() === 'article_type_id,id,image_url,name'), 'customer articles never carry a price');
  const clientPage = await call(C, 'GET', `/client/articles?type_id=${collar.id}&limit=10&page=3`);
  expect(clientPage.data.length === 7 && clientPage.meta.total === 27 && clientPage.meta.hasMore === false, `customer article paging (last page has the remaining ${clientPage.data.length} of ${clientPage.meta.total})`);
  await rejects('type_id is required', call(C, 'GET', '/client/articles'), 400);
  await call(P, 'PATCH', `/partner/articles/${shirt.id}`, { status: 'inactive' });
  const afterOff = await call(C, 'GET', `/client/articles?type_id=${collar.id}&search=Shirt`);
  expect(afterOff.data.length === 0, 'inactive article hidden from customers');
  const upd = (await call(P, 'PATCH', `/partner/articles/${peter.id}`, { customer_price: 12, partner_cost: 20, remove_image: true })).data;
  expect(upd.customer_price === 12 && upd.margin === -8 && upd.image_url === null, 'update prices (negative margin allowed) / remove image');
  await rejects('type with articles cannot be deleted', call(P, 'DELETE', `/partner/article-types/${collar.id}`), 409, /still has/);

  // ───────────────────────── Orders ─────────────────────────
  section('Order creation rules');
  const brand = (await call(C, 'GET', '/client/brands?search=Sapphire')).data[0];
  const neck = (await call(C, 'GET', '/client/article-types?search=Neckline')).data[0];
  const necks = (await call(C, 'GET', `/client/articles?type_id=${neck.id}`)).data;
  const sleevesType = (await call(C, 'GET', '/client/article-types?search=Sleeves')).data[0];
  const sleeves = (await call(C, 'GET', `/client/articles?type_id=${sleevesType.id}`)).data;
  expect(brand && necks.length >= 2 && sleeves.length >= 1, 'seeded brand / neckline / sleeves available');
  const unit = (extra = {}) => ({ unit_title: 'E2E Lawn 3-pc', quantity: 1, article_ids: [], ...extra });
  const body = (extra = {}) => ({ brand_id: brand.id, courier_id: c1.id, tracking_number: 'E2E-TRK-1', international_shipping: true, units: [unit()], ...extra });
  await rejects('no brand', call(C, 'POST', '/client/orders', body({ brand_id: undefined })), 400, /brand/i);
  await rejects('no courier', call(C, 'POST', '/client/orders', body({ courier_id: undefined })), 400, /courier/i);
  await rejects('international shipping not chosen', call(C, 'POST', '/client/orders', body({ international_shipping: undefined })), 400, /international/i);
  await rejects('international shipping as text', call(C, 'POST', '/client/orders', body({ international_shipping: 'maybe' })), 400);
  await rejects('tracking required for this courier', call(C, 'POST', '/client/orders', body({ tracking_number: '' })), 400, /tracking/i);
  await rejects('inactive brand', call(C, 'POST', '/client/orders', body({ brand_id: created.brands[1] })), 400, /not available/);
  await rejects('no products', call(C, 'POST', '/client/orders', body({ units: [] })), 400);
  await rejects('missing product name', call(C, 'POST', '/client/orders', body({ units: [unit({ unit_title: ' ' })] })), 400);
  await rejects('bad product link', call(C, 'POST', '/client/orders', body({ units: [unit({ product_link: 'ftp://x' })] })), 400, /link/i);
  await rejects('two necklines on one piece', call(C, 'POST', '/client/orders', body({ units: [unit({ article_ids: [necks[0].id, necks[1].id] })] })), 400, /only one/i);
  await rejects('inactive article', call(C, 'POST', '/client/orders', body({ units: [unit({ article_ids: [shirt.id] })] })), 400, /not available/);
  await rejects('article id that does not exist', call(C, 'POST', '/client/orders', body({ units: [unit({ article_ids: ['00000000-0000-0000-0000-000000000000'] })] })), 400);

  const o1 = (await call(C, 'POST', '/client/orders', body({
    note: 'E2E: please call before cutting', priority: 'rush', shipping_service: 'standard', unit_price: 999,
    units: [unit({ product_link: 'https://example.com/p/1', article_ids: [necks[0].id, sleeves[0].id, chinese.id] }), unit({ unit_title: 'E2E Second piece' })],
  }))).data;
  created.order = o1.id;
  expect(o1.shipping_service === 'express' && o1.international_shipping === true, 'International = Yes → Express (client value "standard" ignored)');
  expect(o1.priority === 'normal', 'rush is gone: priority stays normal');
  expect(o1.courier?.name === 'E2E Courier A' && o1.tracking_number === 'E2E-TRK-1' && o1.brand === 'Sapphire' && o1.brand_ref?.id === brand.id, 'brand/courier/tracking stored by reference');
  const picks = o1.units[0].selected_articles.map((p) => `${p.type_name}:${p.name}`);
  expect(picks.length === 3 && picks.includes('E2E Collar:E2E Chinese Collar'), `selections saved incl. the new type (${picks.join(', ')})`);
  expect(JSON.stringify(o1).includes('"price"') === false && !('unit_price' in o1.units[0]), 'customer order detail contains no price');
  expect(o1.units[0].design.e2e_collar === 'E2E Chinese Collar', 'legacy design map filled for partner screens');
  const adminView = (await call(A, 'GET', `/admin/orders/${o1.id}`)).data;
  const adminPick = adminView.units[0].selected_articles.find((p) => p.name === 'E2E Chinese Collar');
  expect(adminPick?.customer_price === 150.5 && adminPick?.partner_cost === 100 && adminView.courier?.name === 'E2E Courier A', 'admin sees the internal price and the courier');

  const o2 = (await call(C, 'POST', '/client/orders', body({ courier_id: c2.id, tracking_number: '', international_shipping: false }))).data;
  expect(o2.shipping_service === 'standard' && o2.tracking_number === null, 'International = No → Standard; tracking optional for this courier');

  section('Order edit');
  const u0 = o1.units[0];
  const edited = (await call(C, 'PATCH', `/client/orders/${o1.id}`, {
    brand_id: brand.id, courier_id: c1.id, tracking_number: 'E2E-TRK-2', international_shipping: false,
    units: [{ ...unit({ id: u0.id, unit_title: u0.unit_title, article_ids: [necks[1].id, chinese.id] }) }, { ...unit({ id: o1.units[1].id, unit_title: o1.units[1].unit_title }) }],
  })).data;
  expect(edited.shipping_service === 'standard' && edited.tracking_number === 'E2E-TRK-2', 'edit switches shipping type with the answer');
  expect(edited.units[0].selected_articles.map((p) => p.name).sort().join() === `${necks[1].name},E2E Chinese Collar`.split(',').sort().join(), 'edit replaces the selections');
  await call(P, 'PATCH', `/partner/articles/${chinese.id}`, { status: 'inactive' });
  const kept = (await call(C, 'PATCH', `/client/orders/${o1.id}`, { units: [unit({ id: u0.id, unit_title: u0.unit_title, article_ids: [chinese.id] }), unit({ id: o1.units[1].id, unit_title: o1.units[1].unit_title })] })).data;
  expect(kept.units[0].selected_articles.some((p) => p.name === 'E2E Chinese Collar'), 'an article that was switched off stays on a piece that already had it');
  await rejects('…but cannot be newly picked', call(C, 'POST', '/client/orders', body({ units: [unit({ article_ids: [chinese.id] })] })), 400);

  section('Deleting used catalogue rows keeps history');
  const del = await call(P, 'DELETE', `/partner/articles/${chinese.id}`);
  expect(del.data.deactivated === true && /deactivated/.test(del.message), 'used article is deactivated, not deleted');
  const delBrand = await call(P, 'DELETE', `/partner/couriers/${c1.id}`);
  expect(delBrand.data.deactivated === true, 'used courier is deactivated, not deleted');
  const delFree = await call(P, 'DELETE', `/partner/brands/${created.brands[2]}`);
  expect(delFree.data.deleted === true, 'unused brand is really deleted');
  created.brands = created.brands.filter((id) => id !== created.brands[2]);
  const renameLive = await call(P, 'PATCH', `/partner/brands/${brand.id}`, { name: 'Sapphire E2E' });
  const afterRename = (await call(C, 'GET', `/client/orders/${o2.id}`)).data;
  expect(afterRename.brand === 'Sapphire E2E', 'renaming a brand updates it on existing orders');
  await call(P, 'PATCH', `/partner/brands/${brand.id}`, { name: 'Sapphire' });

  section('Product link preview');
  await rejects('not a link', call(C, 'POST', '/client/products/preview', { url: 'hello' }), 400);
  const blocked = (await call(C, 'POST', '/client/products/preview', { url: 'http://169.254.169.254/latest/meta-data' })).data;
  expect(blocked.ok === false && /not allowed/i.test(blocked.error || ''), 'internal addresses are refused (SSRF guard)');

  // ───────────────────────── Conversation (REST) ─────────────────────────
  section('Conversation over REST');
  const oid = o1.id;
  const first = (await call(C, 'GET', `/client/orders/${oid}/messages`)).data;
  expect(first.length === 1 && first[0].body === 'E2E: please call before cutting' && first[0].sender_role === 'customer', 'the order note became the first message');
  const sent = (await call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: 'Hello from the customer', client_msg_id: 'e2e-1' })).data;
  const dup = await call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: 'Hello from the customer', client_msg_id: 'e2e-1' });
  expect(dup.statusCode === 200 && dup.data.id === sent.id, 'retrying with the same client_msg_id returns the original (no duplicate)');
  await rejects('empty message', call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: '  ' }), 400);
  await rejects('too long', call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: 'x'.repeat(4001) }), 400);
  await rejects('unknown kind', call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'video', body: 'x' }), 400);
  const convs = await call(P, 'GET', '/partner/conversations?search=SA-&limit=50');
  const mine = convs.data.find((c) => c.order_id === oid);
  expect(mine && mine.unread === 2 && mine.last_message_role === 'customer' && mine.last_message_preview === 'Hello from the customer', 'staff inbox shows unread count and last message');
  expect(convs.meta.unreadConversations >= 1, 'inbox meta has unreadConversations');
  const badges = (await call(P, 'GET', '/partner/badges')).data;
  expect(badges.messages >= 1, 'partner sidebar badge counts unread conversations');
  const staffView = (await call(P, 'GET', `/partner/orders/${oid}/messages`)).data;
  expect(staffView.length === 2, 'staff can read the conversation');
  const notif = (await call(P, 'GET', '/notifications?unread=true&limit=50')).data.find((n) => n.order_id === oid && /New message/.test(n.title));
  expect(!!notif && /partner\/messages\//.test(notif.link || ''), 'staff got ONE "New message" notification with a partner link');
  const read = (await call(P, 'POST', `/partner/orders/${oid}/messages/read`)).data;
  expect(read.updated === 2, 'opening the conversation marks customer messages read');
  const afterRead = (await call(P, 'GET', '/partner/conversations?limit=50')).data.find((c) => c.order_id === oid);
  expect(afterRead.unread === 0, 'unread count drops to 0');
  const reply = (await call(P, 'POST', `/partner/orders/${oid}/messages`, { kind: 'text', body: 'We will call you' })).data;
  expect(reply.sender_role === 'partner_staff' && !!reply.sender_name, 'staff reply carries role and name');
  const custNotif = (await call(C, 'GET', '/notifications?unread=true&limit=50')).data.find((n) => n.order_id === oid && /New message/.test(n.title));
  expect(!!custNotif && /\?chat=1/.test(custNotif.link), 'customer notified with a chat link');

  section('Voice notes');
  const raw = Buffer.alloc(900, 7);
  const dataUrl = `data:audio/webm;codecs=opus;base64,${raw.toString('base64')}`;
  const up = (await call(C, 'POST', `/client/orders/${oid}/messages/voice-upload`, { audio: { dataUrl, duration: 4.2 } })).data;
  expect(up.path.startsWith(`voice/${oid}/${customer.user.id}/`) && up.mime === 'audio/webm' && up.size === 900, 'voice clip stored privately under order/sender folder');
  await rejects('voice too short', call(C, 'POST', `/client/orders/${oid}/messages/voice-upload`, { audio: { dataUrl, duration: 0.1 } }), 400);
  await rejects('voice too long', call(C, 'POST', `/client/orders/${oid}/messages/voice-upload`, { audio: { dataUrl, duration: 301 } }), 400);
  await rejects('wrong audio format', call(C, 'POST', `/client/orders/${oid}/messages/voice-upload`, { audio: { dataUrl: 'data:video/mp4;base64,AAAA', duration: 2 } }), 400);
  const voice = (await call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'voice', audio: { path: up.path, duration: 4.2, mime: up.mime, size: up.size } })).data;
  expect(voice.kind === 'voice' && voice.audio?.url && !('path' in voice.audio) && voice.audio.duration === 4.2, 'voice message exposes a signed url, never the storage path');
  const bytes = Buffer.from(await (await fetch(voice.audio.url)).arrayBuffer());
  expect(bytes.length === 900, 'signed url plays back the stored audio');
  await rejects('voice path of another order/user', call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'voice', audio: { path: `voice/${oid}/${partner.user.id}/x.webm`, duration: 3 } }), 400);
  await rejects('voice path that was never uploaded', call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'voice', audio: { path: `voice/${oid}/${customer.user.id}/missing.webm`, duration: 3 } }), 400);
  const anon = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/documents/${up.path}`);
  expect(anon.status !== 200, `the voice bucket is private (public url answers ${anon.status})`);

  section('History paging (cursor)');
  for (let i = 1; i <= 20; i++) {
    await call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: `E2E customer ${i}` });
    await call(P, 'POST', `/partner/orders/${oid}/messages`, { kind: 'text', body: `E2E partner ${i}` });
  }
  const p1 = await call(C, 'GET', `/client/orders/${oid}/messages?limit=15`);
  expect(p1.data.length === 15 && p1.meta.hasMore && !!p1.meta.nextCursor, 'newest page of 15 with a cursor');
  expect(p1.data.every((m, i, a) => i === 0 || a[i - 1].created_at <= m.created_at), 'a page is ordered oldest → newest');
  const p2 = await call(C, 'GET', `/client/orders/${oid}/messages?limit=15&before=${encodeURIComponent(p1.meta.nextCursor)}`);
  const ids = new Set([...p1.data, ...p2.data].map((m) => m.id));
  expect(p2.data.length === 15 && ids.size === 30 && p2.data.at(-1).created_at <= p1.data[0].created_at, 'older page continues without overlap');
  let cursor = p2.meta.nextCursor;
  let total = 30;
  while (cursor) {
    const pg = await call(C, 'GET', `/client/orders/${oid}/messages?limit=15&before=${encodeURIComponent(cursor)}`);
    total += pg.data.length;
    cursor = pg.meta.nextCursor;
  }
  expect(total === 44, `all history reachable by paging (${total} of 44 messages)`);
  await rejects('garbage cursor', call(C, 'GET', `/client/orders/${oid}/messages?before=nonsense`), 400);

  section('Conversation access control');
  await rejects('another customer cannot read', call(C, 'GET', `/client/orders/00000000-0000-0000-0000-000000000000/messages`), 404);
  await rejects('anonymous', call(null, 'GET', `/client/orders/${oid}/messages`), 401);
  await rejects('customer on the staff route', call(C, 'GET', `/partner/orders/${oid}/messages`), 403);
  await rejects('staff on the customer route', call(P, 'GET', `/client/orders/${oid}/messages`), 403);

  section('Chat per article');
  const ua = o1.units[0].id;
  const ub = o1.units[1].id;
  const sc0 = (await call(C, 'GET', `/client/orders/${oid}/conversation`)).data;
  expect(sc0.scopes.length === 3 && sc0.scopes[0].unit_id === null && sc0.scopes[0].title === 'General' && sc0.scopes.slice(1).every((x) => x.unit_id), 'conversation lists General + one chat per article');
  await call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: 'E2E about piece one', unit_id: ua });
  await call(P, 'POST', `/partner/orders/${oid}/messages`, { kind: 'text', body: 'E2E staff about piece two', unit_id: ub });
  const onlyA = (await call(C, 'GET', `/client/orders/${oid}/messages?unit_id=${ua}`)).data;
  expect(onlyA.length === 1 && onlyA[0].body === 'E2E about piece one' && onlyA[0].unit_id === ua, 'an article chat shows only its own messages');
  const onlyB = (await call(P, 'GET', `/partner/orders/${oid}/messages?unit_id=${ub}`)).data;
  expect(onlyB.length === 1 && onlyB[0].unit_id === ub, 'staff see the other article chat separately');
  const gen = (await call(C, 'GET', `/client/orders/${oid}/messages?unit_id=general&limit=100`)).data;
  expect(gen.length >= 40 && gen.every((m) => m.unit_id === null), 'General shows only the order-level chat');
  const everything = (await call(C, 'GET', `/client/orders/${oid}/messages?limit=100`)).data;
  expect(everything.length === gen.length + 2, 'no filter returns every chat');
  const staffScopes = (await call(P, 'GET', `/partner/orders/${oid}/conversation`)).data;
  expect(staffScopes.scopes.find((x) => x.unit_id === ua).unread === 1 && staffScopes.scopes.find((x) => x.unit_id === ub).unread === 0, 'staff unread count is per article');
  const custScopes = (await call(C, 'GET', `/client/orders/${oid}/conversation`)).data;
  expect(custScopes.scopes.find((x) => x.unit_id === ub).unread === 1 && custScopes.scopes.find((x) => x.unit_id === ua).unread === 0, 'customer unread count is per article');
  expect(custScopes.scopes.find((x) => x.unit_id === ub).last_message_preview === 'E2E staff about piece two', 'each chat shows its last message');
  await call(P, 'POST', `/partner/orders/${oid}/messages/read`, { unit_id: ua });
  const afterOneRead = (await call(P, 'GET', `/partner/orders/${oid}/conversation`)).data;
  expect(afterOneRead.scopes.find((x) => x.unit_id === ua).unread === 0, 'reading one article marks only that chat read');
  const stillB = (await call(C, 'GET', `/client/orders/${oid}/conversation`)).data;
  expect(stillB.scopes.find((x) => x.unit_id === ub).unread === 1, 'the other article chat stays unread');
  await rejects('an article of another order', call(C, 'POST', `/client/orders/${oid}/messages`, { kind: 'text', body: 'x', unit_id: o2.units[0].id }), 400);
  await rejects('a garbage article id', call(C, 'GET', `/client/orders/${oid}/messages?unit_id=nonsense`), 400);
  const artNote = (await call(P, 'GET', '/notifications?limit=100')).data.find((n) => n.order_id === oid && n.title.includes(o1.units[0].unit_title) && /New message/.test(n.title));
  expect(!!artNote && /\?unit=/.test(artNote.link || ''), 'the staff notification names the article and opens its chat');

  const timeline = (await call(C, 'GET', `/client/orders/${oid}`)).data.units;
  expect(timeline.every((u) => Array.isArray(u.timeline)), 'each article carries its own timeline');

  // ───────────────────────── Socket.IO ─────────────────────────
  section('Real time (Socket.IO)');
  await connect('not-a-token').then(
    (s) => {
      s.close();
      fail('bad token should be rejected');
    },
    (e) => {
      e.socket.close();
      expect(/unauthorized/.test(e.message), 'bad token rejected');
    },
  );
  await connect(undefined).then((s) => { s.close(); fail('missing token should be rejected'); }, (e) => { e.socket.close(); ok('missing token rejected'); });
  const sc = await connect(C);
  const sp = await connect(P);
  ok('customer and partner connected with their login tokens');
  const ja = await emit(sc, 'conversation:join', { orderId: oid });
  const jb = await emit(sp, 'conversation:join', { orderId: oid });
  expect(ja.ok && jb.ok, 'both joined the order room');
  const denied = await emit(sc, 'conversation:join', { orderId: o2.id.replace(/.$/, '0') });
  expect(!denied.ok, 'joining an order that is not yours is refused');

  const gotByPartner = waitFor(sp, 'message:new', (m) => m.body === 'live hello');
  const ack = await emit(sc, 'message:send', { orderId: oid, kind: 'text', body: 'live hello', client_msg_id: 'sock-1' });
  const live = await gotByPartner;
  expect(ack.ok && ack.message.id === live.id && live.sender_role === 'customer', 'customer → socket → partner arrives in real time');
  const stored = (await call(P, 'GET', `/partner/orders/${oid}/messages?limit=5`)).data.find((m) => m.id === live.id);
  expect(!!stored, 'and it is persisted in the database');
  const ack2 = await emit(sc, 'message:send', { orderId: oid, kind: 'text', body: 'live hello', client_msg_id: 'sock-1' });
  expect(ack2.ok && ack2.duplicate === true && ack2.message.id === live.id, 'resending over the socket is idempotent');

  const gotByCustomer = waitFor(sc, 'message:new', (m) => m.body === 'live reply');
  const inbox = waitFor(sc, 'inbox:update', (p) => p.orderId === oid);
  await emit(sp, 'message:send', { orderId: oid, kind: 'text', body: 'live reply', client_msg_id: 'sock-2' });
  const back = await gotByCustomer;
  await inbox;
  expect(back.sender_role === 'partner_staff', 'partner → socket → customer arrives in real time (+ inbox:update)');

  const typingSeen = waitFor(sp, 'typing', (t) => t.orderId === oid && t.typing === true);
  sc.emit('typing', { orderId: oid, typing: true });
  expect((await typingSeen).role === 'customer', 'typing indicator is relayed');

  const gotUnit = waitFor(sp, 'message:new', (m) => m.body === 'live unit hello');
  const unitAck = await emit(sc, 'message:send', { orderId: oid, unit_id: ua, kind: 'text', body: 'live unit hello', client_msg_id: 'sock-u1' });
  const unitMsg = await gotUnit;
  expect(unitAck.ok && unitMsg.unit_id === ua, 'a live message about an article carries its unit_id');
  const badUnit = await emit(sc, 'message:send', { orderId: oid, unit_id: o2.units[0].id, kind: 'text', body: 'nope' });
  expect(!badUnit.ok && badUnit.status === 400, 'a live message about an article of another order is refused');

  const readSeen = waitFor(sc, 'message:read', (r) => r.orderId === oid && r.readerRole === 'partner_staff');
  const rr = await emit(sp, 'message:read', { orderId: oid });
  expect(rr.ok && (await readSeen).count >= 1, 'read receipt reaches the sender');

  const vUp = (await call(C, 'POST', `/client/orders/${oid}/messages/voice-upload`, { audio: { dataUrl, duration: 3 } })).data;
  const gotVoice = waitFor(sp, 'message:new', (m) => m.kind === 'voice');
  const vAck = await emit(sc, 'message:send', { orderId: oid, kind: 'voice', audio: { path: vUp.path, duration: 3, mime: vUp.mime, size: vUp.size }, client_msg_id: 'sock-v' });
  const vMsg = await gotVoice;
  expect(vAck.ok && vMsg.audio?.url && (await fetch(vMsg.audio.url)).status === 200, 'voice message metadata over the socket, audio played from storage');

  const bad = await emit(sc, 'message:send', { orderId: oid, kind: 'text', body: '   ' });
  expect(!bad.ok && bad.status === 400, 'validation errors come back as ack errors');
  const strangerAck = await emit(sc, 'message:send', { orderId: '00000000-0000-0000-0000-000000000000', kind: 'text', body: 'hi' });
  expect(!strangerAck.ok, 'cannot send into an order that is not yours');
  const notRoom = await new Promise((resolve) => {
    const s2 = sp; // partner already left?
    s2.emit('conversation:leave', { orderId: oid });
    let got = false;
    s2.once('message:new', () => (got = true));
    emit(sc, 'message:send', { orderId: oid, kind: 'text', body: 'after leave' }).then(() => setTimeout(() => resolve(got), 600));
  });
  expect(notRoom === false, 'after leaving the room no more live messages arrive');
  sc.close();
  sp.close();

  // rate limit last (it blocks the user for a minute)
  section('Rate limit');
  let limited = 0;
  for (let i = 0; i < 35; i++) {
    try {
      await call(A, 'POST', `/partner/orders/${oid}/messages`, { kind: 'text', body: `E2E flood ${i}` });
    } catch (e) {
      if (e.status === 429) limited++;
    }
  }
  expect(limited >= 4, `flooding is limited (${limited} requests got 429)`);
}

/** Remove everything this test creates (every name starts with "E2E"). Safe to run before and after. */
async function purge() {
  const { data: units } = await supabaseAdmin.from('order_units').select('order_id').like('unit_title', 'E2E%');
  const orderIds = [...new Set((units || []).map((u) => u.order_id))];
  if (orderIds.length) await supabaseAdmin.from('orders').delete().in('id', orderIds); // pieces, chat, timeline, notifications cascade
  await supabaseAdmin.from('articles').delete().like('name', 'E2E%');
  await supabaseAdmin.from('article_types').delete().like('name', 'E2E%');
  await supabaseAdmin.from('couriers').delete().like('name', 'E2E%');
  await supabaseAdmin.from('brands').delete().like('name', 'E2E%');
}

async function cleanup() {
  section('Cleanup');
  try {
    await purge();
    ok('all E2E test orders and catalogue rows removed');
  } catch (e) {
    console.log('  cleanup problem:', e.message);
  }
}

await purge().catch(() => {});
try {
  await main();
} catch (e) {
  fail(`unexpected error: ${e.message}`);
}
await cleanup();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
