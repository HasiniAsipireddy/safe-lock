# Safe Lock

A mobile-first web platform for locking and unlocking a physical smart safe
remotely. See [`CLAUDE.md`](./CLAUDE.md) for the architecture and
[`docs/decisions.md`](./docs/decisions.md) for why things are the way they are.

```
apps/web        Next.js frontend (App Router, Tailwind)
apps/api        Express + Prisma backend, REST under /api/v1
packages/shared Types, zod schemas and constants used by both
```

**Built so far:** auth (signup / login / rotating sessions), the one-time
Razorpay payment flow, the legal pages, device inventory + manual allocation
with an admin panel, and **remote lock / unlock with a one-time code** against
a mock device.

**Not built yet:** real hardware (the gateway is a mock that always acks), the
`/history` page, phone verification, and **OTP delivery** — codes are printed
to the API console in development and are *not* sent anywhere in production.
Pick a channel before launch; see `docs/decisions.md`.

---

## Prerequisites

- **Node 22 LTS** (`.nvmrc`). Newer versions work but print an `EBADENGINE`
  warning — see `docs/decisions.md`.
- **Docker** — the dev database runs in a container.
- npm 10+ (this repo uses npm workspaces, not pnpm).

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
mode: `/pay` shows a **Simulate payment** button instead of Razorpay Checkout.

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
browser, as part of the `POST /payments/order` response.

### 2. Set the price

```
SAFE_PRICE_PAISE=99900    # paise, so 99900 = ₹999
```

The price is read from this variable on every order. The client never sends an
amount, and a request body that tries to is rejected.

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
2. You land on `/pay`. It shows the price from the API.
3. Click **Pay now** → Razorpay Checkout opens with your name, email and phone
   prefilled.
4. Pay with a test card. Checkout calls back, the browser posts to
   `/payments/verify`, and the server checks the HMAC signature before marking
   the payment `PAID`.
5. Separately, Razorpay delivers `payment.captured` to your webhook. **The
   webhook is the source of truth** — if you close the tab before step 4, the
   webhook still activates the account.
6. `/dashboard` drops the "Complete payment" banner.

To test a refund: find the payment in the Dashboard, issue a refund, and watch
`refund.processed` arrive. The payment flips to `REFUNDED` and the account
stops counting as paid.

### Checking what happened

```bash
npm --workspace apps/api run prisma:studio
```

`Payment` holds the order and its status, `WebhookEvent` is the idempotency
ledger (one row per delivered event id), and `AuditLog` records every order,
verification, signature failure and webhook.

---

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | none | `SELECT 1`; 200 ok / 503 degraded |
| `POST` | `/api/v1/auth/signup` | none | Create an account, start a session |
| `POST` | `/api/v1/auth/login` | none | Email-or-phone + password |
| `POST` | `/api/v1/auth/refresh` | refresh cookie | Rotate the session |
| `POST` | `/api/v1/auth/logout` | optional | Revoke the refresh token, clear cookies |
| `GET` | `/api/v1/auth/me` | access cookie | Current user, incl. `hasPaid` and `deviceAllocated` |
| `GET` | `/api/v1/devices/mine` | cookie + paid | The caller's device, or `null` while awaiting allocation |
| `GET` | `/api/v1/admin/devices` | ADMIN | Inventory, with `status`, `q`, `page` |
| `POST` | `/api/v1/admin/devices` · `/devices/bulk` | ADMIN | Add one, or up to 500 with per-row results |
| `POST` | `/api/v1/admin/devices/:id/allocate` · `/allocate-next` | ADMIN | Allocate a specific or the next device |
| `POST` | `/api/v1/admin/devices/:id/unassign` · `/retire` | ADMIN | Return to stock, or take out of service |
| `GET` | `/api/v1/admin/users` · `/payments` · `/audit` | ADMIN | Paginated admin listings |
| `POST` | `/api/v1/payments/order` | cookie | Create a Razorpay order at the server price. `409` if already paid. |
| `POST` | `/api/v1/payments/verify` | cookie | Verify the Checkout signature and mark `PAID`. Idempotent. |
| `POST` | `/api/v1/payments/webhook` | HMAC | Razorpay's callback. Raw body, signature-verified, deduped by event id. |
| `GET` | `/api/v1/payments/me` | cookie | `hasPaid` plus the latest payment summary and the current price. |

`requirePaid` (`apps/api/src/middleware/requirePaid.ts`) returns `402` for a
user without a verified payment; `requireAdmin` returns `403` for non-admins
and is applied to the whole `/admin` router.

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

### Allocating a safe

A user who has paid shows up under **Admin → Users** as *Awaiting allocation*;
that filter is the work queue. Click **Allocate** and choose:

