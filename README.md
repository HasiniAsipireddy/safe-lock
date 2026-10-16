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

Also built: the **`/history` activity feed** and **in-app unlock
notifications** (a header bell with an unread count).

**Not built yet:** real hardware (the gateway is a mock that always acks),
phone verification, and **OTP delivery** — codes are printed to the API
console in development and are *not* sent anywhere in production. Pick a
channel before launch; see `docs/decisions.md`. Notifications are in-app only;
WhatsApp plugs into the existing `Notifier` seam.

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
| `POST` | `/api/v1/devices/lock` | cookie | Lock the safe. Idempotent — an already-locked safe is a 200. |
| `POST` | `/api/v1/devices/unlock/request` | cookie | Send a one-time code. Returns no code. |
| `POST` | `/api/v1/devices/unlock/confirm` | cookie | `{ otp }`; only this opens the safe. |
| `GET` | `/api/v1/devices/history` | cookie | The caller's activity, newest first. `?cursor=&limit=` (max 50). |
| `GET` | `/api/v1/notifications` | cookie | Unread first, plus the total unread count. `?limit=` |
| `POST` | `/api/v1/notifications/read` | cookie | `{ ids? }` — mark read. Idempotent; omit `ids` for all. |
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

`/devices/history` and the notification routes carry **`requireAuth` only** —
no payment or allocation gate. They serve the caller's own record, so a user
awaiting allocation and a refunded user both get an empty list rather than an
error. The lock/unlock routes are the opposite: they go through
`assertCanOperate`, which requires a settled payment *and* an assigned device.

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
`/history` reads) **and** an `AuditLog` row. Failed code attempts are written
to both as well — a run of them against one account is worth seeing, and the
event carries a `failureReason` from a fixed enum. Neither ever contains the
code.

### Activity and notifications

**`/history`** shows every lock and unlock on the caller's safe, grouped by
local day, newest first, with a **Load more** button (cursor-paginated — see
`docs/decisions.md` for why not an offset). Reachable from the nav and the
dashboard, and readable by any signed-in user including one with no safe yet.

An **unlock writes a `Notification` in the same transaction as the event**, so
there is no unlock the owner was not told about and no notification about an
unlock that rolled back. The header **bell** shows the unread count and polls
every 60 seconds while the tab is visible (pausing when hidden, refetching
immediately on return). Opening it marks the loaded notifications read.

Only two things notify: a **confirmed unlock**, and an unlock attempt that
**burns all 5 code attempts** — a possible tampering signal. A single mistyped
digit does not, and neither does locking. Adding WhatsApp (step 4) means a new
implementation of `Notifier` and no change to the unlock service.

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

### The five templates to submit to Meta

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
> safe's serial is **not** in this message. The API passes
> `[code, serialNumber]`; if your approved template accepts only one
> parameter, drop the second from `deliverOtp` in
> `apps/api/src/modules/devices/otp.service.ts` — it is the one line that
> decides this.

**2. `safelock_phone_verification`** — category **AUTHENTICATION**, language `en`

- Body: `{{1}} is your verification code. For your security, do not share this code.`
- Button: **Copy code** (code expiry 5 minutes)
- Parameters: `{{1}}` = the 6-digit code
- Sample: `905114`

**3. `safelock_password_reset`** — category **AUTHENTICATION**, language `en`

- Body: `{{1}} is your verification code. For your security, do not share this code.`
- Parameters: **none** — the API sends an empty parameter list
- Sample: n/a

> This template deliberately carries **no token and no link** (see
> docs/decisions.md). A chat message is persistent, forwardable and
> cloud-backed-up; a reset token is an account takeover in one string. If the
> authentication layout forces a code parameter, submit this one as
> `UTILITY` instead with the body:
> `A password reset was requested for your Safe Lock account. If this wasn't you, your password still works and no action is needed.`

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

### Phone verification

Every account starts **unverified** and must verify before it can unlock; there
is no grandfathering. Locking is never gated — it needs no code, and an
unverified user must still be able to secure their safe.

```
POST /api/v1/account/phone/request-verification  { phone, consent, currentPassword? }
POST /api/v1/account/phone/confirm               { otp }
```

`currentPassword` is required only when the account already has a verified
number: moving the number that receives unlock codes is a credential change.
The old number keeps working until the new one is confirmed.

A request for a number that belongs to another account answers **identically**
to a success and sends nothing — saying "that number is taken" would let anyone
test whether a given mobile has an account, and therefore probably a safe. The
response carries the masked number (`+91 98****10`) so an honest typo is still
visible.

### Send caps

`WHATSAPP_DAILY_SEND_CAP` (default 10) messages per user per rolling 24 hours.
Unlock codes are exempt: a messaging quota must never lock an owner out of
their own safe. Verification answers `429 WHATSAPP_SEND_CAP_REACHED` with a
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
