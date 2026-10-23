import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail } from '../src/services/transactional-email.service.js';

test('the order email names the brand, lists the products with their prices and the total, and has the button', () => {
  const { text, html } = renderEmail({
    heading: 'Your order #1001 is confirmed',
    brand: 'Izel Apparel',
    paragraphs: ['Here is what you ordered:'],
    items: [
      { title: 'Linen kurta', quantity: 2, price: 45, image_url: 'https://cdn.example.test/kurta.jpg' },
      { title: 'Silk dupatta', quantity: 1, price: 30.5, image_url: null },
    ],
    currency: 'USD',
    total: 120.5,
    button: { label: 'Add my sizes', url: 'https://client.example.test/sign-in?x=1&y=2' },
    footer: 'Sign in with this email address: ali@example.com',
  });
  assert.match(text, /Order from Izel Apparel/);
  assert.match(text, /- Linen kurta x 2 \$90\.00/);
  assert.match(text, /- Silk dupatta x 1 \$30\.50/);
  assert.match(text, /Total: \$120\.50/);
  assert.match(text, /Add my sizes: https:\/\/client\.example\.test/);
  assert.match(html, />Izel Apparel</);
  assert.match(html, /Linen kurta/);
  assert.match(html, /\$90\.00/);
  assert.match(html, /\$120\.50/);
  assert.match(html, /<img src="https:\/\/cdn\.example\.test\/kurta\.jpg"/);
  assert.match(html, /href="https:\/\/client\.example\.test\/sign-in\?x=1&amp;y=2"/);
});

test('an email without products or brand is the simple one it always was', () => {
  const { text, html } = renderEmail({ heading: 'Your Stitch&Ship sign-in code', paragraphs: ['Your code is 123456.'] });
  assert.equal(text, 'Your Stitch&Ship sign-in code\n\nYour code is 123456.');
  assert.ok(!html.includes('<table'));
  assert.ok(!html.includes('Order from'));
});

test('text in the HTML cannot break out of the email (escaped), and a missing price never prints NaN', () => {
  const { html, text } = renderEmail({ heading: 'h', brand: '<b>x</b>', items: [{ title: '<script>1</script>', quantity: 1, price: 'abc' }], currency: 'USD' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(!/NaN/.test(html) && !/NaN/.test(text));
});