- **Next available** — takes the oldest device in stock. The right default: it
  uses a row lock, so two admins allocating at the same moment get different
  devices rather than colliding.
- **A specific device** — when the physical unit in hand must match the record.

The user's dashboard switches from the waiting timeline to their safe card on
their next load. Allocation requires a `PAID` payment; an attempt for an unpaid
user is refused with `402 NOT_PAID` and the failure is audited.

### Unassigning and retiring

- **Unassign** returns a device to stock and revokes the user's access. Its
  lock state resets to `UNKNOWN` — the state of a safe nobody owns is not
  something we know.
- **Retire** takes a device permanently out of service. It is **refused while
  the device is assigned** (`DEVICE_STILL_ASSIGNED`): unassign first, so
  hardware is never retired out of someone's hands.

Both ask for confirmation.

## Locking and unlocking

Once a safe is allocated, its owner gets working controls on `/dashboard`.

**Lock** is one tap plus a confirmation. It is idempotent — locking an
already-locked safe is a success that sends no command, not a 409.

**Unlock** always costs a one-time code:

1. Tap **Unlock**. The API creates a challenge and generates a 6-digit code.
2. In development the code is **printed to the API terminal**:
   ```
   [dev] Unlock code for SAFE-0001: 418290  (expires 2026-10-16T05:12:44.901Z)
   ```
   In mock mode (no backend) it is shown in an amber panel in the dialog
   instead. In production nothing is sent yet — pick a delivery channel first.
3. Type or paste it. 5 minutes, single use, 5 wrong attempts before the
   challenge dies. Requesting a new code kills the old one.

Both routes refuse anyone who is not entitled, with a code the UI can act on:

| Code | Status | Meaning |
| --- | --- | --- |
| `NOT_PAID` | 402 | No settled payment. Paying fixes it. |
| `REFUNDED_CONTACT_SUPPORT` | 403 | Refunded but still holding the safe. Paying does **not** fix it. |
| `NO_DEVICE` | 409 | Paid, waiting for an admin to allocate. |
| `DEVICE_STATE_UNKNOWN` | 409 | The safe is not reporting a state. Should be unreachable. |
| `OTP_INVALID` / `OTP_EXPIRED` / `OTP_TOO_MANY_ATTEMPTS` / `OTP_NOT_FOUND` | 400 | Code problems. |

Every state change writes a `DeviceEvent` (the owner's activity feed, which
`/history` will read) **and** an `AuditLog` row. Failed code attempts are
written to both as well — a run of them against one account is worth seeing.
Neither ever contains the code.

The device layer behind all of this is one interface, `DeviceGateway`, with a
mock implementation that always acks after a short delay. Swapping in the real
MQTT gateway touches no route. See `docs/decisions.md`.

### Refunded users who still hold a safe

A refund sets `hasPaid` false but **does not** reclaim the device — that stays
a human decision. Those users appear at the top of **Admin → Users**,
highlighted and labelled *"Refunded — device still assigned"*, with
**Unassign** on the row. Their dashboard shows an explicit "payment was
refunded, contact support" state with no safe card and no controls.

### Audit

**Admin → Audit** lists every security-relevant action, newest first,
filterable by action name (try `device.`). Both successes and failures are
recorded; failures carry the error code, and every row carries the
`requestId` that ties it to the server log lines.

## Tests

The API suite runs against the real `safelock_test` database (truncated between
tests). The Razorpay SDK is mocked so nothing touches the network, but every
HMAC signature in the tests is computed for real.

```bash
npm --workspace apps/api test
```

Covered: payment order/verify/webhook and idempotency, `requirePaid`, refresh
rotation, reuse detection (including that a post-window replay kills grace
siblings), the 10-second grace window, cookie `Path` attributes, the Origin
allowlist, both rate-limit limbs and 429 response parity, `/health` degraded,
and seed idempotency.

Device and admin coverage: allocation preconditions, next-available ordering,
`NO_DEVICES_IN_STOCK`, unassign/retire rules, bulk per-row reporting and serial
normalisation, cross-user device isolation, `requireAdmin` on **every** admin
route (table-driven, so an unprotected new route shows up as a missing entry),
a SQL-injection-shaped search term treated as literal text, and a recursive
scan asserting no hash, token or credential field appears in any admin
response.

**Concurrency is tested against real Postgres**, not a mock — the row locking
is the behaviour under test. Ten simultaneous allocations land on ten distinct
devices; one device and two users yields exactly one winner and one clean
`NO_DEVICES_IN_STOCK`; two simultaneous allocations for one user yield exactly
one device.

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
