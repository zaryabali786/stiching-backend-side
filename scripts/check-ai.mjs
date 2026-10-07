/**
 * Checks that brand invoices / forwarded emails can be read:  npm run ai:check
 * Sends a small made-up order email to the AI and prints what it found.
 */
import 'dotenv/config';
import { extractOrderWithAi, isAiConfigured } from '../src/services/ai.service.js';

if (!isAiConfigured()) {
  console.error('Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set in backend/.env.');
  process.exit(1);
}

const text = `Subject: Fwd: Order #SP-482913 confirmed
From: Ayesha Khan <ayesha@example.com>

---------- Forwarded message ---------
From: Sapphire <orders@pk.sapphireonline.pk>
Subject: Order #SP-482913 confirmed

Thank you for your order, Ayesha!
Order number: SP-482913
Item | Qty | Price |
Embroidered Lawn Suit 3 Piece - U3PE-24 (https://pk.sapphireonline.pk/products/embroidered-lawn-3-piece) | 2 | Rs. 8,990 |
Printed Cambric Shirt 2 Piece - 2PDY-11 | 1 | Rs. 5,490 |
Shipping | | Rs. 250 |
Total | | Rs. 23,720 |`;

try {
  const started = Date.now();
  const result = await extractOrderWithAi([{ type: 'text', text }], 'Extract the original brand, its order number, currency, total and every product line.');
  console.log(`OK in ${Date.now() - started} ms`);
  console.log(JSON.stringify(result, null, 2));
  const good = result.brand === 'Sapphire' && result.items.length === 2 && result.total === 23720;
  console.log(good ? 'Reading works: brand, products and total were found.' : 'The AI answered, but the result looks off - check the output above.');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
}
