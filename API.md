# Stitching Platform API (v2)

Base URL: `http://localhost:5000/api`

All responses use one envelope:

```json
{ "success": true, "statusCode": 200, "message": "…", "data": <payload>, "meta": { … } }
```

Errors: `{ "success": false, "statusCode": 4xx/5xx, "message": "Human readable", "details"?: [...] }` — show `message` to the user.

**Paginated lists** return `data: Row[]` and
`meta: { page, limit, total, totalPages, hasMore, ...extra }`.
Common query params: `page` (1-based), `limit`, `search`, `sort`, `dir=asc|desc`.

**Auth:** send `Authorization: Bearer <accessToken>`. On `401`, call `POST /auth/refresh` with the
refresh token once, retry, and log out if that fails.

Roles (from `profiles.role`): `customer`, `partner_staff`, `admin`.
`/client/*` → customer only · `/partner/*` → partner_staff or admin · `/admin/*` → admin only.

All field names are **snake_case** (database columns), except computed summary objects (overview endpoints) which are camelCase as documented.

---

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | `{ name, shipToName, shipToAddress, shipToCity, shipToPhone, partnerName }` — our receiving address shown to customers |
| GET | `/health` | |
| POST | `/inbound/email` | Postmark **inbound webhook** for forwarded brand emails (body up to 45 MB). Auth: HTTP basic auth password = `INBOUND_EMAIL_SECRET` (`https://inbound:<secret>@<api-host>/api/inbound/email`), or `X-Inbound-Secret` header / `?secret=`. The recipient `<INBOUND_EMAIL_ADDRESS local part>+<customer token>@<domain>` (Postmark `MailboxHash`) identifies the customer. Also accepts a generic JSON body `{ from, to, subject, text, html, attachments:[{ filename, contentType, content(base64) }] }`. Always 200 `{ accepted, id?, duplicate? }` for authenticated calls (unknown/missing token → `accepted:false`); 401 bad secret; 503 not configured. |

