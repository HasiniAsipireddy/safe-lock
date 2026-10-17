# Safe Lock

A mobile-first web platform for **renting** a physical smart safe by the hour
and locking or unlocking it remotely. See [`CLAUDE.md`](./CLAUDE.md) for the
architecture and [`docs/decisions.md`](./docs/decisions.md) for why things are
the way they are.

```
apps/web        Next.js frontend (App Router, Tailwind)
apps/api        Express + Prisma backend, REST under /api/v1
packages/shared Types, zod schemas and constants used by both
```

**Built so far:** auth (signup / login / rotating sessions, password reset by
one-time code), **hourly rental bookings** — hold, pay, extend, overstay fees,
collect — paid through Razorpay, **remote lock / unlock with a one-time code**
against a mock device, WhatsApp delivery with phone verification, the
`/history` activity feed with in-app notifications, **scheduled WhatsApp
reminders** across a booking's life, an admin panel (bookings, device
inventory, users, payments, audit), and the legal pages.

**Not built yet:** real hardware. The device gateway is a mock that always
acks, which means a booking completion commands the safe locked on a
best-effort basis — see step 9 in `CLAUDE.md`.

**Before production:** WhatsApp needs **ten Meta-approved templates** (five for
auth and alerts, five for the rental lifecycle) and the four `WHATSAPP_*`
credentials; until then `WHATSAPP_PROVIDER=fake` is the only legal value and
the env schema refuses `fake` in production. **Two of the rental templates
cannot be submitted until the production domain is decided** — their URL button
bakes in a base URL, which must match `PUBLIC_WEB_URL`. A user with no verified
phone still has no password-reset channel — the one real gap, tracked in
`CLAUDE.md`.

---

## Prerequisites

- **Node 22 LTS** (`.nvmrc`). Newer versions work but print an `EBADENGINE`
  warning — see `docs/decisions.md`.
- **Docker** — the dev database runs in a container.
- npm 10+ (this repo uses npm workspaces, not pnpm).
- **PostgreSQL with the `btree_gist` extension available.** The booking
  migration runs `CREATE EXTENSION IF NOT EXISTS btree_gist` itself, which the
  Docker image allows. It is needed for the exclusion constraint that stops two
  bookings occupying one safe (mixing `=` on `deviceId` with `&&` on a time
  range in one constraint requires it).

  **If you deploy to managed Postgres, check that extension is permitted
  first.** `btree_gist` is a standard contrib module and is allowed on RDS,
  Cloud SQL, Azure, Supabase and Neon — but it is the one thing in this design
  a provider can simply refuse, and without it the migration fails at deploy
  time rather than at runtime.

## First run

```bash
npm install

# Start PostgreSQL 16 in Docker.
#
# It binds host port 5433, NOT the default 5432, so it cannot clash with a
# PostgreSQL service already installed on your machine. The container creates
# two databases on first start: `safelock` and `safelock_test`.
npm run db:up

# Backend config. The committed example already points at the Docker database.
cp apps/api/.env.example apps/api/.env
# Then: generate secrets and paste in your Razorpay test keys. JWT_ACCESS_SECRET
# and OTP_HMAC_SECRET are both required, both 32+ chars, and should be DIFFERENT
# values — rotating one should not invalidate the other. Run this twice:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# Frontend config.
cp apps/web/.env.example apps/web/.env.local

npm --workspace apps/api run prisma:migrate

# Optional: create an ADMIN account (reads the SEED_ADMIN_* vars from .env).
npm --workspace apps/api run db:seed
```

Then, in two terminals:

```bash
npm run dev:api    # http://localhost:4000/api/v1
npm run dev:web    # http://localhost:3000
```

### Mock mode (no backend, no Razorpay)

`apps/web/.env.local` ships with `NEXT_PUBLIC_USE_MOCK_API=true`, which routes
every API call to an in-browser fake. The whole payment flow works in mock
mode: every payment step shows a **Simulate payment** button instead of
Razorpay Checkout, so booking, extending, paying an overstay fee and collecting
can all be walked end to end with no backend and no Razorpay account.

What mock mode **cannot** show is that concurrent booking is safe — there is no
exclusion constraint in a browser tab. That guarantee is tested against real
Postgres in the API suite, where it belongs.

Demo account: `demo@example.com` / `Demo1234`.

Mock mode is refused in production builds — `apps/web/src/lib/env.ts` throws at
startup. A production build therefore needs `NEXT_PUBLIC_USE_MOCK_API=false`.

## Everyday commands

```bash
npm run lint                                      # all workspaces
npm run typecheck                                 # all workspaces
npm test                                          # API suite (vitest + supertest)
npm --workspace apps/api test
npm --workspace apps/api run prisma:migrate       # prisma migrate dev
npm --workspace apps/api run prisma:studio
npm --workspace apps/api run db:seed              # create/update the ADMIN
npm --workspace apps/api run db:cleanup-tokens    # prune dead refresh tokens
npm run db:up / db:down / db:reset                # db:reset wipes the volume
```

Dependencies are **pinned to exact versions** (`.npmrc` sets `save-exact=true`).
`npm install <pkg>` will therefore record an exact version, not a caret — that
is deliberate for a security-sensitive service. Upgrades should be their own
reviewable commit.

---

## Sessions and auth

| | Access token | Refresh token |
|---|---|---|
| Form | signed JWT | opaque random bytes (32) |
| Lifetime | 15 minutes | 7 days |
| Stored | nowhere (stateless) | `RefreshToken` table, **SHA-256 only** |
| Cookie | `safelock_at`, `Path=/` | `safelock_rt`, `Path=/api/v1/auth` |
| Revocable | no (short-lived) | yes |

Both cookies are `httpOnly`, `sameSite=lax`, and `secure` in production. The
browser never sees a token from JavaScript.

**The refresh cookie is path-scoped on purpose:** the browser only sends it to
`/api/v1/auth/*`, so the long-lived credential never reaches the payment,
device or admin routes.

### Rotation and reuse detection

