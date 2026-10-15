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
Razorpay payment flow, and the legal pages. Device allocation, lock/unlock, OTP
and phone verification are **not** built yet.

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
# Then: generate real JWT secrets and paste in your Razorpay test keys.
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
| `GET` | `/api/v1/auth/me` | access cookie | Current user, including `hasPaid` |
| `POST` | `/api/v1/payments/order` | cookie | Create a Razorpay order at the server price. `409` if already paid. |
| `POST` | `/api/v1/payments/verify` | cookie | Verify the Checkout signature and mark `PAID`. Idempotent. |
| `POST` | `/api/v1/payments/webhook` | HMAC | Razorpay's callback. Raw body, signature-verified, deduped by event id. |
| `GET` | `/api/v1/payments/me` | cookie | `hasPaid` plus the latest payment summary and the current price. |

`requirePaid` (`apps/api/src/middleware/requirePaid.ts`) returns `402` for a
user without a verified payment. It is exported and tested, ready for the
device and lock/unlock routes.

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
