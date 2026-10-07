/**
 * End-to-end test of the whole order flow through the HTTP API (backend must be running).
 * Uses the accounts created by `npm run seed`. Creates one real order labelled "E2E TEST".
 *
 *   npm run test:flow
 */
import 'dotenv/config';
import Stripe from 'stripe';

const BASE = process.env.API_URL || 'http://localhost:5000/api';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${json.message}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const login = async (email) => (await call(null, 'POST', '/auth/login', { email, password: PASSWORD })).data;

async function main() {
  console.log('Login');
  const customer = await login('customer@v360.test');
  const partner = await login('partner@v360.test');
  const admin = await login('admin@v360.test');
  const C = customer.tokens.accessToken;
  const P = partner.tokens.accessToken;
  const A = admin.tokens.accessToken;
  expect(customer.user.role === 'customer' && partner.user.role === 'partner_staff' && admin.user.role === 'admin', 'roles come from profiles');
  expect(/^STX-\d+$/.test(customer.user.customer_code || ''), `customer code ${customer.user.customer_code}`);

  console.log('Permissions');
  for (const [token, path, who] of [[C, '/admin/overview', 'customer→admin'], [C, '/partner/overview', 'customer→partner'], [P, '/admin/overview', 'partner→admin'], [A, '/client/orders', 'admin→client']]) {
    try {
      await call(token, 'GET', path);
      fail(`${who} should be forbidden`);
    } catch (e) {
      expect(e.status === 403, `${who} blocked (${e.status})`);
    }
  }
  try {
    await call(null, 'GET', '/admin/orders');
    fail('anonymous should be rejected');
  } catch (e) {
    expect(e.status === 401, 'anonymous rejected (401)');
  }

  console.log('Customer creates order');
  const size = (await call(C, 'POST', '/client/sizes', { person_name: 'Me', variation: 'E2E v1', measurements: { shoulder: 14.5, bust: 36, waist: 30.5, hip: 39 } })).data;
  const brandId = (await call(C, 'GET', '/client/brands?search=Sapphire')).data[0].id;
  const courierId = (await call(C, 'GET', '/client/couriers?search=TCS')).data[0].id;
  const neckType = (await call(C, 'GET', '/client/article-types?search=Neckline')).data[0];
  const neckId = (await call(C, 'GET', `/client/articles?type_id=${neckType.id}&limit=1`)).data[0].id;
  const order = (await call(C, 'POST', '/client/orders', {
    brand_id: brandId, courier_id: courierId, tracking_number: 'TCS-E2E', international_shipping: true, brand_order_number: 'E2E TEST',
    units: [
      { unit_title: 'E2E Embroidered lawn 3-pc', stitching_type: 'Plain 3-pc', size_chart_id: size.id, article_ids: [neckId], notes: 'Lace on sleeves' },
      { unit_title: 'E2E Printed lawn 2-pc', stitching_type: 'Plain 2-pc', size_chart_id: size.id },
    ],
  })).data;
  expect(/^SA-\d+$/.test(order.reference) && order.status === 'submitted', `order ${order.reference} submitted`);
  expect(order.units.length === 2 && order.units[0].line_no === 1, 'units saved in order');
  const list = await call(C, 'GET', `/client/orders?search=${order.reference}&limit=5`);
  expect(list.data.length === 1 && list.meta.total === 1, 'customer search + pagination meta');

  console.log('Partner receives');
  const recv = await call(P, 'GET', `/partner/receiving?tab=expected&search=${order.reference}`);
  expect(recv.data.length === 1, 'order appears in Expected');
  const [u1, u2] = order.units;
  await call(P, 'POST', `/partner/receiving/units/${u1.id}/receive`);
  await call(P, 'POST', `/partner/receiving/units/${u2.id}/issue`, { issue_type: 'piece_missing', note: 'E2E: dupatta missing' });
  let detail = (await call(A, 'GET', `/admin/orders/${order.id}`)).data;
  expect(detail.status === 'received' && detail.has_issue, 'order received with issue flag');
  await call(A, 'POST', `/admin/orders/${order.id}/units/${u2.id}/resolve`, { note: 'Brand sent the dupatta' });

  console.log('Production board');
  const board = (await call(P, 'GET', `/partner/production/board?search=${order.reference}`)).data;
  const toAssign = board.columns.find((c) => c.stage === 'to_assign');
  expect(toAssign.items.length === 2, 'two job cards in To assign');
  const [c1, c2] = toAssign.items;
  const assigned = (await call(P, 'POST', `/partner/production/cards/${c1.id}/assign`)).data;
  expect(assigned.card.stage === 'cutting' && assigned.card.master, `assigned to ${assigned.card.master?.name}`);
  const moved = (await call(P, 'PUT', `/partner/production/cards/${c2.id}/move`, { stage: 'cutting', prevId: c1.id, nextId: null })).data;
  expect(moved.card.master && moved.orderStatus === 'cutting', 'drag to Cutting auto-assigns master, order = cutting');
  for (const c of [c1, c2]) await call(P, 'PUT', `/partner/production/cards/${c.id}/move`, { stage: 'stitching', prevId: null, nextId: null });
  const card = (await call(P, 'GET', `/partner/production/cards/${c1.id}`)).data;
  expect(card.tailor && card.activity.length >= 2, `tailor ${card.tailor?.name} auto-assigned, activity logged`);
  const col = (await call(P, 'GET', '/partner/production/columns/stitching?limit=5')).data;
  expect(Array.isArray(col.items) && 'nextCursor' in col, 'column pagination endpoint');
  for (const c of [c1, c2]) await call(P, 'PUT', `/partner/production/cards/${c.id}/move`, { stage: 'qc', prevId: null, nextId: null });

  console.log('Quality check + pack');
  await call(P, 'PATCH', `/partner/production/cards/${c1.id}/qc-checklist`, { checklist: { measurements: true, seams: true } });
  for (const c of [c1, c2]) await call(P, 'POST', `/partner/qc/cards/${c.id}/pass`, { notes: 'E2E ok' });
  detail = (await call(A, 'GET', `/admin/orders/${order.id}`)).data;
  expect(detail.status === 'qc_passed', 'order qc_passed');

  console.log('Customer approval, one article at a time');
  const byUnit = (view, unitId) => view.units.find((u) => u.id === unitId);
  await call(P, 'POST', `/partner/qc/cards/${c1.id}/request-approval`, { photos: [{ name: 'front.png', dataUrl: PNG }] });
  let view = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(view.status === 'customer_approval', 'order shows "awaiting your approval" while one article waits');
  expect(byUnit(view, c1.unit_id).approval.status === 'pending' && byUnit(view, c1.unit_id).approval.photos.length === 1, 'article 1 has its own photo awaiting approval');
  expect(byUnit(view, c2.unit_id).approval.status === 'none' && byUnit(view, c2.unit_id).approval.photos.length === 0, 'article 2 has nothing sent yet');
  try {
    await call(P, 'POST', `/partner/qc/orders/${order.id}/pack`, { weight_kg: 1.2 });
    fail('packing should wait for the customer');
  } catch (e) {
    expect(e.status === 400, 'cannot pack while an article waits for approval');
  }
  await call(P, 'POST', `/partner/qc/cards/${c2.id}/request-approval`, { photos: [{ name: 'a.png', dataUrl: PNG }, { name: 'b.png', dataUrl: PNG }] });
  view = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(byUnit(view, c2.unit_id).approval.photos.length === 2 && byUnit(view, c1.unit_id).approval.photos.length === 1, 'each article keeps its own photos');
  try {
    await call(C, 'POST', `/client/orders/${order.id}/request-changes`, { unit_id: c2.unit_id, note: '' });
    fail('empty change request should be refused');
  } catch (e) {
    expect(e.status === 400, 'a change request needs a note or a voice note');
  }
  await call(C, 'POST', `/client/orders/${order.id}/request-changes`, { unit_id: c2.unit_id, note: 'E2E: sleeves slightly longer' });
  view = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(byUnit(view, c2.unit_id).approval.status === 'changes_requested' && byUnit(view, c1.unit_id).approval.status === 'pending', 'only article 2 was sent back; article 1 still waits');
  expect(view.status === 'customer_approval', 'order still waits for article 1');
  const card2 = (await call(P, 'GET', `/partner/production/cards/${c2.id}`)).data;
  expect(card2.stage === 'stitching' && card2.approval_status === 'changes_requested' && /sleeves/.test(card2.change_request || ''), 'partner sees the change request on that ticket only');
  const card1 = (await call(P, 'GET', `/partner/production/cards/${c1.id}`)).data;
  expect(card1.stage === 'qc' && card1.approval_status === 'pending', 'ticket 1 is untouched');
  const ok1 = (await call(C, 'POST', `/client/orders/${order.id}/approve`, { unit_id: c1.unit_id })).data;
  expect(ok1.approved === 1 && ok1.stillWaiting === 0, 'article 1 approved on its own');
  view = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(byUnit(view, c1.unit_id).approval.status === 'approved' && view.status === 'stitching', 'order is back to stitching while article 2 is reworked');
  try {
    await call(C, 'POST', `/client/orders/${order.id}/approve`, { unit_id: c1.unit_id });
    fail('approving twice should be refused');
  } catch (e) {
    expect(e.status === 400, 'cannot approve the same article twice');
  }
  // article 2: reworked, QC again, new photos, approved
  await call(P, 'PUT', `/partner/production/cards/${c2.id}/move`, { stage: 'qc', prevId: null, nextId: null });
  await call(P, 'POST', `/partner/qc/cards/${c2.id}/pass`, { notes: 'E2E reworked' });
  await call(P, 'POST', `/partner/qc/cards/${c2.id}/request-approval`, { photos: [{ name: 'again.png', dataUrl: PNG }] });
  view = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(byUnit(view, c2.unit_id).approval.status === 'pending' && byUnit(view, c2.unit_id).approval.photos.length === 1 && !byUnit(view, c2.unit_id).approval.change_request, 'new photos replace the old round for article 2');
  await call(C, 'POST', `/client/orders/${order.id}/approve`, { unit_id: c2.unit_id });
  detail = (await call(A, 'GET', `/admin/orders/${order.id}`)).data;
  expect(detail.status === 'qc_passed', 'all articles approved, order ready to pack');

  await call(P, 'POST', `/partner/qc/orders/${order.id}/pack`, { weight_kg: 1.2 });
  detail = (await call(A, 'GET', `/admin/orders/${order.id}`)).data;
  expect(detail.status === 'packed', 'order packed');

  console.log('Admin invoice');
  const builder = (await call(A, 'GET', `/admin/invoices/builder/${order.id}`)).data;
  expect(builder.suggestedLines?.length >= 2, `${builder.suggestedLines?.length} suggested lines, currency ${builder.currency}`);
  const draft = (await call(A, 'PUT', `/admin/invoices/builder/${order.id}`, {
    currency: builder.currency, fx_rate: builder.currency === 'PKR' ? 1 : builder.suggestedFxRate || 360,
    lines: [...builder.suggestedLines, { kind: 'discount', label: 'E2E discount', customer_amount: 500, partner_amount: 0 }],
  })).data;
  expect(draft.status === 'draft' && draft.total_pkr > 0 && draft.partner_total_pkr > 0, `draft ${draft.number} total PKR ${draft.total_pkr}, partner PKR ${draft.partner_total_pkr}`);
  await call(A, 'POST', `/admin/invoices/${draft.id}/issue`);
  const custView = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(custView.status === 'awaiting_payment' && custView.invoice && custView.invoice.lines.every((l) => !('partner_amount' in l)), 'customer sees invoice without partner amounts');

  console.log('Customer pays');
  if (process.env.STRIPE_SECRET_KEY) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const start = (await call(C, 'POST', `/client/orders/${order.id}/payment-intent`)).data;
    await stripe.paymentIntents.confirm(start.paymentIntentId, { payment_method: 'pm_card_visa' }); // Stripe's test card
    await call(C, 'POST', `/client/orders/${order.id}/payment-intent/confirm`, { payment_intent_id: start.paymentIntentId });
  } else {
    await call(C, 'POST', `/client/orders/${order.id}/pay`); // local development without Stripe keys
  }
  detail = (await call(A, 'GET', `/admin/orders/${order.id}`)).data;
  expect(detail.status === 'paid' && detail.payments.length === 1, 'order paid, payment recorded');

  console.log('Dispatch via admin warehouse');
  const routed = (await call(P, 'POST', `/partner/warehouse/orders/${order.id}/route`, { route: 'admin_warehouse' })).data;
  expect(routed.transfer?.code, `added to ${routed.transfer?.code}`);
  await call(P, 'POST', `/partner/warehouse/transfers/${routed.transfer.id}/dispatch`);
  await call(A, 'POST', `/admin/warehouse/transfers/${routed.transfer.id}/receive`);
  const parcels = await call(A, 'GET', `/admin/warehouse/parcels?status=needs_label&search=${order.reference}`);
  expect(parcels.data.length === 1, 'parcel needs label');
  const parcel = parcels.data[0];
  const options = (await call(A, 'GET', `/admin/warehouse/parcels/${parcel.id}/courier-options`)).data;
  const rate = options.find((o) => o.recommended) || options[0];
  await call(A, 'POST', `/admin/warehouse/parcels/${parcel.id}/label`, { shipping_rate_id: rate?.id, courier: rate?.courier || 'DHL', tracking_number: 'E2E123456', rate_pkr: rate?.price_pkr });
  await call(A, 'POST', `/admin/warehouse/parcels/${parcel.id}/handed`);
  await call(A, 'POST', `/admin/warehouse/parcels/${parcel.id}/delivered`);
  const final = (await call(C, 'GET', `/client/orders/${order.id}`)).data;
  expect(final.status === 'delivered' && final.shipment?.tracking_number === 'E2E123456', 'customer sees delivered + tracking');
  expect(final.events.length >= 8, `timeline has ${final.events.length} events`);

  console.log('Dashboards & notifications');
  for (const [token, path] of [[C, '/client/overview'], [P, '/partner/overview?range=30days'], [P, '/partner/earnings/summary'], [A, '/admin/overview'], [A, '/admin/reports'], [A, '/admin/badges'], [P, '/partner/badges']]) {
    await call(token, 'GET', path);
    ok(`GET ${path}`);
  }
  const notes = await call(C, 'GET', '/notifications?limit=50');
  expect(notes.meta.unreadCount > 0 && notes.data.some((n) => n.order_id === order.id), `customer has ${notes.meta.unreadCount} unread notifications`);
  const adminNotes = await call(A, 'GET', '/notifications?limit=5');
  expect(adminNotes.data.length > 0, 'admin received notifications');

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✗ Stopped: ${err.message}`);
  process.exit(1);
});
