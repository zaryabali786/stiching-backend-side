# Card payments with Stripe

Customers pay an issued invoice by card, in the website and in the native app (same code). Test mode only until you swap in live keys.

## How it works

```
Customer taps Pay                                 Server (Express)                              Stripe
────────────────                                  ────────────────                              ──────
1. POST /client/orders/:id/payment-intent  ───▶   creates a PaymentIntent for the invoice  ───▶  PaymentIntent (amount + currency)
   (gets a one-time clientSecret back)  ◀───      (secret key stays here)
2. Card form (Stripe Payment Element)  ─────────────────────────────────────────────────────▶  card goes straight to Stripe
   3-D Secure, if the bank asks, opens in a Stripe dialog                                      (never to our server)
3. POST .../payment-intent/confirm      ───▶      asks Stripe "did it succeed?"            ───▶  status = succeeded
                                                  invoice -> paid, order -> paid, notifications
4.                                                POST /api/webhooks/stripe  ◀──────────────────  payment_intent.succeeded (signed)
                                                  same "mark paid" code; it runs only once
```

Two paths report every payment (the app right after paying, and Stripe's webhook). Both run the same code and only the first one changes anything, so a customer who closes the app mid-payment is still marked paid by the webhook.

* Customer is charged the invoice in **their currency** (`total_foreign`, e.g. GBP 70.99). PKR invoices are charged in PKR.
* The server compares the amount Stripe received with the invoice. A payment that does not match (invoice changed meanwhile) is **not** marked paid; admins get an alert to review it.
* The old fake "test payment" button is gone. `POST /client/orders/:id/pay` is refused as soon as Stripe keys exist (and always in production).

## Keys (`backend/.env`)

| Variable | What | Where it may be used |
|---|---|---|
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | Safe to expose. The server hands it to the apps through `GET /api/config`. |
| `STRIPE_SECRET_KEY` | `sk_test_...` | **Server only.** Never in the apps, never in git, never in chat. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Server only. Proves a webhook really came from Stripe. |

The two test keys you sent are already in `.env`. Because the secret key was pasted into a chat, **roll it** when convenient: Stripe Dashboard → Developers → API keys → the key → Roll key, then paste the new one into `.env`.

## Webhooks on your own computer (localhost)

Stripe's servers cannot reach `localhost`. The **Stripe CLI** solves that: it listens for your account's events and forwards them to your local server.

1. **Install the CLI** (once). Windows: `winget install Stripe.StripeCli`, then open a new terminal. (macOS: `brew install stripe/stripe-cli/stripe`.)
2. **Log in** (once): `stripe login`, press Enter, approve in the browser. (You can skip this and pass `--api-key sk_test_...` to the next command instead.)
3. **Forward events to the backend** and leave this terminal open:
   ```
   stripe listen --forward-to localhost:5000/api/webhooks/stripe
   ```
   It prints `Ready! Your webhook signing secret is whsec_xxxxxxxx`.
4. **Put that secret in `backend/.env`** as `STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxx` and **restart the backend**. (The secret changes if you log in again or use another machine.)
5. **Test it.**
   * Real flow: open an order with an issued invoice in the app, tap Pay, use card `4242 4242 4242 4242`. In the CLI window you will see `payment_intent.succeeded` forwarded with `[200]`.
   * Quick signal check: `stripe trigger payment_intent.succeeded` (Stripe's sample event is not one of our invoices, so the server accepts it and ignores it. `200` means signature + route are fine).
   * Resend any event from the Dashboard (Developers → Events) with `stripe events resend evt_...`.

You do not need the CLI for everyday local testing: the app's own confirm step marks the invoice paid by itself. Use the CLI to test the webhook path (closing the tab mid-payment, retries, declined cards).

**Alternative without the CLI:** expose your server with a tunnel (`ngrok http 5000` or `cloudflared tunnel --url http://localhost:5000`), then Dashboard → Developers → Webhooks → *Add endpoint* → `https://<tunnel-host>/api/webhooks/stripe`, events `payment_intent.succeeded` and `payment_intent.payment_failed`, and copy that endpoint's *Signing secret* into `STRIPE_WEBHOOK_SECRET`.

## Webhooks in production

1. Deploy the backend over HTTPS.
2. Dashboard → Developers → Webhooks → *Add endpoint*: URL `https://api.your-domain.com/api/webhooks/stripe`, events `payment_intent.succeeded` and `payment_intent.payment_failed`.
3. Copy the endpoint's signing secret to the server's `STRIPE_WEBHOOK_SECRET`.
4. Stripe retries a failed delivery for up to 3 days. The endpoint answers `200` only after the order is updated, `400` for a bad signature, `503` if the secret is missing.

## Test cards (test mode only, any future expiry, any CVC)

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0025 0000 3155` | Asks for 3-D Secure, then succeeds |
| `4000 0000 0000 9995` | Declined (insufficient funds) |
| `4000 0000 0000 0002` | Declined (generic) |

## Website and native app

The customer app is Ionic + Capacitor: the native app is the same web code in a web view, and Stripe's card form runs inside it. Nothing to do per platform for card payments.

For a **native build**:
* `npm run build` then `npx cap add android` / `npx cap add ios` (once), `npx cap sync`, open Android Studio / Xcode.
* The app must reach your API from the phone. `localhost` means the phone itself, so set `apiUrl` (in `src/environments/environment.ts` for dev, `environment.prod.ts` for release) to your computer's LAN address while testing, or to your HTTPS API URL for release. Plain `http://` needs Android cleartext traffic allowed; HTTPS avoids that.
* Change the placeholder `appId` (`io.ionic.starter`) in `capacitor.config.ts` before publishing.
* **Apple Pay / Google Pay as native sheets** need Stripe's native SDK (a Capacitor plugin) and merchant setup. The card form works everywhere today; wallets can be added later without changing the server.

## Going live checklist

* Activate your Stripe account, then use the **live** keys (`pk_live_` / `sk_live_`) and a **live** webhook endpoint with its own signing secret.
* Make sure the account can charge the currencies you invoice in (PKR works in test mode for this account).
* Keep `NODE_ENV=production` on the server (turns off the development-only payment shortcut).
* Remove the seeded test accounts (`*@v360.test`).

## Tests

`npm run test:stripe` (backend running; set `STRIPE_WEBHOOK_SECRET` to the secret the server uses) runs throwaway orders through: starting a payment, resuming it, a changed invoice, paying, confirming twice, forged and valid webhooks, duplicates, a declined card then a good one, and an under-paid amount. It uses only Stripe test payment methods.
