/**
 * The Stitch&Ship page inside the brand's Shopify admin: the session token is the only proof of which store is asking, so it must
 * only be accepted when it is signed with the app's secret, made for this app and not expired. No network, no database.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { createFakeDb } from './fake-supabase.mjs';

const SECRET = 'test-shopify-secret';
const KEY = 'test-key';
let emb;
const db = createFakeDb({});

before(async () => {
  process.env.SHOPIFY_APP_API_KEY = KEY;
  process.env.SHOPIFY_APP_API_SECRET = SECRET;
  process.env.SHOPIFY_APP_URL = 'https://api.example.test';
  process.env.SHOPIFY_TOKEN_KEY = crypto.randomBytes(32).toString('hex');
  process.env.SHOPIFY_SCOPES = 'read_orders,write_orders,read_products,write_products,write_shipping';
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: db, supabase: db } });
  emb = await import('../src/services/shopify-embedded.service.js');
});

const token = ({ secret = SECRET, aud = KEY, dest = 'https://my-brand.myshopify.com', iss = 'https://my-brand.myshopify.com/admin', exp = '2m' } = {}) =>
  new SignJWT({ dest }).setProtectedHeader({ alg: 'HS256' }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(new TextEncoder().encode(secret));

test('a session token signed for this app names the store', async () => {
  assert.equal(await emb.shopFromSessionToken(await token()), 'my-brand.myshopify.com');
});

test('a token with the wrong secret, the wrong app, another store in iss, or no token at all is refused', async () => {
  assert.equal(await emb.shopFromSessionToken(await token({ secret: 'someone-elses-secret' })), null);
  assert.equal(await emb.shopFromSessionToken(await token({ aud: 'another-app' })), null);
  assert.equal(await emb.shopFromSessionToken(await token({ iss: 'https://other.myshopify.com/admin' })), null);
  assert.equal(await emb.shopFromSessionToken(await token({ dest: 'https://evil.com' })), null);
  assert.equal(await emb.shopFromSessionToken(''), null);
  assert.equal(await emb.shopFromSessionToken('not.a.jwt'), null);
});

test('an expired token is refused', async () => {
  const old = await token({ exp: Math.floor(Date.now() / 1000) - 120 });
  assert.equal(await emb.shopFromSessionToken(old), null);
});

test('permissions: write implies read, and what is missing is listed', () => {
  const ok = emb.permissionStatus('write_orders,write_products,write_shipping');
  assert.equal(ok.up_to_date, true);
  const old = emb.permissionStatus('read_orders,write_orders,read_products');
  assert.deepEqual(old.missing, ['write_products', 'write_shipping']);
  assert.equal(old.groups.find((g) => g.key === 'products').granted, false);
});

test('order statuses are in the brand\'s words', () => {
  assert.equal(emb.orderStatus({ state: 'draft_created', notified_at: null }).tone, 'warning');
  assert.equal(emb.orderStatus({ state: 'draft_created', notified_at: 'x' }).label, "Waiting for the customer's sizes");
  assert.equal(emb.orderNeedsAttention({ state: 'failed' }), true);
  assert.equal(emb.orderNeedsAttention({ state: 'draft_created', notified_at: 'x' }), false);
});