`POST /api/v1/auth/refresh` revokes the presented token and issues a successor
in the same *family* (one login = one family). If an already-rotated token is
presented again:

- **Within 10 seconds** — treated as two tabs racing, not theft. It mints **one**
  sibling token in the same family, so both tabs keep working. Audited as
  `auth.refresh.grace_used`.
- **After 10 seconds, or a second time** — treated as theft. The whole family
  *and every other refresh token for that user* is revoked, `401`
  `REFRESH_REUSE_DETECTED` is returned, and `auth.refresh.reuse_detected` is
  audited. The user must sign in again.

The grace window is the constant `REFRESH_GRACE_WINDOW_MS` in
`apps/api/src/modules/auth/refreshToken.service.ts`. **Set it to 0 to disable
the grace window entirely** — any replay then revokes the family immediately,
at the cost of logging out a user whose tabs raced. The tradeoff is written up
in `docs/decisions.md`.

The web client handles this automatically: a 401 on any request (except
login/signup/refresh) triggers **one shared** refresh — concurrent 401s await
the same promise rather than each racing a refresh — then retries the original
request once. If the refresh fails, `AuthContext` drops the user and the route
guards redirect to `/login`.

### CSRF

`originCheck` runs on every POST/PUT/PATCH/DELETE except the Razorpay webhook.
`Origin` must match `WEB_ORIGIN` by **exact string equality**, and a *missing*
`Origin` is rejected when auth cookies are present. A cookie-less caller (curl,
server-to-server) is allowed through — it has no ambient credentials to abuse.

> **Deploy constraint:** `sameSite=lax` cookies are not sent across unrelated
> domains. The web app and the API **must be same-site** in production
> (`app.example.com` + `api.example.com`). A Vercel frontend talking to a Render
> API on a different domain will not keep a session. The future mobile app will
> need a bearer-token flow instead — see `docs/decisions.md`.

### Observability

Every request gets an `X-Request-Id` (an incoming one is honoured if it matches
`[A-Za-z0-9._-]{1,64}`, otherwise generated). It appears in every pino log
line, in `error.requestId` of any error response, and in the response header —
so a user can quote it in a support request.

`GET /api/v1/health` runs `SELECT 1` with a 2-second timeout: `200
{"status":"ok"}` or `503 {"status":"degraded"}`, with no internal detail.

---

## Razorpay setup (test mode)

### 1. Create a test account and get keys

