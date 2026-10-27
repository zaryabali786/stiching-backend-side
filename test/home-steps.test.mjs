/**
 * The "How it works" section of the home page (a row of cards) and the icons the admin uploads for them: what the server keeps of the
 * cards, and which SVG files it accepts. No database, no network.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

let home;
let storage;
const dbProxy = new Proxy({}, { get: () => () => ({}) });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  home = await import('../src/controllers/home-layout.controller.js');
  storage = await import('../src/services/storage.service.js');
});

const layout = (settings) => home.cleanLayout({ sections: [{ id: 's1', type: 'steps', settings }] }).sections[0].settings;

test('steps is a section type', () => {
  assert.ok(home.SECTION_TYPES.includes('steps'));
});

test('a card keeps its text, picture, emoji, colours and link; anything else is dropped', () => {
  const s = layout({
    title: 'How it works?', highlight: 'it', layout: 'grid', show_numbers: false,
    items: [{ title: 'Send us your fabric', text: 'Order from any brand', icon_url: 'https://x.test/a.png', emoji: '📦', bg: '#fdd6e8', bg2: '#f9a8d4', color: '#111827', link: '/app/orders/new', evil: '<script>' }],
  });
  assert.equal(s.title, 'How it works?');
  assert.equal(s.highlight, 'it');
  assert.equal(s.layout, 'grid');
  assert.equal(s.show_numbers, false);
  assert.deepEqual(s.items, [{ title: 'Send us your fabric', text: 'Order from any brand', icon_url: 'https://x.test/a.png', emoji: '📦', bg: '#FDD6E8', bg2: '#F9A8D4', color: '#111827', link: '/app/orders/new' }]);
});

test('wrong values fall back: a bad second colour copies the first, a javascript: link and a non-web picture are dropped', () => {
  const s = layout({ items: [{ title: 'A', bg: '#112233', bg2: 'red', link: 'javascript:alert(1)', icon_url: 'data:image/png;base64,AAAA' }] });
  assert.equal(s.items[0].bg2, '#112233');
  assert.equal(s.items[0].link, '');
  assert.equal(s.items[0].icon_url, '');
  assert.equal(s.layout, 'slider');
  assert.equal(s.show_numbers, true);
  assert.equal(s.number_color, '#FFFFFF');
  assert.equal(s.highlight_color, '#6D1D3A');
  assert.equal(layout({ number_color: '#102030' }).number_color, '#102030');
});

test('at most 12 cards; a list that is not a list becomes none', () => {
  assert.equal(layout({ items: Array.from({ length: 30 }, (_, i) => ({ title: `T${i}` })) }).items.length, 12);
  assert.deepEqual(layout({ items: 'nope' }).items, []);
});

const SAFE = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/></svg>';

test('a plain SVG drawing is accepted', () => {
  assert.doesNotThrow(() => storage.assertSafeSvg(SAFE));
  assert.doesNotThrow(() => storage.assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#fff}</style><image href="data:image/png;base64,AAAA"/></svg>'));
});

test('an SVG with a script, a handler, a link or another file is refused', () => {
  const bad = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.test"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.test/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"/></svg>',
    '<html><body>not an svg</body></html>',
    '',
  ];
  for (const b of bad) assert.throws(() => storage.assertSafeSvg(b), /not (a valid|allowed)|allowed/i, b.slice(0, 50));
});
