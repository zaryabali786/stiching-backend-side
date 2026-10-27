/**
 * The text on a home banner: what the server keeps of the heading, the small text, the button and its colours. No database.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

let ctl;
const dbProxy = new Proxy({}, { get: () => () => ({}) });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  ctl = await import('../src/controllers/banner.controller.js');
});

test('a new banner gets every field, cleaned, with the defaults for what was left out', () => {
  const c = ctl.cleanBannerCopy({ heading: '  We tailor   each garment by hand ', subheading: 'Your bespoke wardrobe', button_label: 'Place new order!', button_link: '/app/orders/new', text_color: '#ffeedd', overlay: 50, text_align: 'center' });
  assert.deepEqual(c, {
    heading: 'We tailor each garment by hand', subheading: 'Your bespoke wardrobe', button_label: 'Place new order!', button_link: '/app/orders/new',
    text_color: '#FFEEDD', button_bg: '#FFFFFF', button_color: '#62003E', overlay: 50, text_align: 'center', focus_x: 50, focus_y: 50,
  });
});

test('empty text becomes nothing; a banner with no text keeps working', () => {
  const c = ctl.cleanBannerCopy({});
  assert.equal(c.heading, null);
  assert.equal(c.button_label, null);
  assert.equal(c.button_link, null);
  assert.equal(c.overlay, 35);
  assert.equal(c.text_align, 'left');
});

test('colours, the dark layer and the position are put right when they are wrong', () => {
  const c = ctl.cleanBannerCopy({ text_color: 'red', button_bg: '#12', overlay: 500, text_align: 'right' });
  assert.equal(c.text_color, '#FFFFFF');
  assert.equal(c.button_bg, '#FFFFFF');
  assert.equal(c.overlay, 80);
  assert.equal(c.text_align, 'left');
  assert.equal(ctl.cleanBannerCopy({ overlay: -9 }).overlay, 0);
  assert.equal(ctl.cleanBannerCopy({ overlay: 'abc' }).overlay, 35);
});

test('the heading and the small text are cut to their length', () => {
  const c = ctl.cleanBannerCopy({ heading: 'x'.repeat(200), subheading: 'y'.repeat(400), button_label: 'z'.repeat(100) });
  assert.equal(c.heading.length, 80);
  assert.equal(c.subheading.length, 160);
  assert.equal(c.button_label.length, 40);
});

test('the button goes to a page of the app or a web address; anything else is refused', () => {
  assert.equal(ctl.cleanBannerCopy({ button_link: 'https://example.com/sale' }).button_link, 'https://example.com/sale');
  assert.throws(() => ctl.cleanBannerCopy({ button_link: 'javascript:alert(1)' }), /full address|http/);
  assert.throws(() => ctl.cleanBannerCopy({ button_link: 'not a link' }), /full address/);
});

test('an edit changes only what was sent', () => {
  assert.deepEqual(ctl.cleanBannerCopy({ heading: 'New' }, { partial: true }), { heading: 'New' });
  assert.deepEqual(ctl.cleanBannerCopy({}, { partial: true }), {});
  assert.deepEqual(ctl.cleanBannerCopy({ button_label: '' }, { partial: true }), { button_label: null });
});

test('the part of the picture kept in view is a percent; a wrong value is the middle', () => {
  assert.deepEqual(ctl.cleanBannerCopy({ focus_x: 20, focus_y: 0 }, { partial: true }), { focus_x: 20, focus_y: 0 });
  assert.equal(ctl.cleanBannerCopy({ focus_y: 400 }).focus_y, 100);
  assert.equal(ctl.cleanBannerCopy({ focus_y: -5 }).focus_y, 0);
  assert.equal(ctl.cleanBannerCopy({ focus_x: 'x' }).focus_x, 50);
  assert.equal(ctl.cleanBannerCopy({}).focus_y, 50);
});