1. Sign up at [razorpay.com](https://razorpay.com) and open the
   [Dashboard](https://dashboard.razorpay.com).
2. Switch the toggle to **Test Mode**. Nothing below needs a live, activated
   account — test mode works immediately.
3. Go to **Account & Settings → API Keys → Generate Test Key**.
4. You get a **Key Id** (`rzp_test_…`) and a **Key Secret**, shown **once**.
   Copy both into `apps/api/.env`:

   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   ```

The key secret stays on the server. Only the key id is ever sent to the
browser, as part of a booking order response.

### 2. Set the rates

```
RENTAL_HOURLY_RATE_PAISE=10000   # paise/hour, so 10000 = ₹100/hour
RENTAL_MIN_HOURS=1
RENTAL_MAX_HOURS=24

OVERSTAY_MULTIPLIER_BPS=15000    # basis points: 15000 = 1.5x the hourly rate
OVERSTAY_GRACE_MINUTES=15        # free minutes after a booking ends
OVERSTAY_CAP_HOURS=24            # most hours of overstay ever charged
COLLECTION_WINDOW_MINUTES=30     # time to collect after the fee is settled

BOOKING_HOLD_MINUTES=10          # how long an unpaid booking holds its safe
OVERSTAY_QUOTE_TTL_MINUTES=15    # how long an overstay quote is binding
```

Every amount is computed server-side from these on every order. The client
never sends an amount, and a request body that tries to is rejected by a
`.strict()` schema.

**These five are snapshotted onto each booking at creation**
(`hourlyRatePaise`, `overstayMultiplierBps`, `graceMinutes`, `capHours`,
`collectionWindowMinutes`), so changing any of them never re-prices a booking
that is already running. The multiplier is basis points rather than a decimal
because money must never touch a float.

All of these are **provisional placeholders**, not business decisions — see the
open questions in `CLAUDE.md`.

### 3. Set up the webhook with ngrok

Razorpay has to reach your machine, so the local API needs a public URL.

```bash
# Install from https://ngrok.com/download, then:
ngrok http 4000
```

ngrok prints a forwarding URL such as `https://a1b2c3d4.ngrok-free.app`. Your
webhook endpoint is that plus the API path:

```
https://a1b2c3d4.ngrok-free.app/api/v1/payments/webhook
```

In the Dashboard: **Settings → Webhooks → Add New Webhook**.

- **Webhook URL** — the URL above.
- **Secret** — invent a strong random string, then put the *same* value in
  `apps/api/.env` as `RAZORPAY_WEBHOOK_SECRET`. This is **not** your API key
  secret; it is a separate per-webhook secret.
- **Active Events** — tick exactly these three:
  - `payment.captured`
  - `payment.failed`
  - `refund.processed`

Restart the API after changing `.env`.

> The free ngrok URL changes every restart. Update the webhook URL in the
> Dashboard each time, or use a reserved domain.

### 4. Test cards

With test keys, no real money moves. Razorpay's full list is in their
[test card docs](https://razorpay.com/docs/payments/payments/test-card-details/);
the usual ones:

| Purpose | Card number | Expiry | CVV | Notes |
|---|---|---|---|---|
| Successful payment | `4111 1111 1111 1111` | any future date | any 3 digits | Visa, domestic |
| Successful payment | `5267 3181 8797 5449` | any future date | any 3 digits | Mastercard |
| Failed payment | `4000 0000 0000 0002` | any future date | any 3 digits | Exercises the failure path |

For UPI in test mode, use VPA `success@razorpay` (and `failure@razorpay` to
force a failure).

### 5. Walking the flow

1. Sign up at `http://localhost:3000/signup`.
2. You land on `/dashboard`, which says you have no safe booked.
3. Click **Book a safe** → `/book`. Pick a duration; the price for each comes
   from the server's quote, and the overstay rule is stated with its real
   figures *before* you commit to anything.
4. Click **Continue to payment**. A safe is now **held** for
   `BOOKING_HOLD_MINUTES` — the booking is `PENDING_PAYMENT` and no money has
   moved. Your rental hours have **not** started yet.
5. Click **Pay** → Razorpay Checkout opens with your name, email and phone
   prefilled.
6. Pay with a test card. Checkout calls back, the browser posts to
   `/payments/verify`, and the server checks the HMAC signature before marking
   the payment `PAID` **and activating the booking in the same transaction**.
   `endsAt` is set from *now*, so a slow checkout did not cost you time.
7. Separately, Razorpay delivers `payment.captured` to your webhook. **The
   webhook is the source of truth** — if you close the tab before step 6, the
   webhook still activates the booking.
8. `/dashboard` now shows the safe with working Lock / Unlock controls, the
   time left, and buttons to **extend** or **collect**.

**Extending:** pick extra hours on the dashboard and pay. Allowed while running
and during the grace period, refused once a fee is actually owed.

**Collecting:** "I've collected my items" ends the booking and returns the safe
to the pool. This is an explicit user action because the safe cannot tell
whether it is empty.

**Seeing an overstay** without waiting an hour — edit the row directly:

```bash
npm --workspace apps/api run prisma:studio
```

Set the booking's `endsAt` to about 90 minutes ago (which is past the
15-minute grace period, so one hour has accrued). Reload `/dashboard`:

- the booking reads **Overstaying** with a fee, computed from the clock —
  **before the sweeper has run**, which is the whole point of deriving status
  on every read;
- **Unlock is disabled** with the reason shown, and **Lock still works**;
- **Collect is disabled** too, and the API refuses it with 402
  `OVERSTAY_PAYMENT_REQUIRED` if called directly;
- paying the fee opens a collection window and re-enables both.

**A payment that cannot be applied.** Let a hold lapse (set `holdExpiresAt`
into the past), have a second account book the same safe, then deliver a
`payment.captured` for the first order. The payment stays `PAID`, gets
`reviewReason: BOOKING_EXPIRED_DEVICE_TAKEN`, appears under **Admin →
Payments → Needs a refund**, and `/payments/verify` answers
`needsReview: true` — which the UI renders as "your payment went through but
we could not apply it", never as success.

To test a refund: find the payment in the Dashboard, issue a refund, and watch
`refund.processed` arrive. The payment flips to `REFUNDED` and any review flag
is cleared. **It does not end the booking** — a safe someone is physically
using cannot be reclaimed by a webhook.

### Checking what happened

```bash
npm --workspace apps/api run prisma:studio
```

`Booking` holds the rental and its rate snapshot, `Payment` holds the order,
its `purpose` and any `reviewReason`, `WebhookEvent` is the idempotency ledger
(one row per delivered event id), and `AuditLog` records every booking action,
order, verification, signature failure and webhook.

---

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | none | `SELECT 1`; 200 ok / 503 degraded |
| `POST` | `/api/v1/auth/signup` | none | Create an account, start a session |
| `POST` | `/api/v1/auth/login` | none | Email-or-phone + password |
| `POST` | `/api/v1/auth/refresh` | refresh cookie | Rotate the session |
| `POST` | `/api/v1/auth/logout` | optional | Revoke the refresh token, clear cookies |
| `GET` | `/api/v1/auth/me` | access cookie | Current user. **No payment or device flags** — ask `/bookings/current`. |
| `GET` | `/api/v1/bookings/current` | cookie | The caller's live booking (or `null`) **plus a quote** for a new one |
| `GET` | `/api/v1/bookings/:id` | cookie | One of the caller's bookings. 404 for anyone else's. |
| `POST` | `/api/v1/bookings` | cookie | `{ hours }` — holds a safe, `PENDING_PAYMENT`. No amount in the body. |
| `POST` | `/api/v1/bookings/:id/order` | cookie | Razorpay order for the booking, priced server-side |
| `POST` | `/api/v1/bookings/:id/extend/order` | cookie | `{ hours }` — order for an extension, at the booking's snapshotted rate |
| `POST` | `/api/v1/bookings/:id/overstay/order` | cookie | Order for the outstanding fee. Quote binding for a TTL. |
| `POST` | `/api/v1/bookings/:id/collect` | cookie | "I've got my things" — ends it. `402` while a fee is owed. |
| `POST` | `/api/v1/bookings/:id/cancel` | cookie | Cancel an **unpaid** booking and release the safe |
| `GET` | `/api/v1/devices/mine` | cookie | The safe the caller's paid booking holds, or `null` |
| `POST` | `/api/v1/devices/lock` | cookie | Lock the safe. Idempotent — an already-locked safe is a 200. |
| `POST` | `/api/v1/devices/unlock/request` | cookie | Send a one-time code. Returns no code. |
| `POST` | `/api/v1/devices/unlock/confirm` | cookie | `{ otp }`; only this opens the safe. |
| `GET` | `/api/v1/devices/history` | cookie | The caller's activity, newest first. `?cursor=&limit=` (max 50). |
| `GET` | `/api/v1/notifications` | cookie | Unread first, plus the total unread count. `?limit=` |
| `POST` | `/api/v1/notifications/read` | cookie | `{ ids? }` — mark read. Idempotent; omit `ids` for all. |
| `GET` | `/api/v1/admin/bookings` | ADMIN | Bookings, with `status`, `flagged`, `q`, `page` |
| `POST` | `/api/v1/admin/bookings/:id/force-complete` | ADMIN | `{ reason, needsInspection? }` — end it by hand |
| `POST` | `/api/v1/admin/bookings/:id/waive-overstay` | ADMIN | `{ reason }` — write the fee off |
| `GET` | `/api/v1/admin/devices` | ADMIN | Inventory, with `status`, `occupied`, `q`, `page` |
| `POST` | `/api/v1/admin/devices` · `/devices/bulk` | ADMIN | Add one, or up to 500 with per-row results |
| `POST` | `/api/v1/admin/devices/:id/clear-inspection` | ADMIN | `{ note }` — return an inspected safe to the pool |
| `POST` | `/api/v1/admin/devices/:id/retire` | ADMIN | Take out of service. Refused if it has a live booking. |
| `POST` | `/api/v1/admin/payments/:id/clear-review` | ADMIN | `{ note }` — record that flagged money was refunded by hand |
| `GET` | `/api/v1/admin/users` · `/payments` · `/audit` | ADMIN | Paginated admin listings |
| `POST` | `/api/v1/payments/verify` | cookie | Verify the Checkout signature, mark `PAID` and apply it. Idempotent. |
| `POST` | `/api/v1/payments/webhook` | HMAC | Razorpay's callback. Raw body, signature-verified, deduped by event id. |

**Gone with the purchase model:** `POST /payments/order`, `GET /payments/me`,
`/admin/devices/:id/allocate`, `/admin/allocate-next`,
`/admin/devices/:id/unassign`, and the `requirePaid` middleware. Orders are
created from the booking routes, where the amount comes from a booking's
snapshotted rates. `requireAdmin` returns `403` for non-admins and is applied
to the whole `/admin` router.

**No booking request carries an amount, a start time or an end time.** The
duration in hours is the only thing a client chooses; every other figure is the
server's, and the schemas are `.strict()` so a body supplying one is a 400
rather than a silent ignore.

`/devices/mine`, `/devices/history` and the notification routes carry
**`requireAuth` only** — no eligibility gate. They serve the caller's own
record, so a user between bookings gets `null` or an empty list rather than an
error. The lock/unlock routes are the opposite: they go through
`assertCanOperate`, which requires a verified phone, a live booking, and (for
unlock) no outstanding fee.

---

## Admin workflow

### Getting an admin account

```bash
# Set SEED_ADMIN_* in apps/api/.env (password must be 12+ characters), then:
npm --workspace apps/api run db:seed
```

Sign in as that account and an **Admin** link appears in the header. The link
is only rendered for admins, but that is cosmetic — every `/admin/*` endpoint
is behind `requireAdmin` on the server, so typing the URL achieves nothing.

### Bookings — the work queue

**Admin → Bookings** opens on **Needs attention**, and that default is the
point. Two situations will otherwise sit unnoticed forever:

- an **unpaid overstay**, which nothing completes automatically. The fee is
  capped, the safe stays reserved, and the sweeper deliberately leaves the row
  alone — because quietly releasing a safe that may still hold somebody's
  belongings is the one outcome worth avoiding at any cost;
- a booking whose safe came back with **unknown contents** and is sitting in
  `NEEDS_INSPECTION`.

Two actions, both requiring a reason that is recorded on the booking and in the
audit log:

- **Force complete** ends a booking by hand. The **"hold this safe for a staff
  check"** box is **on by default** — leave it on unless you have opened the
  safe yourself and know it is empty, because the next renter would be able to
  unlock whatever is inside.
- **Waive fee** writes an overstay off. The renter can then unlock and collect.
  It records zero collected, so a write-off never looks like revenue.

### Adding devices to the inventory

**Admin → Devices.** Two ways:

- **Add a device** — one serial at a time.
- **Bulk add** — paste one serial per line, up to **500** per request. Every
  row comes back marked `created`, `duplicate` or `invalid` with the line
  number, so one bad line does not reject the paste.

Serials must match `SAFE-` followed by 4–12 digits or capitals (e.g.
`SAFE-0001`). Input is **trimmed and uppercased** before validation, so
`safe-0001` and `SAFE-0001` are the same device and cannot be added twice. The
format is **provisional** — see `docs/decisions.md` before ordering hardware.

### There is no allocation

Paying for a booking is what gets a safe, and which safe is decided by the
booking service under `FOR UPDATE SKIP LOCKED`, with a Postgres exclusion
constraint as the actual guarantee. The Devices tab shows who currently has
each safe and until when; the Users tab shows the same thing from the other
side.

### Clearing an inspection, and retiring

- **Clear inspection** returns a `NEEDS_INSPECTION` safe to the bookable pool.
  It **requires a note**, and the note is the point: it is the only record that
  a human looked inside. Audited.
- **Retire** takes a device permanently out of service. It is **refused while
  the device has a live booking** (`DEVICE_HAS_LIVE_BOOKING`): force-complete
  first, so hardware is never retired out of a renter's hands.

### Payments that need a refund

**Admin → Payments → Needs a refund** lists money we captured and could not
apply. Those rows stay `PAID` — we never rewrite a payment to pretend it did
not happen — so this filter is the only way to find them.

**The refund itself happens in the Razorpay dashboard.** There is no refund
call anywhere in this codebase: the dashboard is the only place with the
authority and its own ledger. Issue the refund there, then click **Mark
refunded** here with a note (a Razorpay refund id is ideal). That records it
without touching the payment's status — a payment is `PAID` until Razorpay says
otherwise, and the `refund.processed` webhook is what says so. When that webhook
arrives it clears the flag by itself, so the manual step covers the cases where
it never does.

## Locking and unlocking

Once a booking is paid, the renter gets working controls on `/dashboard`.

**Lock** is one tap plus a confirmation. It is idempotent — locking an
already-locked safe is a success that sends no command, not a 409. It stays
available during an unpaid overstay, and for an unverified phone: refusing to
let someone secure a safe they are standing at would punish them in the one
direction that creates risk.

**Unlock** always costs a one-time code:

1. Tap **Unlock**. The API creates a challenge and generates a 6-digit code.
2. The code is sent over **WhatsApp** to the verified number. In development it
   is also **printed to the API terminal**:
   ```
   [dev] Unlock code for SAFE-0001: 418290  (expires 2026-10-16T05:12:44.901Z)
   ```
   In mock mode (no backend) it is shown in an amber panel in the dialog
   instead.
3. Type or paste it. 5 minutes, single use, 5 wrong attempts before the
   challenge dies. Requesting a new code kills the old one.

Eligibility is re-checked **inside the confirm transaction with the device row
locked**, not only when the code was requested — a booking can end between the
two. Completing a booking also consumes every open challenge for it.

Both routes refuse anyone who is not entitled, with a code the UI can act on:

| Code | Status | Meaning |
| --- | --- | --- |
| `NO_ACTIVE_BOOKING` | 409 | No live, paid booking. Booking one fixes it. |
| `OVERSTAY_PAYMENT_REQUIRED` | 402 | A fee is owed. **Unlock and collect are refused; lock is not.** |
| `PHONE_NOT_VERIFIED` | 403 | Unlock only — the one-time code has nowhere to go. |
| `DEVICE_STATE_UNKNOWN` | 409 | The safe is not reporting a state. Should be unreachable. |
| `OTP_INVALID` / `OTP_EXPIRED` / `OTP_TOO_MANY_ATTEMPTS` / `OTP_NOT_FOUND` | 400 | Code problems. |

Every state change writes a `DeviceEvent` (the renter's activity feed, which
`/history` reads) **and** an `AuditLog` row. Failed code attempts are written
to both as well — a run of them against one account is worth seeing, and the
event carries a `failureReason` from a fixed enum. Neither ever contains the
code.

### Activity and notifications

**`/history`** shows every lock and unlock on the caller's safe, grouped by
local day, newest first, with a **Load more** button (cursor-paginated — see
`docs/decisions.md` for why not an offset). Reachable from the nav and the
dashboard, and readable by any signed-in user including one with no booking.

An **unlock writes a `Notification` in the same transaction as the event**, so
there is no unlock the renter was not told about and no notification about an
unlock that rolled back. The header **bell** shows the unread count and polls
every 60 seconds while the tab is visible (pausing when hidden, refetching
immediately on return). Opening it marks the loaded notifications read.

Only two things notify: a **confirmed unlock**, and an unlock attempt that
**burns all 5 code attempts** — a possible tampering signal. A single mistyped
digit does not, and neither does locking.

The device layer behind all of this is one interface, `DeviceGateway`, with a
mock implementation that always acks after a short delay. Swapping in the real
MQTT gateway touches no route. See `docs/decisions.md`.

### A refund does not end a booking

A refund marks the money returned and nothing else. A safe someone is
physically using cannot be reclaimed by a webhook, and a booking already used
has nothing left to revoke — so `refund.processed` flips the `Payment` row to
`REFUNDED` and leaves the `Booking` alone.

If a refunded booking should also end, that is a deliberate admin action:
**Admin → Bookings → Force complete**, with a reason. Whether it *should* is
part of the still-open refund policy.

### Audit

**Admin → Audit** lists every security-relevant action, newest first,
filterable by action name (try `device.`). Both successes and failures are
recorded; failures carry the error code, and every row carries the
`requestId` that ties it to the server log lines.

## WhatsApp delivery and phone verification

Unlock codes, verification codes, unlock alerts and password-reset notices are
delivered over the **Meta WhatsApp Cloud API**.

### Local development: nothing to configure

`WHATSAPP_PROVIDER=fake` (the default) records messages in memory and sends
nothing. Codes are printed to the API console, exactly as before:

```
  [dev] Unlock code for SAFE-0001: 418203  (expires 2026-10-16T12:05:00.000Z)
  [dev] Phone verification code for +91 98****10: 905114  (expires ...)
```

The fake client **cannot be used in production** — the env schema refuses to
boot, and `mayUseFakeWhatsApp` refuses to construct it. No test in the repo can
reach the network either: `test/setup.ts` replaces `fetch` with a throwing stub
for the whole suite.

### What you need from Meta for production

Four credentials, from <https://developers.facebook.com> → your app:

| Variable | Where it comes from |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → API Setup. The temporary token expires in 24h — create a **System User** token for production. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → "Phone number ID". Not the phone number itself. |
| `WHATSAPP_APP_SECRET` | App Settings → Basic → App Secret. Keys the webhook HMAC. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | A random string **you** choose. Paste the same value into WhatsApp → Configuration → Webhook. |

Plus: a verified WhatsApp Business phone number, a completed business
verification, and the five approved templates below.

Set `WHATSAPP_PROVIDER=cloud`. The API refuses to start if any of the four is
missing or still a placeholder.

### Webhook

Point Meta at `https://<your-api-host>/api/v1/webhooks/whatsapp` and subscribe
to the **messages** field. Meta will GET it once with your verify token; the
API echoes the challenge back. Delivery statuses then arrive by POST and update
`OutboundMessage.deliveryStatus`.

Locally, use ngrok exactly as for the Razorpay webhook:

```bash
ngrok http 4000
# then use https://<id>.ngrok-free.app/api/v1/webhooks/whatsapp
```

The signature is verified over the raw body with the app secret before the body
is parsed, so a request without a valid `X-Hub-Signature-256` is a 401 and
never reaches the database.

### The five auth and alert templates to submit to Meta

Create these under WhatsApp → Manage templates. **Category matters**: the three
code-carrying templates must be `AUTHENTICATION`, which is what allows delivery
outside the 24-hour customer-service window — an unlock code is useless if it
can only be sent to someone who messaged you first. The two alerts are
`UTILITY`. Never use `MARKETING` for any of these: Meta rate-limits it per
recipient and lets users switch it off, neither of which is acceptable for a
security alert.

Authentication templates are built from Meta's fixed authentication layout:
the body is boilerplate you select rather than free text, you add a **copy-code
button**, and custom URLs are not allowed. The wording below is what that
layout produces; match it rather than pasting it verbatim if the console
differs.

---

**1. `safelock_unlock_code`** — category **AUTHENTICATION**, language `en`

- Body: `{{1}} is your verification code. For your security, do not share this code.`
- Button: **Copy code** (zero-tap off, code expiry 5 minutes)
- Parameters: `{{1}}` = the 6-digit code
- Sample: `418203`

> Note: Meta's authentication layout permits only the code parameter, so the
> safe's serial is **not** in this message, and the API passes `[code]` and
> nothing else. It used to pass `[code, serialNumber]`, which this template
> would have rejected as a `TEMPLATE` error — terminal, never retried, so no
> code would have arrived at all. A user has one live booking, so the message
> is unambiguous anyway, and the serial is in `safelock_unlock_alert` where a
> second parameter is allowed.

**2. `safelock_phone_verification`** — category **AUTHENTICATION**, language `en`

- Body: `{{1}} is your verification code. For your security, do not share this code.`
- Button: **Copy code** (code expiry 5 minutes)
- Parameters: `{{1}}` = the 6-digit code
- Sample: `905114`

**3. `safelock_password_reset`** — category **AUTHENTICATION**, language `en`

- Body: `{{1}} is your verification code. For your security, do not share this code.`
- Button: **Copy code** (code expiry **15 minutes**)
- Parameters: `{{1}}` = the **8-digit** reset code
- Sample: `40318725`

> **If you already submitted the earlier parameterless version of this
> template, withdraw or resubmit it.** It was deliberately empty of any
> credential, which made it safe and useless — there was nothing in the
> message the user could act on, so reset did not work in production. It now
> carries an 8-digit code: dead in 15 minutes, single-use, worthless without
> the account identifier, and bounded by five attempts. That is a credential a
> forwardable message can carry; a 32-byte token was not. See
> docs/decisions.md.

**4. `safelock_unlock_alert`** — category **UTILITY**, language `en`

- Body: `Your Safe Lock safe {{1}} was just unlocked. If this wasn't you, lock it from the app and contact support.`
- Parameters: `{{1}}` = the safe's serial number
- Sample: `SAFE-0001`

**5. `safelock_failed_attempts`** — category **UTILITY**, language `en`

- Body: `Five incorrect unlock codes were entered for your Safe Lock safe {{1}}. The code has been cancelled. If this wasn't you, contact support.`
- Parameters: `{{1}}` = the safe's serial number
- Sample: `SAFE-0001`

---

If Meta approves a template under a different name, set the matching
`WHATSAPP_TEMPLATE_*` variable — nothing in the code assumes a name.

### The five rental templates to submit to Meta

All **UTILITY**, language `en`, and every body is purely informational. That is
deliberate: a body that urges an upsell risks Meta reclassifying the template
as MARKETING, which users can mute — and a muted overstay notice is a fee
nobody was told about. No body starts or ends with a variable, which Meta
rejects.

> **Two of these depend on your production domain**:
> `safelock_booking_ending_soon` and `safelock_overstay_started` carry a
> dynamic URL button whose **base is fixed in the approved template**. Decide
> the host before submitting them, and set the same value in `PUBLIC_WEB_URL`.
> The other three have no button and can be submitted now.

---

**6. `safelock_booking_confirmed`** — category **UTILITY**, language `en`

- Body: `Your Safe Lock booking is confirmed. Safe {{1}} is yours until {{2}}. You can extend or collect from your dashboard.`
- Parameters: `{{1}}` = serial number, `{{2}}` = local end time
- Sample: `SAFE-0001`, `17 Oct 2026, 9:30 pm`
- No button.

Sent at activation **and again after an extension** — the same sentence is
exactly what an extension needs, which is why there is no separate
"booking extended" template.

---

**7. `safelock_booking_ending_soon`** — category **UTILITY**, language `en`

- Body: `Your Safe Lock booking for safe {{1}} ends at {{2}}. Please collect your items before then.`
- Button: **Visit website**, dynamic URL, base `https://<your-host>/bookings/`, suffix `{{1}}`
- Button label: `Manage booking`
- Parameters: body `SAFE-0001`, `9:30 pm`; button `clx123abc/extend`
- Sent twice per booking: 30 minutes and 10 minutes before the end.

---

**8. `safelock_overstay_started`** — category **UTILITY**, language `en`

- Body: `Your Safe Lock booking for safe {{1}} has ended and an overstay fee has started. The fee is {{2}} per hour and the safe will not open until it is paid. Locking still works.`
- Button: **Visit website**, dynamic URL, base `https://<your-host>/bookings/`, suffix `{{1}}`
- Button label: `Manage booking`
- Parameters: body `SAFE-0001`, `₹150`; button `clx123abc/extend`
- Sent one minute after the grace period ends — see `docs/decisions.md` for why
  not at the boundary itself.

---

**9. `safelock_overstay_settled`** — category **UTILITY**, language `en`

- Body: `We received your overstay payment of {{1}} for safe {{2}}. Please collect your items by {{3}}.`
- Parameters: `₹150`, `SAFE-0001`, `10:15 pm`
- No button.
- **Never sent for a waived fee.** A write-off worded as a receipt would be a
  lie about money, so a waived renter gets the collection reminder only.

---

**10. `safelock_collection_closing`** — category **UTILITY**, language `en`

- Body: `Your collection window for Safe Lock safe {{1}} closes at {{2}}. If it closes before you collect, the safe will be held for inspection and you will need to contact support.`
- Parameters: `SAFE-0001`, `10:15 pm`
- No button.
- Sent 10 minutes before the deadline, and not created at all when the
  collection window is shorter than that.

---

### What a rental sends, and when

| Message | Scheduled at | Due |
| --- | --- | --- |
| `safelock_booking_confirmed` | activation, and each extension | immediately |
| `safelock_booking_ending_soon` | activation, re-created on extension | `endsAt − 30m`, `endsAt − 10m` |
| `safelock_overstay_started` | activation, re-created on extension | `endsAt + grace + 60s` |
| `safelock_overstay_settled` | fee captured | immediately |
| `safelock_collection_closing` | fee captured or waived | `collectBy − 10m` |

Lead times live in `@safelock/shared`
(`BOOKING_REMINDER_LEAD_MINUTES`, `COLLECTION_REMINDER_LEAD_MINUTES`), not the
environment: they appear in the approved copy above *and* in UI text promising
them, and two copies of a promise drift.

Every scheduled message is **re-checked against the live booking immediately
before it is sent**, so one whose booking was collected, cancelled, extended or
settled in the meantime is dropped rather than sent. A message claimed more
than `REMINDER_MAX_LATENESS_MINUTES` (5) after its due time is dropped too — a
deadline reminder arriving after the deadline is not late, it is false.

### Watching reminders locally

Nothing to configure: `WHATSAPP_PROVIDER=fake` records sends in memory, and
`PUBLIC_WEB_URL` defaults to `http://localhost:3000`.

The poll worker runs only under `npm run dev:api` (never in tests). To see the
whole lifecycle without waiting hours, move a booking's clock with a direct row
edit and let the worker pick the messages up:

```bash
# Bring a booking's end time forward so its reminders are due now.
docker compose exec -T postgres psql -U safelock -d safelock -c \
  'UPDATE "Booking" SET "endsAt" = now() + interval ''9 minutes'' WHERE status = ''ACTIVE'';'

# The scheduled rows keep their original sendAt, so move those too.
docker compose exec -T postgres psql -U safelock -d safelock -c \
  'UPDATE "OutboundMessage" SET "sendAt" = now(), "nextAttemptAt" = now() WHERE status = ''PENDING'' AND "bookingId" IS NOT NULL;'
```

Then read what happened:

```bash
docker compose exec -T postgres psql -U safelock -d safelock -c \
  'SELECT kind, status, "failureCategory", "sendAt", "sentAt" FROM "OutboundMessage" WHERE "bookingId" IS NOT NULL ORDER BY "sendAt" DESC LIMIT 20;'
```

`SKIPPED` with `CANCELLED` means a state change withdrew it; with
`NOT_APPLICABLE` that re-validation refused it at send time; with `STALE` that
it was claimed too late; with `CAP_REACHED` that the booking send budget was
spent. The last two are counted on the admin Bookings row and flag it as
needing attention — a dropped overstay notice must not be silent.

### Phone verification

Every account starts **unverified** and must verify before it can unlock; there
is no grandfathering. Locking is never gated — it needs no code, and an
unverified user must still be able to secure their safe.

```
POST /api/v1/account/phone/request-verification  { phone, consent, currentPassword? }
POST /api/v1/account/phone/confirm               { otp }
```

### Password reset

```
POST /api/v1/auth/password/forgot   { identifier }                     -> { status: 'ok' }
POST /api/v1/auth/password/reset    { identifier, code, password }     -> { status: 'ok' }
```

`identifier` is an email **or** a 10-digit mobile. An **8-digit code** is sent
on WhatsApp to the account's verified number: 15 minutes, 5 attempts, single
use, and a new request replaces it. Codes are printed to the API console in
development:

```
  [dev] Password reset code: 40318725  (expires 2026-10-17T12:15:00.000Z)
```

Two properties to be careful about if you change this flow:

- **`/forgot` must answer byte-identically for every input** — registered
  email, unknown email, registered phone, unknown phone, a user with no
  verified number, a user whose daily cap is spent. Anything else is an
  account-enumeration oracle on an unauthenticated endpoint. The minimum
  interval between codes is a limiter limb evaluated *before* any lookup for
  the same reason.
- **The attempt counter is load-bearing.** An 8-digit code is only safe because
  five guesses is five guesses, so the increment and the limit check are one
  conditional update, and nothing compares the code before spending an attempt
  (the correct code also fails once they are gone).

`currentPassword` is required only when the account already has a verified
number: moving the number that receives unlock codes is a credential change.
The old number keeps working until the new one is confirmed.

A request for a number that belongs to another account answers **identically**
to a success and sends nothing — saying "that number is taken" would let anyone
test whether a given mobile has an account, and therefore probably a safe. The
response carries the masked number (`+91 98****10`) so an honest typo is still
visible.

### Send caps

There are **two** budgets, per user per rolling 24 hours, and a message's kind
decides which it draws on.

`WHATSAPP_DAILY_SEND_CAP` (default 10) covers everything a user's own action
produces: verification codes, password resets, unlock alerts and
failed-attempt alerts. Unlock codes are exempt: a messaging quota must never
lock an owner out of their own safe.

`WHATSAPP_BOOKING_SEND_CAP` (default 20) covers the five rental lifecycle
messages. Separate so a chatty rental — repeated extensions — cannot spend the
allowance a verification code needs. It counts only messages actually *sent*,
so reminders cancelled and re-created by an extension cost nothing. A booking
message dropped by this cap is recorded `SKIPPED`/`CAP_REACHED` and counted on
the admin Bookings row rather than disappearing. Verification answers `429 WHATSAPP_SEND_CAP_REACHED` with a
retry time; `/auth/password/forgot` stays byte-identical and silently skips the
send, because any observable difference there would be an account-enumeration
oracle.

### Inspecting the outbox

```bash
docker compose exec -T postgres psql -U safelock -d safelock -c \
  'SELECT kind, status, attempts, "failureCategory", "deliveryStatus" FROM "OutboundMessage" ORDER BY "createdAt" DESC LIMIT 20;'
```

`SKIPPED` means we chose not to send (no verified number, no consent, cap
spent) — not a failure, and never retried. The table holds no message text and
no template parameters, so no one-time code can reach it.

## Tests

The API suite runs against the real `safelock_test` database (truncated between
tests). The Razorpay SDK is mocked so nothing touches the network, but every
HMAC signature in the tests is computed for real.

```bash
npm --workspace apps/api test
```

Covered: payment verify/webhook and idempotency, refresh rotation, reuse
detection (including that a post-window replay kills grace siblings), the
10-second grace window, cookie `Path` attributes, the Origin allowlist, both
rate-limit limbs and 429 response parity, `/health` degraded, and seed
idempotency.

**Booking coverage** — the rental model's rules, each tested as the rule rather
than as a code path:

- **The exclusion constraint, against Postgres directly.** These tests bypass
  the service and insert rows, because the claim is about the database: if the
  constraint were dropped by a future migration, every service-level test would
  still pass and only these would fail. Overlap rejected, unpaid holds counted
  as occupying, `[)` bounds letting back-to-back rentals through, terminal rows
  leaving the constraint, and one-live-booking-per-user across devices.
- **The clock starts at payment**, so a booking created an hour before it is
  paid for still gets its full duration.
- **Collect during an unpaid overstay** is refused *and* the safe stays
  reserved — asserted by having the next renter try to book it and be refused.
- **Late payment, both branches**: safe still free → re-activated with a fresh
  clock; safe taken → payment stays `PAID`, flagged, on the admin refund queue,
  and the second renter keeps their booking.
- **The overstay quote TTL**: growth inside the window absorbed; an expired
  quote whose fee outgrew it refused, flagged, and leaving the fee outstanding
  so unlock and collect are still refused; an expired quote that still covers
  the fee honoured.
- **A code outlives nothing**: an OTP requested while `ACTIVE` then confirmed
  after collection, after an overstay begins, or after a force-complete all
  fail, and the bolt does not move.
- **The sweeper never completes an unpaid overstay**, across repeated passes,
  however long it has run — and only `COLLECTED` returns a safe to the pool.

Device and admin coverage: retire preconditions, clear-inspection requiring a
note, a flagged safe staying out of the booking pool until cleared, the
`flagged` work queue, waive-not-revenue, bulk per-row reporting and serial
normalisation, cross-user isolation, `requireAdmin` on **every** admin route
(table-driven, so an unprotected new route shows up as a missing entry), a
SQL-injection-shaped search term treated as literal text, and a recursive scan
asserting no hash, token or credential field appears in any admin response.

**Concurrency is tested against real Postgres**, not a mock — the constraints
are the behaviour under test, and a mock cannot have them.

### The HTTP verification script

```bash
npm run dev:api                      # in another terminal
npm --workspace apps/api run db:seed # needs an ADMIN account
bash scripts/verify-rental-http.sh
```

164 checks over real HTTP against a running server: signup, quote, hold,
activation by webhook, the clock starting at payment, overstay accrual, the
unlock/lock asymmetry, collect refused while a fee is owed, an expired quote
flagged rather than settled, collect, re-booking, the admin overrides, the
removed endpoints, CSRF, the sweeper — and the whole reminder lifecycle:
what activation schedules and at exactly what times, the extension block on
`GET /bookings/:id`, a forwarded link to someone else's booking answering a
plain not-found, an extension cancelling and re-creating its deadline
messages with non-colliding keys, re-validation refusing a message whose
booking moved on, a late one dropped as `STALE`, a settled fee queueing one
receipt even when the capture is delivered twice, and a dropped message
surfacing on the admin row.

The reminder section drives the real poll worker and moves the clock with
direct row edits, so it covers the parts no unit test can: the worker's own
timing, and the ordering between a booking changing and a message coming due.
**It reuses the sessions the earlier steps established** — signup and login
share a per-IP limiter of 10 per 15 minutes, and two more accounts would 429
and fail every assertion below for an unrelated reason. If you see a wall of
`UNAUTHENTICATED`, that is the limiter: restart the API (the counters are in
process memory) and run it again.

It is **not** a replacement for the test suite — it shares a database with your
dev environment and resets the device table to one safe. It exists because it
found a sweeper defect the suite could not: see `docs/decisions.md`.

Two things it cannot cover, both stated in the script:

- **Razorpay order creation**, if your `.env` has placeholder keys. The script
  asserts the clean 502 and then seeds the `Payment` row the order endpoint
  would have written, so everything downstream runs for real. With live test
  keys those steps return 200 instead.
- **The browser.** Every page is checked to compile and serve, but nothing
  clicks through the UI. Mock mode (`NEXT_PUBLIC_USE_MOCK_API=true`) is the
  place to do that by hand.

Rate limiters are **not** disabled in tests. The shared `app()` helper builds a
fresh app per request (so limiter counters reset and unrelated tests don't
exhaust each other's quota); a test that exercises a limit holds one app
instance across its requests.

## Security notes

- Passwords: argon2id. Login returns one generic error for both "no such
  account" and "wrong password", and spends comparable time on each so response
  timing cannot be used to enumerate accounts.
- Sessions: httpOnly cookies, never readable from JS. Refresh tokens are opaque,
  stored hashed, rotated on every use, and revocable.
- Rate limiting on login/signup has two limbs — per IP and per **hashed**
  identifier — and the 429 is identical whether or not the account exists.
- The browser is never trusted about a payment — only a server-verified
  signature or a signed webhook can set `PAID`.
- `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are never logged, never
  stored in the database, and never sent to a client. pino redacts by path
  *and* by a regex over key names (secret / signature / token / password / hash
  / cookie / authorization), at any depth.
- Secrets live only in `.env` files, which are gitignored. `.env.example` holds
  placeholders. All dependencies are pinned to exact versions.

### Known accepted risk

`npm audit` reports advisories in **dev-only toolchain** dependencies
(`braces` via `eslint-config-next`; `deepmerge-ts` and `mysql2` via the
`prisma` CLI — `mysql2` is dead code here, the project uses Postgres), plus
four `postcss` advisories under `next`.

The `postcss` ones are **accepted, not fixed**: no patched `next` 15.x exists
(every 15.x through 15.5.28 pins `postcss 8.4.31`; the fix needs `> 8.5.22`,
shipped only in `next@16`). All four require processing *untrusted* CSS, and all
CSS here is first-party and processed at build time. No runtime dependency of
`apps/api` is affected. Do not run `npm audit fix --force` — it would downgrade
`prisma` and `eslint-config-next` across majors. See `docs/decisions.md`.

## Legal pages

`/terms`, `/privacy`, `/refund-policy` and `/contact` exist because Razorpay's
activation review requires them, and are linked from the footer on every page.

**They are placeholders.** Every `[BRACKETED]` value must be filled in and the
whole set reviewed by a lawyer before launch. The refund policy is deliberately
non-committal — the refund terms have not been decided; the open questions are
listed on the page and in `docs/decisions.md`.