## Auth `/auth`

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/register` | `{ email, password(min 8), fullName, phone, country, city, address }` — **customers only**. `portal: 'staff'` is refused (403): staff accounts are created by an admin (partners) or by a partner (its users). | `{ user: Profile, tokens }` |
| POST | `/login` | `{ email, password }` | `{ user: Profile, tokens }` |
| POST | `/google` | `{ code, redirectUri, portal?: "customer" or "staff" }` | `{ user: Profile, tokens, created }`. Google sign-in (authorization-code flow). The server swaps the code using `GOOGLE_CLIENT_SECRET`, takes the verified email, signs in (or creates the account: customer, or a pending staff request on the staff portal). `redirectUri` must be `<CLIENT_APP_URL>/login` or `<ADMIN_APP_URL>/login` and registered in Google Cloud. `GET /config` exposes `google: { enabled, clientId }`. |
| POST | `/refresh` | `{ refreshToken }` | `{ user, tokens }` |
| POST | `/forgot-password` | `{ email, portal }` | message only |
| GET | `/me` | – | `{ user: Profile }` |
| PATCH | `/me` | `{ fullName?, phone?, country?, city?, address?, postalCode? }` | `{ user }` |
| POST | `/change-password` | `{ currentPassword, newPassword }` | |
| POST | `/logout` | – | |

`tokens = { tokenType, accessToken, refreshToken, expiresIn, expiresAt(unix seconds) }`

`Profile = { id, email, full_name, phone, country, city, address, postal_code, role, customer_code ('STX-10001'), is_active, created_at, partner_id, partner: {id,name,status}|null, partner_role: 'owner'|'member'|null, permissions: string[], job_title, must_change_password }`

`permissions` in a login / `/me` / refresh response is the **effective** list the server computed for this person (never the stored one): the
apps only display it, the server re-checks every request. Admins hold every permission. Customers: `[]`.

## Roles, partners and permissions (migration 0005)

```
Admin
 ├── Partner A  (own login = the owner)  modules enabled by the admin  (partners.permissions)
 │    ├── Master Tailor A1   own login, permissions granted by Partner A (subset of A's modules)
 │    └── Tailor A2 ...
 └── Partner B ...
```

* `profiles.role` stays `customer | partner_staff | admin`. Every partner login (owner and users) is `partner_staff` with a `partner_id`;
  `partner_role` is `owner` (created together with the partner, always has every module of the partner) or `member`.
* Effective permissions of a member = their granted permissions ∩ the partner's modules. Taking a module away from a partner removes it from its users too.
* Permission ids are `<module>.<action>`. Catalogue (`GET /admin/permissions`, `GET /partner/access` → `modules`):

| module | actions | partner pages / API it opens |
|---|---|---|
| overview | view | `/partner/overview` |
| receiving | view, update | receiving, unmatched parcels |
| production | view, update | production board, job cards, assign |
| quality | view, update | QC queue, approvals, pack |
| warehouse | view, update | dispatch route, direct shipping, transfers |
| teams | view, update | masters / tailors roster |
| earnings | view | partner earnings |
| messages | view, update | customer chat (inbox + conversations) |
| catalogue | view, update | brands, couriers, article types, articles |
| users | view, create, update | the partner's own users |

  `update` always includes `view` (the server adds it). Admin-only areas (invoices, customers, price list, shipping rates, reports, settings, partners) are not delegable.
* Every `/partner/*` route needs the permission of its module and, when it takes an id, that the record belongs to the caller's partner
  (**403** for another partner's record, **404** if it does not exist). List endpoints only return the caller's partner's rows. An admin sees all partners.
  Nothing about identity, partner or permissions is ever read from the request body.
* A login created by an admin / partner has `must_change_password: true`: until the person calls `POST /auth/change-password`,
  `/partner/*` and `/admin/*` answer **403 `{ code: 'PASSWORD_CHANGE_REQUIRED' }`**. The apps must show a "choose your own password" screen right after login.
* `403` = signed in but not allowed (missing permission / another partner's record), `401` = not signed in or session expired.

| Method | Path | Notes |
|---|---|---|
| GET | `/partner/access` | `{ role, partner_id, partner, partner_role, permissions[], modules[], delegable[] }` — `delegable` = permissions the caller can hand to a new user |
| GET | `/partner/users?search&page&limit` | `users.view`. Rows `{ id, email, full_name, phone, job_title, partner_id, partner_role, permissions (stored), is_active, must_change_password, created_at, is_owner, is_me }` (owner first) |
| POST | `/partner/users` | `users.create`. `{ email, full_name, phone?, job_title?, permissions: string[], password? }` → `201 { user, temporaryPassword }`. Without `password` a temporary one is generated; it is **shown only once**. Permissions must be a subset of the creator's own. |
| PATCH | `/partner/users/:id` | `users.update`. `{ full_name?, phone?, job_title?, permissions?, is_active? }`. Cannot edit yourself, the owner (unless you are admin) or someone with more access than you. |
| POST | `/partner/users/:id/reset-password` | `users.update`. → `{ user, temporaryPassword }` (once) |
| DELETE | `/partner/users/:id` | `users.update`. Switches the login off (`is_active=false`), history stays |
| GET | `/admin/permissions` | `{ modules }` catalogue for the permission pickers |
| GET | `/admin/partners?search&status&page&limit` | `{ id, name, status, permissions[], is_default, owner:{full_name,email,is_active}|null, users_count, active_orders, in_production, created_at }`; `meta.modules` = catalogue |
| POST | `/admin/partners` | `{ name, permissions[], is_default?, owner: { email, full_name, phone?, job_title?, password? } }` → `201 { partner, owner, temporaryPassword }` (shown once). The first partner becomes the default. |
| GET | `/admin/partners/:id` | `{ partner, owner, stats:{activeMasters,activeTailors,dailyCapacity,currentLoadPct,inProduction,activeOrders,payoutThisMonthPkr,payoutPaidThisMonthPkr}, masters[], unassignedTailors[], modules }` |
| PATCH | `/admin/partners/:id` | `{ name?, status?: 'active'|'inactive', permissions?[], is_default?: true }` — shrinking `permissions` also removes those modules from the partner's users |
| GET / POST | `/admin/partners/:id/users` | same shapes as `/partner/users` for that partner |
| PATCH / DELETE | `/admin/partners/:id/users/:userId` | same as `/partner/users/:id` |
| POST | `/admin/partners/:id/users/:userId/reset-password` | `{ user, temporaryPassword }` |
| POST | `/admin/orders/:id/partner` | `{ partner_id }` move an order that has not started production to another partner (new orders go to the default partner) |
| GET | `/admin/orders?partner_id=` | admin order list can be filtered by partner; rows and detail include `partner:{id,name}` |
| PATCH | `/admin/users/:id/role` | now only `customer` or `admin` (partner users are managed under their partner) |

Removed: public staff sign-up and the staff access-request approval (`POST /admin/users/:id/request`, `requested_role`). `GET /admin/partners` no longer returns the old single-partner team overview (use `GET /admin/partners/:id`).
First admin of a fresh install: `npm run admin:create -- you@company.com "Name" "password"`.

## Order status is forward-only (migration 0005)

Order lifecycle: `submitted → received → assigned → cutting → stitching → qc_passed → customer_approval → packed → invoice_issued → awaiting_payment → paid → at_admin_warehouse | partner_dispatch → shipped → delivered` (`cancelled` from anything before `shipped`).
Before `paid` the production board may move an order back (QC fail, approval changes) and an invoice can be reopened to `packed`. From `paid` onwards the status can only
move forward: the API answers **409** and a database trigger refuses the write, so a shipped / delivered order can never show as Packed again.
Status writes are compare-and-swap, so two requests racing each other cannot overwrite one another.

Articles: admin order detail `cards[]` and partner job cards now carry `display_status` / `display_label` — the production stage while the order is being made,
and the order's own progress (`Shipped`, `Delivered`, ...) once the article has left production (the raw `stage` stays `packed`).
Each article's customer timeline gets `shipped` and `delivered` steps when the order does.

## Order form catalogues, article types and conversations (migration 0004)

All list endpoints take `?page=1&limit=20&search=...` and answer
`{ success, data: [...], meta: { page, limit, total, totalPages, hasMore }, pagination: { …same… } }`.
Search and paging happen on the server; never load a whole catalogue in the browser.

### Customer lookups `/client` (active rows only, **never any price**)

| Method | Path | Returns |
|---|---|---|
| GET | `/brands?search&page&limit` | `[{ id, name }]` |
| POST | `/brands` `{ name }` | "Other / add new brand": `201 { id, name }` created, or `200 { id, name }` when the name already exists (any case). 409 if that brand exists but is switched off. |
| GET | `/couriers?search&page&limit` | `[{ id, name, requires_tracking }]` |
| GET | `/article-types?search&page&limit` | `[{ id, name, sort_order }]`: active types that have at least one active article, in the partner's order. The order form renders one dropdown per type, so a new type needs no frontend change. |
| GET | `/articles?type_id=<required>&search&page&limit` | `[{ id, article_type_id, name, image_url }]` |
| POST | `/products/preview` `{ url }` | `{ url, ok, title, image_url, brand, error }`: reads a product page (no price). 10 per minute. |

### Create / edit an order `POST /client/orders`, `PATCH /client/orders/:id`
```json
{
  "brand_id": "uuid",                 // required, active brand
  "courier_id": "uuid",               // required, active courier
  "tracking_number": "TCS123",        // required when the courier has requires_tracking (default true)
  "international_shipping": true,     // required boolean. true => shipping_service 'express', false => 'standard' (the server decides; any client value is ignored)
  "brand_order_number": "SP-1",       // optional
  "note": "text",                     // optional; stored as customer_notes AND as the first chat message
  "units": [{
    "id": "uuid",                     // only when editing an existing piece
    "unit_title": "Embroidered lawn 3-pc",   // product name (required)
    "product_link": "https://...",    // optional (product by link); leave empty for a manual product
    "product_image_url": "https://...",      // optional, from /products/preview
    "stitching_type": "Plain 3-pc", "size_chart_id": "uuid|null", "notes": "...", "quantity": 1,
    "article_ids": ["<neckline article id>", "<sleeves article id>"],   // at most ONE article per article type per piece
    "reference_uploads": [{ "name": "a.jpg", "dataUrl": "data:image/jpeg;base64,..." }],
    "reference_images": []            // edit: existing photos to keep
  }]
}
```
There is no rush option any more: `priority` is always `normal` (due date +12 days). Prices are not accepted from customers.
Errors are `400` with a readable `message` (missing/inactive brand or courier, missing tracking, international shipping not chosen,
two articles of one type on a piece, an article that was switched off, ...).

`OrderDetail` now also has: `brand_id`, `brand_ref: { id, name }`, `courier_id`, `courier: { id, name, requires_tracking }`, `tracking_number`,
`international_shipping`, `shipping_service`, and per piece `units[].selected_articles: [{ article_type_id, type_name, article_id, name, image_url }]`
(sorted by the type's sort order). Pieces also keep the legacy `design` map (`{ neckline: 'Round Neck', ... }`, keys are the lower-snake type names) for the partner screens.
Admin order detail (`GET /admin/orders/:id`) additionally has `courier` and `units[].selected_articles[].customer_price` / `partner_cost`.

### Partner / admin management `/partner` (partner_staff, admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/brands?search&status=active\|inactive\|all&sort=name\|created_at\|status&dir&page&limit` | `[{ id, name, status, created_at, updated_at }]` |
| POST | `/brands` `{ name, status? }` | 409 when the name exists (any case) |
| PATCH | `/brands/:id` `{ name?, status? }` | renaming also renames the brand on existing orders |
| DELETE | `/brands/:id` | `data: { id, deleted, deactivated }` (flags are inside `data`): a brand used by orders is switched off instead (the message says so) |
| GET/POST/PATCH/DELETE | `/couriers...` | same as brands, plus `requires_tracking` (boolean, default true) |
| GET | `/article-types?search&status&page&limit` | `[{ id, name, status, sort_order, articles_count }]` |
| POST | `/article-types` `{ name, status?, sort_order? }` | new types go to the end by default |
| PATCH | `/article-types/:id` `{ name?, status?, sort_order? }` | |
| DELETE | `/article-types/:id` | 409 while it still has articles (delete them or set it inactive) |
| GET | `/articles?type_id&search&status&sort=sort_order\|name\|customer_price\|partner_cost\|created_at&page&limit` | `[{ id, article_type_id, name, image_url, customer_price, partner_cost, margin (customer_price − partner_cost, null until both set), status, sort_order, type:{id,name}, created_at, updated_at }]` |
| POST | `/articles` | `{ article_type_id, name, customer_price? (>=0 or null), partner_cost? (>=0 or null), status?, sort_order?, image_upload?: { name, dataUrl } }` (JPG/PNG/WebP, max 8 MB) |
| PATCH | `/articles/:id` | `{ name?, customer_price?, partner_cost?, status?, sort_order?, image_upload?, remove_image?: true }` |
| DELETE | `/articles/:id` | `{ deleted, deactivated }`: used articles are deactivated, unused ones are deleted (and the picture removed) |

### Conversations (text + voice)

Same handlers for customers (`/client/orders/:id/...`) and staff (`/partner/orders/:id/...`, any order). A customer can only reach their own orders (404 otherwise).

| Method | Path | Notes |
|---|---|---|
| GET | `/orders/:id/messages?limit=30&before=<nextCursor>` | oldest to newest within the page; `meta: { hasMore, nextCursor }`. Pass `nextCursor` as `before` to load older messages. |
| POST | `/orders/:id/messages` | `{ kind: 'text', body, client_msg_id? }` or `{ kind: 'voice', audio: { path, duration, mime, size }, client_msg_id? }`. The same `client_msg_id` twice returns the original (safe retries). Text up to 4000 chars, voice up to 5 min, 30 messages/min per user. |
| POST | `/orders/:id/messages/voice-upload` | `{ audio: { dataUrl: 'data:audio/webm;codecs=opus;base64,...', duration: 7.4 } }` returns `201 { path, mime, size, duration, url }`. Audio is stored privately; send the returned `{ path, duration, mime, size }` as a voice message. |
| POST | `/orders/:id/messages/read` | marks the other side's messages read, returns `{ updated }` |
| GET | `/partner/conversations?search&filter=all\|unread&page&limit` | staff inbox: `[{ order_id, reference, brand, status, status_label, customer_name, customer_code, last_message_at, last_message_preview, last_message_role, unread }]`, `meta.unreadConversations` |
| GET | `/partner/conversations/unread-count` | `{ unreadConversations }` |
| GET | `/partner/orders/:id/summary` | conversation header that also works before the first message: `{ id, reference, customer_name, customer_code, brand, status, status_label }` |

`Message = { id, order_id, sender_id, sender_role: 'customer'|'partner_staff'|'admin', sender_name, kind: 'text'|'voice', body|null, audio: { mime, duration, size, url }|null, client_msg_id, read_at|null, created_at }`
(`audio.url` is a signed link valid for one hour: reload the message list to refresh it.)
`/partner/badges` and `/admin/badges` now include `messages` (conversations with unread customer messages).
Notification links: customer `/app/orders/<id>?chat=1`, partner `/partner/messages/<orderId>`, admin `/admin/messages/<orderId>`.

### Real time (Socket.IO, same host and port as the API, default path `/socket.io`)
Connect with the login access token: `io(API_ORIGIN, { auth: (cb) => cb({ token: accessToken }) })`
(the function form re-reads the token on every reconnect). Unauthorised connections are rejected with `connect_error: unauthorized`.

| Direction | Event | Payload | Notes |
|---|---|---|---|
| to server | `conversation:join` | `{ orderId }` + ack `{ ok, error? }` | needed to receive `message:new` / `message:read` / `typing` for that order |
| to server | `conversation:leave` | `{ orderId }` | |
| to server | `message:send` | `{ orderId, kind:'text', body, client_msg_id }` or `{ orderId, kind:'voice', audio:{path,duration,mime,size}, client_msg_id }` + ack `{ ok, message, duplicate }` or `{ ok:false, error, status }` | saved first, then broadcast. Voice audio is uploaded with the HTTP endpoint beforehand, never over the socket. |
| to server | `message:read` | `{ orderId }` + ack `{ ok, updated }` | |
| to server | `typing` | `{ orderId, typing: boolean }` | relayed to others in the room |
| to client | `message:new` | `Message` | sent to everyone in `order:<id>` including the sender, so de-duplicate by `id` / `client_msg_id` |
| to client | `message:read` | `{ orderId, readerRole, readAt, count }` | the other side opened the conversation |
| to client | `typing` | `{ orderId, userId, name, role, typing }` | |
| to client | `inbox:update` | `{ orderId }` | sent to the customer's other screens and to all staff; refresh unread counts / the inbox list |
| to client | `notification:new` | `{}` | refresh the bell |

If the socket is down, the REST endpoints above do the same job; the UI should fall back to them and re-sync on reconnect.

---

## Size charts (measurements) `/client/sizes`

A customer has many charts. A **person** (Me, Mother, Daughter, ...) is the `person_name`; each person can have several **variations** (Standard, Long kurta, Frock, ...). The person tabs and variation chips in the app are just these two fields: adding a new person or variation = creating a chart.

| Method | Path | Notes |
|---|---|---|
| GET | `/sizes?page&limit&search` | the customer's charts (search matches name / person / variation) |
| POST | `/sizes` | `{ person_name, variation?, nearest_size?, measurements, notes? }` (409 when that person already has that variation, any case) |
| PATCH | `/sizes/:id` | same fields, all optional. Orders whose parcel has not arrived yet (`submitted`) follow the corrected sizes; orders already in work keep their copy. |
| DELETE | `/sizes/:id` | orders keep their own copy |

`SizeChart = { id, person_name, variation, name ('Me · Standard'), nearest_size: 'XS'|'S'|'M'|'L'|'XL'|null, measurements, notes, fit_feedback, created_at, updated_at }`

`measurements` (inches, numbers 0-120, blank = leave out):

| Group | key | Label on screen |
|---|---|---|
| Shirt / kameez | `shirt_length` | Front length |
| | `shoulder` | Shoulder |
| | `bust` | Bust |
| | `waist` | Waist |
| | `hip` | Hip |
| | `bottom` | Bottom (hem) |
| | `sleeve` | Sleeve length |
| | `cuff_opening` | Cuff opening (single) |
| | `armhole` | Arm hole |
| Trouser | `trouser_length` | Length |
| | `front_rise` | Front rise |
| | `back_rise` | Back rise |
| | `waist_relaxed` | Waist (relaxed) |
| | `trouser_hip` | Hip |
| | `knee` | Knee |
| | `thigh` | Thigh |
| | `bottom_opening` | Bottom (single) |
| Older charts only | `shalwar_gheer`, `neck_depth` | show generically if present |

**The order keeps its own copy of the sizes.** When an order is created or edited, each piece stores a frozen copy of its chart.
Everywhere a piece is returned (customer order detail, admin order detail, partner job cards and QC) `unit.size_chart` is that copy
(`{ id, name, person_name, variation, nearest_size, measurements, notes, fit_feedback }`), falling back to the live chart for older orders.

### Live order updates
Socket event `order:update` `{ orderId, status, status_label }` is sent to the customer's `user:<id>` room whenever an order's status changes
(for example when the partner sends photos for approval). Approval notifications link to `/app/orders/<id>?focus=approval`.

---

## Card payments (Stripe) - see STRIPE_SETUP.md

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | now includes `payments: { stripe: { enabled, publishableKey } }` (publishable key only) |
| POST | `/client/orders/:id/payment-intent` | starts or resumes the card payment for the order's issued invoice: `{ clientSecret, paymentIntentId, amount, currency, invoiceNumber, reference, publishableKey }`. Charged in the invoice currency (`total_foreign`), or PKR for PKR invoices. 400 if there is no unpaid invoice. |
| POST | `/client/orders/:id/payment-intent/confirm` `{ payment_intent_id }` | after Stripe confirms the card: the server asks Stripe and marks the invoice and order paid. `{ paid, status, error? }`. Safe to call twice. |
| POST | `/webhooks/stripe` | called by Stripe (raw body, `Stripe-Signature` header, secret `STRIPE_WEBHOOK_SECRET`). Handles `payment_intent.succeeded` and `payment_intent.payment_failed`. |
| POST | `/client/orders/:id/pay` | old simulated payment: refused once Stripe keys are configured and always in production |

---

## Voice notes next to text notes

Every free-text note can also be a voice note. Flow: record in the app, upload the clip, send the returned reference with the note.

| Method | Path | Notes |
|---|---|---|
| POST | `/client/voice-upload` and `/partner/voice-upload` | `{ audio: { dataUrl: 'data:audio/webm;codecs=opus;base64,...', duration: 7.4 } }` returns `201 { path, mime, size, duration, url }`. Stored privately under the caller's own folder; max 5 minutes, 8 MB. |

Send the reference as `{ path, duration, mime, size }` in the field below. `null` removes a saved voice note; leaving the field out (or sending back the signed object without `path`) keeps it. A text note and a voice note can be sent together, and a voice note alone is enough.

| Where | Send | Receive (everywhere the note is shown) |
|---|---|---|
| Article note (customer) | `units[i].notes_audio` in `POST/PATCH /client/orders` | `unit.notes_audio` |
| Size chart note (customer) | `notes_audio` in `POST/PATCH /client/sizes` | `size_chart.notes_audio` on charts, and on `unit.size_chart` in orders |
| Change request (customer) | `POST /client/orders/:id/request-changes { note?, audio? }` (note OR audio) | `order.change_request_audio` |
| Job card comment (partner) | `POST /partner/production/cards/:id/comments { body?, notes_audio? }` | `activity[].notes_audio` in card detail |
| QC "needs fixing" (partner) | `POST /partner/qc/cards/:id/fail { notes?, notes_audio? }` | `card.qc_notes_audio` |
| Receiving issue (partner) | `POST /partner/receiving/units/:unitId/issue { issue_type, note?, notes_audio?, media? }` | `unit.issue_audio` |

A received voice note is `{ mime, duration, size, url }` where `url` is a signed link valid for one hour (reload the data to refresh it).
Order note and chat voice messages already work (see Conversations).

---

## Approval per article (each production ticket is approved on its own)

Two different products in one order get their own photos, their own Approve / Request changes and their own status. The order shows `customer_approval` ("Awaiting your approval") while at least one article is waiting; packing is blocked only while an article is `pending`.

Per article (job card) approval state: `approval_status` = `none` (nothing sent) / `pending` (photos sent, waiting for the customer) / `approved` / `changes_requested`, plus `approval_photos [{url,type,name}]`, `approval_requested_at`, `approval_decided_at`, `change_request` (text), `change_request_audio` (voice note).

| Who | Method / path | Notes |
|---|---|---|
| Partner | `POST /partner/qc/cards/:id/request-approval` `{ photos:[{name,dataUrl}] }` | one article: needs QC passed and at least one photo. Sending again after "changes requested" replaces the photos and clears the old request. 400 if already approved. |
| Partner | `POST /partner/qc/orders/:orderId/request-approval` `{ photos }` | older shortcut: same photos for the articles that have passed QC (others do not block it). Prefer the per-article call. |
| Partner | `POST /partner/qc/orders/:orderId/pack` | refused while any article is `pending` (message names the articles) |
| Customer | `POST /client/orders/:id/approve` `{ unit_id? }` | approve one article (`unit_id`), or every waiting article when omitted. Returns `{ approved, stillWaiting }`. 400 if nothing is waiting. |
| Customer | `POST /client/orders/:id/request-changes` `{ unit_id?, note?, audio? }` | changes for one article (or all waiting ones); note OR voice note required. ONLY those tickets go back to stitching. |

Reading: customer order detail has `units[].approval = { status, photos, requested_at, decided_at, change_request, change_request_audio }`. Partner card responses (board, QC queue, card detail) include the new `approval_*` and `change_request*` fields on the card itself.
Notification link for a waiting article: `/app/orders/<id>?focus=approval&unit=<unitId>`. Moving a ticket back into production (drag, QC send-back) resets its approval to `none`.

---

## Chat and timeline per article

Every article (piece) of an order has its own **chat** and its own **timeline**. The order also keeps a "General" chat and its order-level timeline.

### Chat scopes
`order_messages.unit_id` is the article the message is about, or `null` for General.

| Method | Path | Notes |
|---|---|---|
| GET | `/client/orders/:id/conversation` and `/partner/orders/:id/conversation` | the chats of one order: `{ scopes: [{ unit_id: null\|uuid, title, line_no, image_url, unread, last_message_at, last_message_preview, last_message_role }], unread }`. The first scope is General (`unit_id: null`), then one per article in `line_no` order. `unread` counts messages from the other side not opened yet. |
| GET | `/client/conversations` | all of my orders that have chats, newest first (max 50): `[{ id, reference, brand, status, last_message_at, scopes: [same as above], unread }]`. One call for the app-wide chat list. |
| GET | `.../orders/:id/messages?unit_id=<uuid>\|general\|all` | `uuid` = that article's chat, `general` = the order's own chat, omitted/`all` = everything |
| POST | `.../orders/:id/messages` | body gains `unit_id?` (uuid of an article of this order; omit for General) |
| POST | `.../orders/:id/messages/read` | body gains `unit_id?` (`general` / uuid / omit = everything) |

Socket: `message:send` takes `unit_id`; `message:new` carries `unit_id` on the Message; `message:read` carries `{ unitId, general }`. A client should show a message only in the open scope and just bump the unread badge of the others (refresh `conversation`).
Notification titles are per article ("New message on SA-1001 · Embroidered lawn"); links: customer `/app/orders/<id>?chat=1&unit=<unitId>`, staff `/partner/messages/<orderId>?unit=<unitId>`.

### Article timeline
Customer order detail: `units[].timeline = [{ status, label, note|null, at }]`, oldest first. `status` is one of: `received`, `issue`, `issue_resolved`, `to_assign`, `cutting`, `stitching`, `qc`, `qc_passed`, `qc_failed`, `approval_requested`, `approved`, `changes_requested`, `packed`. `label` is customer-friendly text. Internal QC notes are never included. Older orders without recorded steps get a best-effort timeline from stored dates.

---

## Shipping uses the courier list, and one chat at a time

- **Couriers when shipping:** `POST /partner/warehouse/orders/:id/ship` takes `{ courier_id, tracking_number }` and `POST /admin/warehouse/parcels/:id/label` takes `{ shipping_rate_id? | courier_id, tracking_number, ... }`. The courier must be an ACTIVE courier from `/partner/couriers` (Catalogue > Couriers); a free-text name that is not in the list is refused (400). A name that matches a courier is still accepted for older callers. When a shipping rate is chosen, the rate's own courier name is used.
- **Inbox chat shortcuts:** each row of `GET /partner/conversations` has `chats: [{ unit_id|null, title, line_no, unread, last_message_at, last_message_preview }]`: only the chats that have messages ("General" = `unit_id: null`, then one per article). Open exactly one chat: `/partner/messages/<orderId>` (General) or `/partner/messages/<orderId>?unit=<unitId>` (that article only). The apps no longer mix chats in one thread.

---

## Notifications `/notifications` (any signed-in user)

| Method | Path | Notes |
|---|---|---|
| GET | `/?page&limit&unread=true` | rows: `{ id, type, title, body, link, order_id, read_at, created_at }`; `meta.unreadCount` |
| GET | `/unread-count` | `{ unreadCount }` |
| POST | `/:id/read` | `{ unreadCount }` |
| POST | `/read-all` | |
| DELETE | `/:id` | |

`type`: `order | update | alert | approval | invoice | logistics`. `link` is an in-app route for the recipient's portal (may include `?query`).

---

## Customer `/client`

| Method | Path | Notes |
|---|---|---|
| GET | `/overview?period=year|all` | `{ period, ordersCount, articlesStitched, articlesInProgress, avgTurnaroundDays|null, monthly:[{month,key,count,pct}], whoYouStitchFor:[{name,count,pct}], actionNeeded:[{id,reference,brand,status,status_label}], unreadNotifications }` |
| GET | `/orders?page&limit&search&status=active|completed|<status>` | rows: `{ id, reference, brand, brand_order_number, tracking_number, status, status_label, has_issue, created_at, destination_city, destination_country, units_count }` |
| POST | `/orders` | see below → OrderDetail |
| GET | `/orders/:id` | OrderDetail |
| PATCH | `/orders/:id` | same body as create; only while `status = submitted` |
| POST | `/orders/:id/cancel` | only while `submitted` |
| POST | `/orders/:id/approve` | when `customer_approval` |
| POST | `/orders/:id/request-changes` | `{ note }` when `customer_approval` |
| POST | `/orders/:id/pay` | pays the issued invoice (TEST card payment until a gateway is chosen) |
| GET | `/imports?source=invoice|link|email&page&limit&include=used` | the customer's import drafts (OrderImport), newest first; `meta.ai` = automatic reading on |
| GET | `/imports/forward-address` | `{ address: 'orders+<token>@<domain>' | null, enabled, ai }` (token created on first call) |
| POST | `/imports/forward-address/reset` | new secret address; the old one stops working |
| POST | `/imports/invoice` | `{ file: { name, dataUrl } }` PDF/JPG/PNG/WebP ≤ 8 MB → OrderImport (read synchronously, up to ~30 s) |
| POST | `/imports/links` | `{ urls: string[] }` (1–10 product pages) → OrderImport |
| GET | `/imports/:id` | OrderImport |
| DELETE | `/imports/:id` | not allowed once used |
| GET | `/sizes?page&limit&search` | SizeChart rows |
| POST | `/sizes` | `{ person_name, variation, measurements, notes }` |
| PATCH | `/sizes/:id` | same fields |
| DELETE | `/sizes/:id` | |

Create order body:
```json
{
  "brand": "Sapphire", "brand_order_number": "SP-12345", "tracking_number": "TCS 123",
  "shipping_service": "express|standard", "priority": "normal|rush", "customer_notes": "…",
  "destination_country": "UK", "destination_city": "London", "destination_address": "…",   // optional, default = profile
  "units": [{
    "unit_title": "Embroidered lawn 3-pc", "stitching_type": "Plain 3-pc", "size_chart_id": "uuid|null",
    "product_link": "https://…", "notes": "…", "quantity": 1,
    "design": { "neckline": "Round", "sleeves": "3/4", "trouser": "Straight" },
    "reference_uploads": [{ "name": "lace.jpg", "dataUrl": "data:image/jpeg;base64,…" }],
    "unit_price": 8990, "currency": "PKR", "product_image_url": "https://…", "brand_sku": "U3PE-24"   // optional
  }],
  "import_id": "uuid",                                          // optional: draft the form was filled from
  "brand_order_total": 23720, "brand_order_currency": "PKR"     // optional
}
```

### New-order imports
A new order can be typed in (`manual`), or read from an uploaded brand invoice (`invoice`), product page links (`link`)
or a forwarded brand order email (`email`). Each produces an **OrderImport** draft that prefills the order form; the
customer reviews it and submits `POST /orders` with `import_id`. The order then keeps `import_source` and the invoice
(`brand_invoice`, a private file served through a short-lived signed `url`).

`OrderImport = { id, source: 'invoice'|'link'|'email', status: 'processing'|'ready'|'failed'|'used', file: StoredFile|null, links: string[], email_from, email_subject, email_received_at, attachments: StoredFile[], extracted: Draft|null, extracted_by: 'ai'|'page'|'basic', error: string|null (message for the customer), order_id, created_at }`

`Draft = { is_order, brand, order_number, order_date, currency, total, tracking_number, items: [{ title, quantity, unit_price, sku, url, image_url, notes }], links?: [{ url, ok, error, title, read_by }] }`

`StoredFile = { path, name, type, size?, url (signed, ~1 h) }`

- Invoice and email reading uses Claude (`ANTHROPIC_API_KEY`, model `AI_MODEL`). Without a key, files and emails are still saved and the customer types the products in.
- Product links are read from the page (JSON-LD / Open Graph / Shopify), with AI as a fallback when configured. Only public http(s) hosts are fetched.
- Forwarded emails (Postmark): set `INBOUND_EMAIL_ADDRESS` (the server's inbound address, `<hash>@inbound.postmarkapp.com`) and `INBOUND_EMAIL_SECRET`. In Postmark → your server → Inbound stream → Settings, set the webhook URL to `https://inbound:<INBOUND_EMAIL_SECRET>@<public-api-host>/api/inbound/email`. Each customer's personal address is `<hash>+<token>@inbound.postmarkapp.com`. The customer is notified (link `/app/orders/new?import=<id>`) once the email has been read; Postmark retries are de-duplicated. Local test without Postmark: `npm run email:test -- customer@v360.test`.

`OrderDetail = Order & { status_label, units: Unit[] (sorted by line_no), events: [{id,status,note,created_at}], invoice: Invoice|null (issued/paid only, lines without partner_amount), shipment: Shipment|null, payments: Payment[] }`

`Order` columns: `id, reference ('SA-1001'), customer_id, customer_name, customer_code, brand, brand_order_number, tracking_number, status, has_issue, customer_notes, admin_notes, destination_country, destination_city, destination_address, shipping_service, priority, due_date, weight_kg, import_source ('manual'|'invoice'|'link'|'email'), import_id, brand_order_total, brand_order_currency, brand_invoice (StoredFile; signed url in detail responses), partner_route, transfer_id, approval_photos:[{url,type,name}], change_request, received_at, packed_at, paid_at, shipped_at, delivered_at, created_at, updated_at`

`Unit = { id, order_id, line_no, unit_title, stitching_type, size_chart_id, size_chart?: {id,name,person_name,variation,measurements}, product_link, notes, quantity, design:{neckline?,sleeves?,trouser?…}, reference_images:[{url,type}], status: 'pending'|'received'|'issue', issue_type, issue_note, issue_media:[{url,type}], received_at, unit_price, currency, product_image_url, brand_sku }`

`SizeChart = { id, person_name, variation, name ('Me · Standard v3'), measurements: { shoulder, bust, waist, hip, armhole, sleeve, shirt_length, trouser_length, bottom_opening, shalwar_gheer, neck_depth } (inches, numbers), fit_feedback, notes, created_at, updated_at }`

`Invoice = { id, number ('INV-1001'), status: 'draft'|'issued'|'paid', currency, fx_rate, subtotal_pkr, discount_pkr, total_pkr, total_foreign, partner_total_pkr, notes, issued_at, paid_at, lines: [{ id, kind, label, description, quantity, customer_amount, partner_amount, sort_order }] }`
`kind`: `stitching | accessory | accessory_stitching | shipping | duties | discount | other` (discount amounts are subtracted).

`Shipment = { id, order_id, shipped_from: 'admin_warehouse'|'partner', status: 'needs_label'|'labelled'|'handed_to_courier'|'delivered', courier, service, tracking_number, rate_pkr, weight_kg, dimensions, label_printed_at, handed_at, delivered_at }`

### Order statuses (in flow order)
`submitted → received → (assigned) → cutting → stitching → qc_passed → [customer_approval] → packed → awaiting_payment (invoice issued) → paid → at_admin_warehouse | partner_dispatch → shipped → delivered` (+ `cancelled`)

Every response that returns an order also returns `status_label` (human text).

---

## Partner `/partner` (partner_staff, admin)

### Overview
`GET /overview?range=today|14days|30days` →
`{ range, inProduction, dueToday, rushDueToday, delayed, onTimeRate|null, inWarehouse, awaitingPayment, earningsThisMonth, dailyCapacity, capacityPct|null, dailyFinished:[{date,day,count,pct,isToday,isPeak}], workByStage:[{stage,count,pct}] (stage 'packed' = "In warehouse"), teamLoad:[{id,name,pct,load_pct,assigned,capacity}], tailorOutput:[{id,name,count,pct}] }`

### Receiving
| Method | Path | Notes |
|---|---|---|
| GET | `/receiving?tab=expected|issues|recent&search&page&limit` | rows: Order fields + `units[]`; `meta.counts {expected,issues,recent}`, `meta.suggestion {master,tailor}` |
| POST | `/receiving/units/:unitId/receive` | |
| POST | `/receiving/units/:unitId/issue` | `{ issue_type: 'piece_missing'|'damaged'|'wrong_item'|'other', note, media?: [{name,dataUrl}] }` (photos optional) |
| POST | `/receiving/orders/:orderId/receive-all` | marks all pending units received |
| GET/POST | `/receiving/unmatched` | `{ label_text, brand, tracking_number, notes }` |
| PATCH | `/receiving/unmatched/:id` | `{ status: open|matched|returned, matched_order_id, notes }` |

### Teams
| GET | `/teams?includeInactive=true` | `{ masters: [Member & { tailors: Member[], team_assigned, team_capacity, team_load_pct }], unassignedTailors, members }` |
|---|---|---|
| POST | `/teams/members` | `{ name, role: 'master'|'tailor', daily_capacity, master_id (tailor) }` |
| PATCH | `/teams/members/:id` | any of the above + `is_active` |
| DELETE | `/teams/members/:id` | deactivates |

`Member = { id, name, role, master_id, daily_capacity, is_active, assigned, load_pct, load_status: 'free'|'busy'|'full' }`

### Production board (job cards — one per received unit)
Stages: `to_assign, cutting, stitching, qc, packed`.

| Method | Path | Notes |
|---|---|---|
| GET | `/production/board?search&masterId&tailorId&priority=rush&delayed=true&limit=15` | `{ columns: [{ stage, label, items: Card[], total, nextCursor|null }], delayedCount }` |
| GET | `/production/columns/:stage?cursor=…&limit=15` (+ same filters) | `{ stage, items, total, nextCursor }` — infinite scroll inside one column |
| GET | `/production/cards/:id` | CardDetail |
| PUT | `/production/cards/:id/move` | `{ stage, prevId, nextId }` — ids of the cards directly above/below the drop spot (null at the ends). Returns `{ card, orderStatus }`. Entering cutting/stitching auto-assigns the least-loaded master/tailor if missing. |
| PATCH | `/production/cards/:id` | `{ master_id?, tailor_id?, due_date?, priority? }` → Card |
| POST | `/production/cards/:id/assign` | `{ master_id? }` (suggested if omitted) → moves to cutting |
| POST | `/production/cards/:id/comments` | `{ body }` |
| PATCH | `/production/cards/:id/qc-checklist` | `{ checklist: { measurements, seams, threads, pressed, notes } }` |
| POST | `/production/cards/:id/ask-customer` | `{ message }` → customer notification + timeline |
| GET | `/production/suggestions?masterId` | `{ master: {id,name,assigned,load_pct}|null, tailor: …|null }` |
| GET | `/production/scan?code=SA-1001` | Card[] matching order reference or customer code |

`Card = { id, order_id, unit_id, stage, position, master_id, tailor_id, master:{id,name}|null, tailor:{id,name}|null, priority, due_date, order_reference, customer_code, unit_title, qc_passed, qc_notes, qc_checklist, cutting_at, stitching_at, qc_at, packed_at, created_at, comments_count, is_delayed, days_late, status: 'on_time'|'rush'|'delayed', unit: { id, line_no, unit_title, stitching_type, notes, product_link, quantity, design, reference_images, received_at, size_chart: { id, name, person_name, variation, measurements, fit_feedback, notes }|null }, order: { id, reference, brand, customer_id, customer_name, customer_code, destination_country, destination_city, status, priority, due_date, received_at, paid_at, change_request, customer_notes, approval_photos, created_at } }`

`CardDetail = Card & { activity: [{ id, kind: 'comment'|'activity', author_name, body, created_at }] (newest first), order_events: [...], order_cards: [{id,stage,unit_title,qc_passed,unit:{line_no}}], qc_items: [{ key, label }] }`

### Quality check
| GET | `/qc?status=pending|passed&search&page` | Card rows; `meta.counts {pending, passed}` |
|---|---|---|
| POST | `/qc/cards/:id/pass` | `{ notes? }` |
| POST | `/qc/cards/:id/fail` | `{ notes }` → back to stitching |
| POST | `/qc/orders/:orderId/request-approval` | `{ photos: [{name,dataUrl}] }` → order `customer_approval` |
| POST | `/qc/orders/:orderId/pack` | `{ weight_kg }` → all cards packed, order `packed` |

### Warehouse
| GET | `/warehouse?tab=to_invoice|awaiting_payment|paid|dispatched&search&page` | rows: Order fields + `units_count, invoice{number,status,issued_at,total_pkr,currency,total_foreign}|null, transfer{code,status}|null, shipment|null`; `meta.counts` |
|---|---|---|
| POST | `/warehouse/orders/:id/weight` | `{ weight_kg }` |
| POST | `/warehouse/orders/:id/route` | `{ route: 'admin_warehouse'|'direct_dispatch' }` (paid orders only) |
| POST | `/warehouse/orders/:id/ship` | `{ courier, tracking_number }` (direct dispatch) |
| GET | `/warehouse/transfers?status=open,in_transit` (one or more, comma separated) | Transfer rows with `orders[]` |
| POST | `/warehouse/transfers/:id/dispatch` | open → in_transit |

### Earnings
`GET /earnings/summary` → `{ thisMonth, pending, lastSixMonths, lifetime, articlesThisMonth, monthly:[{key,month,amount,pct}] }`
`GET /earnings?status=paid|issued&search&page` → rows `{ id, number, status, issued_at, paid_at, partner_total_pkr, order:{id,reference,customer_name,customer_code,units_count} }`

---

## Admin `/admin` (admin only)

| Method | Path | Notes |
|---|---|---|
| GET | `/overview?period=this_week|this_month|6_months` | `{ period, ordersInPeriod, internationalOrders, inProduction, waitingForInvoice, awaitingPayment, awaitingPaymentPkr, delayedOrders, ordersPerMonth:[{month,key,international,pakistan,intlPct,pkPct}], whereOrdersShip:[{country,count,pct}], ordersByStatus:[{key,status,count,pct}], needsAction:[{id,code,title,subtext,actionType:'INVOICE'|'RECEIVE'|'OPEN',link,queryParams}] }` |
| GET | `/orders?group=all|awaiting_parcel|production|invoice|payment|warehouse|shipped|issues|cancelled&status&search&page&limit&sort&dir` | rows `{ id, reference, brand, status, status_label, has_issue, priority, customer_name, customer_code, destination_city, destination_country, due_date, created_at, units_count }`; `meta.counts` per group |
| GET | `/orders/:id` · `/orders/by-ref/:reference` | OrderDetail + `customer`, `cards[]`, `transfer`, invoice incl. partner amounts |
| PATCH | `/orders/:id` | `{ status?, note?, notifyCustomer?, admin_notes?, due_date?, priority?, has_issue? }` |
| POST | `/orders/:id/units/:unitId/resolve` | `{ note? }` issue → received |
| GET | `/customers?search&page&sort` | Profile + `{ total_orders, active_orders, total_spent_pkr, last_order_at }` |
| GET | `/customers/:id` | Profile + `orders[]`, `size_charts[]` |
| GET | `/users?role=staff|admin|partner_staff|customer|requests&search&page` | Profile rows; `meta.requestsCount` |
| PATCH | `/users/:id/role` | `{ role }` |
| PATCH | `/users/:id/active` | `{ is_active }` |
| GET | `/reports?months=6` | `{ months, totals:{revenuePkr,partnerPayoutPkr,marginPkr,marginPct,discountsPkr,paidInvoices,orders,cancelled,avgTurnaroundDays}, monthly:[{key,month,revenue,payout,margin,orders,pct}], byChargeType:[{kind,customer,partner,margin}], topBrands:[{name,count}], topCountries:[{name,count}] }` |
| GET/POST | `/price-items` (`?category&active=true&search&page`) | `{ id, category, name, unit, partner_cost, customer_price, margin, is_active }` |
| PATCH/DELETE | `/price-items/:id` | Stitching/lace-style items now live in Articles (customer price / partner cost / margin); the price list is for extra charges only. The invoice builder suggests stitching lines from each piece's picked articles (falls back to the price list). |
| GET/POST | `/shipping-rates` | `{ id, courier, zone, countries:string[], service, transit_time, max_weight_kg, base_rate, per_extra_kg, ddp_available, ddp_fee, is_active }` |
| PATCH/DELETE | `/shipping-rates/:id` | |
| GET | `/invoices?tab=to_invoice|issued|paid&search&page` | rows `{ order, invoice|null }`; `meta.counts`, `meta.outstandingPkr` |
| GET | `/invoices/builder/:orderId` | `{ order (with units, customer), invoice|null, suggestedLines|null, priceItems, shippingOptions:[rate & {price_pkr, recommended}], currency, suggestedFxRate }` |
| PUT | `/invoices/builder/:orderId` | `{ currency, fx_rate, notes, lines:[{kind,label,description,quantity,customer_amount,partner_amount,price_item_id?,unit_id?}] }` → draft Invoice |
| POST | `/invoices/:id/issue` | draft → issued, order → awaiting_payment |
| POST | `/invoices/:id/reopen` | issued → draft |
| POST | `/invoices/:id/mark-paid` | `{ method: 'bank_transfer'|'manual', reference }` |
| GET | `/warehouse/summary` | `{ transfersInTransit, parcelsInTransit, needsLabel, readyForCourier, shippedToday }` |
| GET | `/warehouse/transfers?status=in_transit|received` | Transfer rows with `orders[]` |
| POST | `/warehouse/transfers/:id/receive` | orders → at_admin_warehouse, shipments needs_label |
| GET | `/warehouse/parcels?status=needs_label|labelled|handed_to_courier|delivered&search&page` | Shipment rows with `order` |
| GET | `/warehouse/parcels/:id/courier-options` | rates with `price_pkr, recommended` |
| POST | `/warehouse/parcels/:id/label` | `{ shipping_rate_id?, courier, tracking_number, rate_pkr?, dimensions?, weight_kg? }` |
| POST | `/warehouse/parcels/:id/handed` | → order shipped |
| POST | `/warehouse/parcels/:id/delivered` | → order delivered |

## Sidebar badges
- `GET /admin/badges` → `{ invoices, warehouse, orders (open issues), settings (access requests) }`
- `GET /partner/badges` → `{ receiving, qualityCheck, warehouse }`

## Admin partner switcher (`X-Partner-Id`)

An admin may send `X-Partner-Id: <partner uuid>` on any request. The server then works inside that partner only: admin
orders (list, counts, detail, edits), overview, badges, invoices, warehouse, reports, and the partner endpoints
(`/partner/*`, users, teams, production, ...). An order id of another partner is refused (403 on writes, 404 on reads).
An unknown partner id answers 404, a malformed one 400. The header is ignored for every non-admin, so a partner user
can never switch tenant with it. Without the header an admin sees all partners.

## Staff type (migration 0006)

Partner users carry `staff_type`: `master`, `tailor` or `staff` (set with `staff_type` on `POST/PATCH /partner/users`).
It is a label and a starting point for permissions; access is still `permissions`, always within the partner's modules.
