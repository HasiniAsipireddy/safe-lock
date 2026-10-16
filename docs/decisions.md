# Decisions

A running log of choices made while building the Safe Lock platform. Newest last.

---

## 2026-10-12 — Package manager: npm workspaces, not pnpm

**Decision:** The monorepo uses **npm workspaces**. `pnpm` is not used.

**Why:** The development machine has Node 25 and npm 11 but neither `pnpm` nor
`corepack` installed, and the user chose not to install pnpm. npm workspaces
gives the same `apps/*` + `packages/*` layout with no extra tooling.

**Consequence:** The command table in `CLAUDE.md` uses npm equivalents
(`npm install`, `npm run dev`, `npm --workspace apps/api …`). If the team later
standardises on pnpm, replace the lockfile and update `CLAUDE.md` again.

---

## 2026-10-12 — Target Node 22 LTS

**Decision:** The project targets **Node 22 LTS**. Recorded in root
`package.json` `engines` (`">=22 <23"`) and in `.nvmrc` (`22`).

**Why:** The machine currently runs **Node 25, which is a non-LTS (Current)
release** — it gets no long-term support window and is not a safe baseline for
a physical-security product that will run unattended in production. Node 22 is
the active LTS line.

**Consequence:** `npm install` prints an `EBADENGINE` warning under Node 25.
That warning is expected until the local runtime is switched (`nvm use 22` /
`fnm use 22`). `engines-strict` is deliberately **not** set, so Node 25 can
still be used for local UI work without blocking installs.

---

## 2026-10-12 — Login identifier is a single email-or-phone field

**Decision:** `/login` takes one `identifier` field accepting either an email
address or a 10-digit Indian mobile number, rather than two separate fields or
a toggle. `classifyIdentifier()` in `@safelock/shared` tells the API which
column to look up.

**Why:** Fewer taps on mobile, and the user does not have to remember which
credential they signed up with.

**Consequence:** The API's login handler must branch on the identifier type and
must return the **same** generic error for an unknown identifier and a wrong
password (`GENERIC_LOGIN_ERROR`), so the endpoint cannot be used to enumerate
registered accounts.

---

## 2026-10-12 — Zod schemas live in `packages/shared`

**Decision:** All auth validation schemas (`loginSchema`, `signupSchema`,
`emailSchema`, `phoneSchema`, `passwordSchema`) live in
`packages/shared/src/schemas/auth.ts` and are imported by the web app today and
the Express API later. The package is consumed as raw TypeScript via
`transpilePackages`, so there is no build step.

**Why:** One definition of "valid", enforced on both sides. Client-side
validation is UX only; the API must re-run the same schema.

**Consequence:** `acceptedTerms` is modelled as `z.boolean().refine(v => v)`
rather than `z.literal(true)` so a form can start unchecked. `acceptedTerms`
and `confirmPassword` are client-only and are **not** sent to the API.

---

## 2026-10-12 — Mock API mode for frontend-first development

**Decision:** `NEXT_PUBLIC_USE_MOCK_API=true` routes auth calls to an
in-browser fake (`apps/web/src/lib/mockApi.ts`) with ~650ms of simulated
latency and one seeded demo account (`demo@example.com` / `Demo1234`).

**Why:** The login/signup UI is being built before the API exists.

**Guard rails:**
- `apps/web/src/lib/env.ts` **throws at startup** if `NODE_ENV === 'production'`
  and mock mode is on, so a production build cannot ship the fake backend.
- An amber **"Mock mode"** badge sits at the top of every page while it is on.
  (It was sticky until 2026-10-16, when it turned out to park itself over the
  `/history` sticky day headings — see the polish note at the end of this file.)
- Mock accounts live in module memory only; nothing created by signup survives a
  full page reload. The mock "session" is a user id in `sessionStorage` — it is
  not a token and grants nothing.

**Consequence:** When the real API lands, set `NEXT_PUBLIC_USE_MOCK_API=false`
and point `NEXT_PUBLIC_API_URL` at it. No component changes required.

---

## 2026-10-12 — No tokens in web storage

**Decision:** The web app never reads or writes auth tokens. The session is an
httpOnly cookie set by the API; the client sends `credentials: 'include'` and
learns who the user is from `GET /auth/me`.

**Why:** A token readable from JavaScript is a token stealable by any XSS on the
page. For a product that physically opens a safe, that is unacceptable.

**Consequence:** Route guards in `RouteGuard.tsx` are **UX only** — they cannot
inspect the cookie. Real access control is the API rejecting unauthorised
requests. Passwords are held only in react-hook-form state for the duration of
a submit and are never logged, persisted, or copied.

---

## 2026-10-15 — Dev database runs in Docker on host port 5433

**Decision:** PostgreSQL 16 runs in a container (`docker-compose.yml`), bound to
host port **5433**, with user `safelock` and a dev-only password. A named volume
holds the data; `docker/postgres/init-test-db.sh` creates `safelock_test` on
first start.

**Why:** The development machine already runs a PostgreSQL 16 **service** on the
default 5432. Binding 5433 means the project cannot collide with it, and the
existing local install is never touched.

**Consequence:** `DATABASE_URL` and `TEST_DATABASE_URL` both point at 5433.
`npm run db:reset` (`docker compose down -v`) wipes the volume, which is also
the only way to re-run the init script. The init script must keep **LF** line
endings — `.gitattributes` enforces this, because bash inside the container
cannot execute a CRLF script.

---

## 2026-10-15 — Prisma 7 with the pg driver adapter

**Decision:** `prisma` and `@prisma/client` are pinned to **7.10.0**, connected
through `@prisma/adapter-pg`. The Migrate connection URL lives in
`apps/api/prisma.config.ts`, not in `schema.prisma`.

**Why:** Prisma 7 removed `datasource.url` from the schema and requires a driver
adapter. (Note the npm `latest` tag for the `prisma` CLI currently points at an
`8.0.0-rc`; 7.10.0 is the current stable pair and is pinned deliberately.)

**Consequence:** The runtime connection string is chosen in code
(`src/lib/prisma.ts` → `databaseUrl()`), which is how `NODE_ENV=test`
transparently targets `TEST_DATABASE_URL`. `prisma.config.ts` also honours
`PRISMA_DATABASE_URL`, which the vitest global setup uses to run
`prisma migrate deploy` against the test database only.

---

## 2026-10-15 — The API is run with tsx, not pre-compiled with tsc

**Decision:** `apps/api` has no `build` step. Both `dev` and `start` run the
TypeScript sources through **tsx**.

**Why:** `@safelock/shared` is consumed as raw TypeScript with extensionless
relative imports (decision of 2026-10-12). Pre-compiling the API with `tsc`
would mean either giving the shared package a build step and `dist` exports, or
switching the whole repo to `.js`-suffixed ESM imports. Neither is worth it for
a service that starts in well under a second under tsx.

**Consequence:** `tsc --noEmit` is typechecking only. If the API ever needs a
compiled artefact (a slim container image, say), the shared package gets a build
step at the same time.

---

## 2026-10-15 — Activation price: provisionally ₹999, server-side only

**Decision:** `SAFE_PRICE_PAISE=99900` (₹999), one-time, no subscription. The
price is read from server config on **every** order. The client never sends an
amount, and `POST /payments/order` uses a `.strict()` empty-object schema so a
body carrying `{ amount: 100 }` is rejected with a 400 rather than silently
ignored.

**Why:** The figure came from the task brief and is **not confirmed by the
business** — it is a placeholder that is easy to change. The architecture around
it is not: letting a client influence the amount is the classic way to get
charged ₹1 for a ₹999 product.

**Consequence:** `CLAUDE.md` still lists price/plan as an open question
(including whether GST is included). Changing the price is an env change and
needs no deploy of new code. Existing `CREATED` orders are never reused — a new
order is always created — so a price change cannot be paid at the old amount.

---

## 2026-10-15 — The webhook is the source of truth for payment state

**Decision:** `POST /payments/verify` (the browser callback) and
`POST /payments/webhook` (Razorpay's server callback) can **both** move a
payment to `PAID`, and the webhook does not depend on verify ever being called.
Both paths require a valid HMAC signature; neither trusts any client claim.

**Why:** The browser is unreliable — the user can close the tab the instant the
payment succeeds, lose connectivity, or never run the success handler. Razorpay
retries the webhook until it gets a 2xx, so it is the only delivery channel that
can be relied on. Verify exists purely so the UI can confirm immediately
instead of polling.

**Consequence / implementation notes:**
- Idempotency is structural, not conditional. Verify checks the signature on
  *every* call and then applies the transition inside a transaction that no-ops
  when the row is already settled — so there is no "skip the signature check"
  branch.
- The webhook records `eventId` in `WebhookEvent` **inside the same transaction**
  that applies the change. If applying throws, the ledger row rolls back too, so
  Razorpay's retry gets a clean attempt rather than being deduped into a no-op.
- A bad signature returns **400** (Razorpay stops retrying); a genuine
  processing failure returns **500** (Razorpay redelivers).
- A failed signature check never marks a row `FAILED`. Anyone who learned an
  order id could otherwise poison a legitimate payment in progress.
- `payment.failed` only moves a row that is still `CREATED`, so a late failure
  cannot undo a capture. `refund.processed` sets `REFUNDED`, and a replayed
  callback cannot resurrect it to `PAID`.
- A capture for **less** than the order amount is logged and refused rather than
  settled. The order amount is set server-side so this should be impossible,
  which is exactly why it must fail loudly if it ever happens.
- The Razorpay signature is verified and then **discarded** — it is never stored.
  Keeping it buys nothing and widens what a database leak exposes.

---

## 2026-10-15 — `hasPaid` is derived, never stored

**Decision:** `PublicUser.hasPaid` is computed from the `Payment` table on every
request (`userHasPaid()`), not cached as a column on `User`.

**Why:** One copy of the truth. A refund flips a payment to `REFUNDED` and
access is withdrawn on the next request with no second field to remember to
update, and no drift to debug later.

**Consequence:** One extra indexed query per `/auth/me`. If that ever matters,
cache it — but only with an invalidation path the webhook drives.

---

## 2026-10-15 — `requirePaid` returns 402, and is built before it is used

**Decision:** `apps/api/src/middleware/requirePaid.ts` refuses unpaid users with
**402 Payment Required** and `code: PAYMENT_REQUIRED`. It is exported and
covered by tests even though no route uses it yet.

**Why:** 403 means "you may never do this"; this user can fix it by paying, and
the frontend should be able to tell the two apart without string-matching a
message. Writing and testing it now means the device, lock/unlock and OTP routes
can simply mount it rather than re-deriving the rule.

**Consequence:** Mounted without `requireAuth` it fails closed with a 500 and a
log line naming the misconfiguration, rather than quietly letting the request
through. A test pins that behaviour.

---

## 2026-10-15 — Phone verification postponed, with marked seams

**Decision:** WhatsApp/SMS phone verification is **not** built. No
`phoneVerifiedAt` column, no `requireVerifiedPhone` middleware, and no such
check on the payment routes.

**Why:** Explicitly deferred. A half-built check is worse than none: a middleware
reading a column that is never populated either blocks everybody or is quietly
disabled, and both become load-bearing by accident.

**Consequence:** The two insertion points are marked `TODO(phone-verification)`
in `apps/api/src/modules/payments/payments.routes.ts` (on `/order` and
`/verify`, between `requireAuth` and the rate limiter) and in
`prisma/schema.prisma` on the `User` model.

---

## 2026-10-15 — Legal pages are published placeholders, and the refund policy is deliberately empty

**Decision:** `/terms`, `/privacy`, `/refund-policy` and `/contact` ship as
static Server Components linked from a site-wide footer. Every one carries a
"draft, not legal advice, lawyer must review" banner, and every business-specific
value is a `[BRACKETED]` placeholder. The refund policy makes **no refund
promise at all** — it lists the 11 decisions required instead.

**Why:** Razorpay's activation review requires these pages to exist and be
reachable. That is a reason to publish pages, not a reason to invent legal
terms. A refund commitment nobody has agreed to is a liability, and
auto-generated indemnity or liability wording is worse than a visible gap.

**Consequence:** These pages are **not launch-ready**. Before going live:
fill in every placeholder, settle the refund decisions (record them here), and
have a lawyer review all four. The pages are intentionally static — no contact
form, so there is no endpoint to abuse and no message data to store.

---

## 2026-10-15 — Payment flow works in mock mode

**Decision:** `NEXT_PUBLIC_USE_MOCK_API=true` now also fakes
`GET /payments/me`, `POST /payments/order` and `POST /payments/verify`. On
`/pay`, mock mode renders a "Mock checkout" panel with **Simulate payment**,
**Simulate failure** and **Close without paying** instead of loading
`checkout.js`.

**Why:** The UI can then be exercised end to end — including the dismissed-popup,
failure and already-paid branches — without Razorpay keys, and without anyone
being tempted to put test keys in the frontend.

**Consequence:** The mock verify endpoint accepts one hardcoded fake signature
(`MOCK_CHECKOUT_SIGNATURE`, 64 zeros) and rejects anything else, so the request
shape matches the real flow. It is not an HMAC and could never pass the server's
`timingSafeEqual` check. Mock mode is still refused in production builds by
`apps/web/src/lib/env.ts`.

---

## 2026-10-16 — Refresh tokens are opaque and rotated, not JWTs

**Decision:** Refresh tokens are 32 random bytes (`crypto.randomBytes`,
base64url), stored only as `sha256(token)` in a `RefreshToken` table. Every
redemption rotates: the presented token is revoked and a successor is issued in
the same `familyId`, linked by `replacedById`. Lifetime 7 days (was 30). Access
tokens stay 15-minute signed JWTs.

**Why:** A JWT is valid until it expires — there is no way to revoke one. A
7-day un-revocable credential for a product that physically opens a safe is not
acceptable: logout could not end a session, and a leaked token could not be
cut off. Storing only the hash means a database leak yields nothing usable.
`JWT_REFRESH_SECRET` is now unused and optional; it is kept in the schema only
so a rollback still has its secret to hand.

**Consequence:** Refreshing costs a database round trip (it did not before).
Logout now revokes server-side, so a token copied off the wire dies with it.
`scripts/cleanupRefreshTokens.ts` (`npm --workspace apps/api run
db:cleanup-tokens`) deletes expired rows and rows revoked more than 30 days
ago. Revoked rows are **deliberately retained** for that window: they are what
makes reuse detection possible, and deleting one immediately would turn a
replayed stolen token into an indistinguishable "unknown token" 401.

---

## 2026-10-16 — The grace window mints a sibling, and what that costs

**Decision:** Replaying an already-rotated refresh token within
`REFRESH_GRACE_WINDOW_MS` (10 seconds) is not treated as theft. Instead it
mints **one** sibling token in the same family. Outside the window — or on a
second grace attempt for the same token — the whole family and every other
refresh token for that user is revoked and `REFRESH_REUSE_DETECTED` is audited.

**Why a sibling rather than re-issuing the successor:** two tabs refreshing at
once both present the same token; the loser must still end up with a working
session. The obvious fix — hand back the successor that was just issued — is
impossible by construction: the successor's raw value exists only in the
winning tab's cookie, and we store only its SHA-256. Re-emitting it would mean
keeping a raw token at rest for 10 seconds, which is exactly the property the
hashed-at-rest design exists to avoid. A sibling achieves the same observable
outcome with no plaintext anywhere.

**The tradeoff we are accepting:** for 10 seconds after a legitimate rotation, a
*stolen* copy of the old token can also mint one sibling and so obtain a
session. This is bounded in three ways:
1. **One use only.** `graceUsedAt` is claimed atomically, so a rotated token can
   mint at most one sibling ever. A second attempt is reuse and kills the family.
2. **Audited.** Every grace use writes `REFRESH_GRACE_USED` with `userId`, `ip`
   and `userAgent`, so an unusual pattern (grace uses from a different IP than
   the rotation) is visible after the fact.
3. **Disableable.** `REFRESH_GRACE_WINDOW_MS` is a constant in
   `refreshToken.service.ts`. **Set it to 0** and the grace window is off
   entirely: any replay of a revoked token immediately revokes the family. The
   cost of doing so is that a genuine two-tab race logs the user out.

**Also decided:** the grace window applies **only to tokens revoked by
rotation** — those with a `replacedById`. A token revoked by logout, or by the
cascade from a previous reuse detection, is never forgiven. (This was caught by
a test: without the distinction, replaying a token within 10 seconds of logging
out still produced a working session, which defeats the point of logging out.)

**Family revocation covers siblings**, since they share the `familyId` — there
is a test asserting a post-window replay kills the siblings too.

---

## 2026-10-16 — Cookies are same-site only; the mobile app will need bearer tokens

**Decision:** The access cookie is scoped to `path=/`; the refresh cookie to
`path=/api/v1/auth`. Both are `httpOnly`, `sameSite=lax`, and `secure` in
production.

**Why the refresh cookie is path-scoped:** a browser only sends a cookie to
paths at or below its `Path`. The long-lived refresh token therefore never
reaches `/api/v1/payments/*`, `/api/v1/devices/*` or any future admin route —
those handlers cannot leak or misuse a credential they never receive, and the
token crosses the wire a few times a day instead of on every request.

**Production deployment constraint — important:** `sameSite=lax` cookies are
**not sent across unrelated registrable domains**. The web app and the API must
therefore be served **same-site**, e.g. `app.example.com` and
`api.example.com` (same `example.com`), or the API behind a path on the web
origin. `safelock-web.vercel.app` + `safelock-api.onrender.com` **will not
work** — the session cookie simply will not be attached, and every request will
look unauthenticated.

**Consequence for the mobile app (roadmap item 7):** a React Native or Flutter
client has no cookie jar tied to a site, and `sameSite` has no meaning there.
Reusing `/api/v1` from mobile will need a **bearer-token flow** — the same
rotation and reuse-detection logic, but returning the refresh token in the
response body for the app to hold in the platform keychain, with
`Authorization: Bearer` on requests. That is an additive change to the auth
module, not a rewrite: `refreshToken.service.ts` already has no cookie
knowledge. It must *not* be added to the web app, where a token readable by
JavaScript is a token stealable by any XSS.

**Note:** `clearCookie` only matches a cookie whose `Path` is identical, so the
refresh cookie must be cleared with its scoped path. Clearing it at `/`
silently leaves it in the browser.

---

## 2026-10-16 — Exact-match Origin allowlist on state-changing requests

**Decision:** `originCheck` middleware runs on POST/PUT/PATCH/DELETE. An
`Origin` header that is present must match `WEB_ORIGIN` (comma-separated list)
by **exact string equality**. A *missing* `Origin` is rejected only when auth
cookies are present. The Razorpay webhook is exempt. `cors()` reads the same
variable. `CORS_ORIGINS` is kept as a legacy alias.

**Why:** `sameSite=lax` blocks most cross-site POSTs, but "most" is not a
security boundary for something that opens a safe. Matching must never be a
prefix or regex test — a prefix match on `https://app.example.com` would also
accept `https://app.example.com.attacker.test`, which is a domain an attacker
can register. There is a test for exactly that string.

**Why missing-Origin is conditional:** a cookie-less caller (curl,
server-to-server) cannot be a CSRF victim, because it has no ambient
credentials to abuse. Rejecting it outright would break legitimate API clients
for no security gain. Cookies + no Origin is the dangerous combination, and
that is what gets the 403.

**Consequence:** every state-changing request from the test suite now sets an
`Origin`, as a real browser would. Rejections are audited as
`security.origin.rejected`; the rejected origin is logged server-side and never
echoed back to the caller.

---

## 2026-10-16 — Rate limiting: two limbs, hashed identifiers, no test skip

**Decision:** `/auth/login` and `/auth/signup` carry two limiters: per IP
(10/15min) and per identifier (5/15min), the latter keyed on
`sha256(lowercased email-or-phone)`. Limiters are built by a factory that takes
limits and an optional store. They are **no longer skipped under
`NODE_ENV=test`**.

**Why two limbs:** the per-IP limit cannot see a distributed attack on one
account (many addresses, one target); the per-identifier limit cannot see
credential stuffing across many accounts from one address. Each limb covers the
other's blind spot.

**Why the identifier is hashed:** the key lives in the limiter's store, and in
Redis later. A plaintext email there is a list of registered users sitting
outside the database.

**Why no test skip:** a limiter disabled in the only environment that could
test it is a limiter nobody has ever seen work. Tests now build an app with
small limits and assert the 429 — including that the 429 is **identical for an
existing and a non-existent account**, so the endpoint cannot become an
account-enumeration oracle.

**Consequence:** limiter counters live in per-app memory, so the shared test
`app()` helper (a fresh app per request) resets them — which is what keeps
unrelated tests from exhausting each other's quota. A test that wants to
*exercise* a limit must hold one app instance across its requests; that is
documented in `rateLimit.test.ts`. `TRUST_PROXY` is off by default: trusting
`X-Forwarded-For` with no proxy in front lets any client spoof its IP and walk
past every per-IP limit. The `TODO(scale)` about a Redis store still stands.

---

## 2026-10-16 — pino, with the regex redaction kept as a formatter

**Decision:** Logging moved from the hand-rolled logger to **pino**. The
previous regex key-redaction is kept, implemented as pino's `formatters.log`
hook, *in addition to* `redact` paths for `password`, `authorization`,
`cookie`, `set-cookie` and the obvious body fields.

**Why both layers:** the path list is exact and fast but only covers what
someone remembered to list. The regex backstop catches anything whose *key name*
looks sensitive at any depth — so new code can log a `{ razorpaySignature }`
field without a reviewer having to extend a list. Neither layer is a licence to
pass secrets to the logger; they exist so a mistake is redacted rather than
published.

**Request IDs:** a `requestId` middleware honours an incoming `X-Request-Id`
only if it matches `[A-Za-z0-9._-]{1,64}`, otherwise it generates a UUID. The
header is attacker-controlled and ends up in log lines and a response header,
so an unvalidated value could inject newlines into the log stream (forging
entries). A bad trace header is replaced, not rejected — it should not fail a
user's request. The id appears in every log line, in the `error.requestId` of
every error response, and in the `X-Request-Id` response header (CORS-exposed).

**Consequence:** pino's call signature is `log(obj, msg)`, the opposite order
from the old logger — all call sites were updated. Log level is `error` in
tests rather than silent, so an unexpected 500 stays diagnosable. Request
bodies are never logged on auth routes.

---

## 2026-10-16 — /health checks the database; shutdown is bounded

**Decision:** `GET /api/v1/health` runs `SELECT 1` with a 2-second timeout and
returns `200 {status:"ok"}` or `503 {status:"degraded"}`, with no internal
detail in either body. Shutdown guards against re-entry, closes idle keep-alive
connections, force-closes the rest at 8 seconds, exits hard at 10, and handles
`unhandledRejection` / `uncaughtException` by logging and exiting 1.

**Why the timeout:** without it, a health check against a wedged connection
pool hangs rather than reporting degraded, and a load balancer keeps routing
traffic to a broken instance. `checkDatabase()` never throws — it returns a
boolean, so the route cannot 500 and be misread as "app is broken" when the
answer is "database is unreachable".

**Why idle connections must be closed explicitly:** `server.close()` waits for
every socket, and a browser keep-alive socket sitting idle between requests
holds it open indefinitely. Without `closeIdleConnections()` graceful shutdown
reliably hits the force-exit timeout instead.

**Why exit on an unhandled rejection:** the process is in an unknown state, and
for a service that authorises opening a safe, "unknown state" is not something
to keep serving traffic from.

**Verification note:** Windows cannot deliver a real SIGTERM to a child
process (`Stop-Process` is a hard kill), so the shutdown path was verified by
emitting the signal in-process. It completed in 3ms with exit code 0, and a
second signal was correctly ignored by the re-entry guard.

---

## 2026-10-16 — ADMIN seeding is explicit, env-driven and refuses weak passwords

**Decision:** `prisma/seed.ts` creates or updates an ADMIN from
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` and
`SEED_ADMIN_PHONE`. No default and no hardcoded fallback password. It refuses a
password under 12 characters, and refuses to run at all when
`NODE_ENV=production` unless `SEED_ALLOW_PRODUCTION=true`. Idempotent: a re-run
updates the row, rotates the password hash and re-asserts the ADMIN role.

**Why:** a seeded admin with a known password is a backdoor into every safe in
the fleet, and the one credential nobody remembers to change. The production
guard exists because seeding by accident against production creates a
privileged account whose password is sitting in someone's shell history.

**Consequence:** the ADMIN role was previously unreachable outside tests — there
was no way to create one without hand-writing SQL and an argon2 hash. This
unblocks the admin endpoints in roadmap item 3. Run with
`npm --workspace apps/api run db:seed`.

---

## 2026-10-16 — Exact dependency pinning

**Decision:** `.npmrc` sets `save-exact=true`, and every dependency in
`apps/api` is pinned to an exact version — no carets. `zod` is pinned to the
same exact version (4.6.7) in all three workspaces.

**Why:** this is a physical-security product. A silent patch bump in `argon2`,
`jsonwebtoken`, `express` or the Postgres driver is a change to the security
surface that nobody reviewed. `package-lock.json` already made installs
reproducible; pinning the manifest makes an upgrade a deliberate, reviewable
commit.

**Why zod had to be aligned across workspaces:** pinning the API to `4.1.12`
while web and shared floated on `^4.1.12` (resolving to 4.6.7) made npm install
a *second*, nested copy. Two zod instances produce schema types that are
structurally identical but mutually unassignable, and `validateBody(schema)`
stopped typechecking with a wall of inference errors. One exact version
everywhere, one hoisted copy.

---

## 2026-10-16 — next/postcss advisories accepted as build-time-only risk

**Decision:** `next` stays on 15.5.4. The four `postcss` advisories reported
under it are **accepted, not fixed**.

**Why:** there is no patched 15.x. Every `next` 15.x release through the newest
(15.5.28) pins `postcss 8.4.31`; the advisories require `postcss > 8.5.22`, and
only `next@16.4.1` ships `8.5.23`. Upgrading to 16 is a major version bump that
was explicitly out of scope for a hardening pass, and `npm audit fix --force`
was not run.

**Risk assessment:** all four advisories (XSS via unescaped `</style>`, and
three path-traversal / arbitrary `.map` file-read variants via attacker-
controlled `sourceMappingURL`) require **processing untrusted CSS**. All CSS in
this project is first-party and processed at build time on a trusted machine.
The running API and the served pages do not expose a code path that feeds
attacker-controlled CSS to postcss.

**Revisit when:** a patched 15.x appears, or the project is ready for a
deliberate `next` 16 upgrade with a full build-and-test pass. The remaining
advisories (`braces` via `eslint-config-next`, `deepmerge-ts` and `mysql2` via
the `prisma` CLI) are all dev-only toolchain dependencies; `mysql2` in
particular is dead code here, since the project uses Postgres.

---

## 2026-10-16 — Manual admin allocation first, behind one service function

**Decision:** After payment a user is "waiting for allocation". An ADMIN
allocates a physical safe by hand through `/admin`. All of it goes through a
single function, `allocateDevice(userId, deviceId?)` in
`apps/api/src/modules/devices/device.service.ts`.

**Why manual first:** the hardware is physical. Someone has to put a specific
unit in a box, and the record must match what was actually shipped. Automating
that before anyone has shipped one would be automating a process that does not
exist yet.

**Why one function:** auto-allocation is the obvious next step — the payment
webhook calling the same code on `payment.captured`. Keeping one entry point
means the paid / one-per-user / availability rules cannot drift between the
manual and automatic paths. The webhook can call it without re-deriving a
single rule.

**Consequence:** `CLAUDE.md`'s open question "auto-allocation vs manual" is
answered for now as *manual, with the seam for automatic already in place*.
The function takes an optional `deviceId`: omit it for "next available", pass
it when the unit in hand must match.

---

## 2026-10-16 — One device per user, enforced by a unique constraint

**Decision:** `Device.ownerId` is `UNIQUE`. A user owns at most one device.

**Why a constraint rather than a service check:** the service checks too, but a
check is a read followed by a write, and two concurrent allocations can both
pass the read. The unique index is the only thing that makes "one device per
user" true under concurrency. The service translates the resulting violation
back into `ALREADY_HAS_DEVICE` so the client sees a clean 409 rather than a
database error. There is a test that fires two simultaneous allocations for one
user and asserts exactly one wins.

**Consequence:** this matches the payment rule, which already refuses a second
order once a user has a `PAID` payment — so "number of safes per user" is
answered as **one** throughout. Supporting several safes per user later means
dropping the unique index, giving `Device` a plain `ownerId` index, and
revisiting both this and the payment rule together.

---

## 2026-10-16 — Allocation picks with FOR UPDATE SKIP LOCKED

**Decision:** "Next available device" is chosen with a raw
`SELECT id … WHERE status = 'UNASSIGNED' ORDER BY "createdAt" ASC LIMIT 1 FOR
UPDATE SKIP LOCKED` inside the allocation transaction. This is the **only** raw
query in the codebase.

**Why:** two admins clicking Allocate at the same moment is an ordinary event.
Without row locking both transactions read the same "oldest unassigned" row and
one fails — or worse, with a weaker check, both succeed. `FOR UPDATE` locks the
candidate row; `SKIP LOCKED` makes the second transaction step over it and take
the *next* one instead of blocking. Both admins succeed, with different
devices.

**Why raw SQL:** Prisma has no row-locking API. The query interpolates nothing
— there is no caller input in it — and every other query in the project,
including all admin search, uses Prisma's parameterised filters.

**Consequence:** verified by tests against real Postgres rather than a mock,
because the locking is the behaviour under test: ten simultaneous allocations
land on ten distinct devices; one device and two users yields exactly one
winner and one clean `NO_DEVICES_IN_STOCK`. A `@@index([status, createdAt])`
supports the pick.

---

## 2026-10-16 — Serial number format is provisional, and normalised before storage

**Decision:** Serials match `^SAFE-[0-9A-Z]{4,12}$` (e.g. `SAFE-0001`), defined
once as `SERIAL_NUMBER_REGEX` in `packages/shared/src/schemas/devices.ts`. Input
is **trimmed and uppercased before validation and storage**.

**Why normalise:** `safe-0001`, `SAFE-0001` and `" SAFE-0001 "` are one physical
safe. Without normalisation a bulk paste from a spreadsheet creates duplicate
inventory rows for the same unit, and the duplicate check silently misses them.
Normalising first makes the uniqueness constraint mean what it should.

**PROVISIONAL — needs confirming:** the format was chosen as a placeholder, not
from a manufacturer's scheme. Before hardware is ordered, confirm what the
units are actually stamped with, and whether the serial is also the identity the
device presents over MQTT. Changing it later means a migration plus re-labelling
anything already in stock. One regex in one file is the only thing to edit.

**Consequence:** bulk import is capped at **500 rows** per request and reports
every row as created / duplicate / invalid, so one bad line does not reject the
paste. Duplicates are caught both within the submitted list and against the
inventory.

---

## 2026-10-16 — A refund does not automatically reclaim the device

**Decision:** When a payment is refunded, `hasPaid` becomes false but the
device stays `ASSIGNED`. The Users tab flags the row as
**"Refunded — device still assigned"** with Unassign reachable from the row. No
webhook revokes hardware automatically.

**Why:** the money and the hardware are separate facts. A refund may be a
dispute, a goodwill gesture, or a mistake, and silently stripping someone's
safe — possibly while their valuables are inside — is not a decision code
should make. The refund policy is still undecided (see the open questions), so
the conservative behaviour is to surface the state and let a human act.

**Consequence — the state is reachable and must be handled everywhere:**
`hasPaid: false` with `deviceAllocated: true` is a real combination.
- The dashboard checks it **first**, before the not-paid branch, and shows an
  explicit "Your payment was refunded — please contact support about returning
  your safe" state with **no safe card and no controls**.
- `/devices/mine` sits behind `requirePaid`, so it already refuses with 402;
  the dashboard relies on `deviceAllocated` from `/auth/me` for this state
  rather than on that endpoint.
- **Lock/unlock, when built, must require BOTH a paid user AND an assigned
  device.** Neither condition implies the other: a refunded user can hold
  hardware, and a paid user may be waiting for allocation. `requirePaid` alone
  is not sufficient, and an ownership check alone is not either.

---

## 2026-10-16 — Admin exposure is an explicit allow-list

**Decision:** Every admin query uses an explicit Prisma `select`. The admin user
row is exactly: `id`, `name`, `email`, `phone`, `role`, `createdAt`, `hasPaid`,
`deviceSerial`, and the derived `refundedWithDevice` flag. Nothing else.

**Why:** admin tooling is precisely where a convenient `include: { user: true }`
starts shipping password hashes to a browser. With `select`, a column added to
the schema later — a device credential, say — cannot leak into a response
because nobody remembered to exclude it. `Device.credentialHash` exists in the
schema already, reserved for the hardware phase, and appears in no select list.

**Consequence:** a test walks every admin response recursively and fails on any
key matching `passwordHash|tokenHash|credentialHash|refreshToken|secret|
signature`, or any value that looks like an argon2 hash, with sentinel values
planted in the database to prove the scan would catch them.

**Audit metadata follows the same rule from the other direction:** the audit
service drops any metadata key matching `email|phone|password|secret|token|
hash`. People are identified by `userId`; look the rest up when an
investigation needs it, rather than spreading personal data into a long-lived,
widely-readable table. Failed admin actions are audited too, with the error
code — a run of `NOT_PAID` attempts against one account is a pattern worth
being able to see.

---

## 2026-10-16 — Admin list search is parameterised only

**Decision:** The `q` parameter on every admin list goes through Prisma's
`contains` filters, capped at 100 characters by the query schema. No admin
query builds SQL from a string.

**Why:** the one raw query in the project (the SKIP LOCKED pick) takes no input
at all. Keeping search parameterised means the entire attack surface for
injection is a query with no parameters in it. A test sends
`'; DROP TABLE "Device"; --` as a search term and asserts it is treated as
literal text and the table survives.

**Consequence:** a new `validateQuery` middleware coerces and bounds every list
query, so handlers receive a `page` that is a number and a `q` within the cap
rather than raw strings. Express 5 exposes `req.query` as a getter, so it is
redefined rather than assigned.

---

## 2026-10-16 — OTP: 6 digits, 5 minutes, 5 attempts, one live code at a time

**Decision:** An unlock code is 6 digits from `crypto.randomInt`, valid for 5
minutes, single-use, with 5 wrong attempts before the challenge is invalidated
outright. Requesting a new code **consumes any older open challenge** for that
user and device, so at most one code is live at any moment. The parameters live
in `packages/shared/src/schemas/devices.ts`, not in the API.

**Why one live code matters more than the other three numbers:** leaving the
previous code valid turns "5 attempts per challenge" into "5 attempts per
*request*", and the request endpoint is the one a user can trigger repeatedly.
The attempt limit would then be decorative. The rate limits (3 codes / 10 min
per user, 10 per IP) are the second half of the same rule.

**Why the numbers are what they are:** 6 digits and 5 minutes come from
CLAUDE.md's OTP rules and match what people expect from a bank. 5 attempts is
generous enough for a mistyped digit and still leaves a guesser a 5-in-10^6
chance per challenge.

**Consequence:** a burned challenge is a 400 with `OTP_TOO_MANY_ATTEMPTS`, not
a 429 — the client already reads 429 as "the rate limiter, back off and retry",
and a dead challenge is not retryable. All four OTP failures
(`OTP_INVALID`, `OTP_EXPIRED`, `OTP_TOO_MANY_ATTEMPTS`, `OTP_NOT_FOUND`) are
400s carrying distinct codes; the UI switches on the code, not the status.

---

## 2026-10-16 — OTPs are stored as a keyed HMAC, not a slow hash

**Decision:** `UnlockChallenge.otpHash` is `HMAC-SHA256(code, OTP_HMAC_SECRET)`.
Not bcrypt, not argon2, not a bare SHA-256. `OTP_HMAC_SECRET` is a new
**required** environment variable (32+ chars) and the API refuses to boot
without it.

**Why not a slow hash:** a 6-digit code has 10^6 possible values. Someone
holding a database dump can enumerate all of them against bcrypt too — it costs
them minutes instead of milliseconds, which is not a security boundary for a
credential that is valid for five of them. What actually makes the stored digest
useless is a key that is **not in the database**. That is what an HMAC gives and
a password hash does not.

**Why a separate secret from `JWT_ACCESS_SECRET`:** they protect different
things with different lifetimes. Sharing one means rotating it invalidates every
session and every outstanding code at once, and makes a leak of either twice as
expensive.

**Consequence:** comparison is `timingSafeEqual` over the two *hashes*, so both
sides are a fixed length — the function cannot throw on a length mismatch, and
the comparison leaks nothing about how many leading digits were right. A
malformed stored hash returns false rather than a 500. Tests assert the digest
is not a bare `sha256('123456')`, which would mean the secret was not in play.

---

## 2026-10-16 — What is logged, and what the OTP never touches

**Decision:** The plaintext code leaves `otp.service.ts` exactly twice: to the
notifier, and — outside production — to `console.log`. It is never in a response
body, an audit row, a `DeviceEvent`, or a pino log line.

**The production guard is `mayPrintOtp(nodeEnv)`**, a pure function exported so
it can be tested directly. It returns true only for `development` and `test`.
Anything else — `production`, a typo, an unset `NODE_ENV` — is false: the
default must be silence, not printing a working unlock code into whatever
collects stdout. In production with no delivery channel configured the service
logs a warning and sends nothing, which is the correct failure mode.

**Why `console.log` rather than the logger:** pino output is shipped to log
storage, and a code that reaches log storage has outlived its five minutes. The
dev line is for a developer watching their own terminal. It is the only
`console` call in the API and carries a narrow eslint-disable saying so.

**What the audit trail holds instead:** `device.unlock.otp_failed` records a
`reason` from a fixed enum (`wrong_code`, `expired`, `attempts_exhausted`,
`no_challenge`) and the error code. Nothing the user typed and nothing derived
from it. The audit service's existing key filter already drops anything matching
`otp|hash|token|secret`, so a future careless metadata key is caught too.

**Consequence:** tests read the code back off the dev console line rather than
reaching into the service, which means they exercise the real delivery path —
and a test fails loudly if that print is ever removed. A separate test asserts
the code appears in no response, no audit row, no event and no device column.

---

## 2026-10-16 — `DeviceGateway`, and why it takes no user

**Decision:** The hardware seam is `DeviceGateway` (`sendLock`, `sendUnlock`) in
`apps/api/src/lib/deviceGateway/`, with `MockDeviceGateway` today and an MQTT
implementation later, selected by the `DEVICE_GATEWAY` env enum. This supersedes
the `DeviceDriver` / `sendCommand(deviceId, type)` sketch in CLAUDE.md, which
has been updated to match.

**Why two methods rather than one `sendCommand(type)`:** the two are not
interchangeable. Unlocking has a precondition — a verified OTP — that locking
does not, and a single parameterised method invites a caller to pass a variable
where the OTP check has already been skipped. Two methods make the asymmetry
visible at every call site.

**Why the interface takes a serial number and nothing else:** no user id, no
payment state, no request object. Authorisation is settled before anything
reaches a gateway. A transport that could see who is asking is a transport that
could be made to decide, and that decision belongs in one place.

**The mock always acks** rather than failing randomly. A flaky mock makes every
test flaky; the failure path is better exercised by a test that stubs the
gateway than by a coin flip in production code.

---

## 2026-10-16 — The `Command` table and the 15s timeout are deferred to MQTT

**Decision:** CLAUDE.md's `Command` model (`PENDING` / `SENT` / `ACKED` /
`FAILED` / `TIMEOUT`) is **deliberately not built**. `DeviceEvent` records what
happened; there is no row representing a command in flight.

**Why:** the mock gateway acks synchronously, in-process. There is nothing
asynchronous to track and nothing that can time out, so a `Command` table today
would be a column of rows that are `ACKED` the microsecond they are created —
a schema that looks load-bearing and is not. A half-built state machine is worse
than none: the first real MQTT ack would have to be retrofitted into whatever
shape we guessed at here.

**What this defers, explicitly:** command ids and nonces for replay protection,
the 15-second timeout and its `TIMEOUT` state, and "device not responding" in
the UI. All of them are properties of a transport that can lose a message, which
the mock cannot.

**Consequence:** the lock/unlock service calls the gateway **inside** the
database transaction, while holding the device row lock. That is correct and
simple for an in-process mock. It is **not** acceptable over MQTT — a row lock
held across a radio round trip will serialise the fleet — so the MQTT work must
move to a claim-then-ack model, which is exactly what `Command` is for. The
comment on `lockDevice()` says so at the call site.

---

## 2026-10-16 — `online` is mock-only, and not an eligibility gate

**Decision:** `Device.online` and `lastSeenAt` are set to `true` / now whenever
the mock gateway acks. Being offline does **not** block a lock or unlock
command.

**Why:** the mock is always reachable, so an offline check today would be
unreachable code — a gate that has never once refused anything, which is the
kind of code that quietly stops working. The honest version is to let the
command fail at the transport and report that.

**Revisit with real hardware.** Then `online` becomes a real signal with a
heartbeat behind it, and there are genuine decisions to make: refuse a command
to a safe that has not been seen for an hour, or send it and let it time out?
Show the last known state with its age, or refuse to state one? Those are
answerable once there is a device that can actually go quiet.

---

## 2026-10-16 — An allocated device is never `UNKNOWN`

**Decision:** `Device.lockState` defaults to `LOCKED`, allocation re-asserts
`LOCKED`, and unassigning sets `UNKNOWN`. `UNKNOWN` stays in the enum.

**Why keep `UNKNOWN` at all:** a safe nobody owns genuinely has an unknown
state — it is in transit, in a cupboard, or in someone's hands, and nothing is
watching it. Removing the value would force a lie. Real hardware will need it
too, for a device that has never reported in.

**Why an owned device must never be in it:** there is no sensible UI for it. The
dashboard cannot offer controls whose effect it cannot predict, so
`assertCanOperate` refuses with `DEVICE_STATE_UNKNOWN` and the card shows "state
unavailable" with both buttons disabled. That path should be unreachable; it
exists so that if it ever happens, the product says so rather than guessing.

**Consequence:** a backfill migration moves existing `ASSIGNED` rows from
`UNKNOWN` to `LOCKED`. Without it every user allocated before this change would
have found their new controls dead. `lockStateUpdatedAt` is deliberately left
null by allocation and unassign: it means "last state the hardware confirmed",
and neither of those is an ack.

---

## 2026-10-16 — The activity feed is cursor-paginated, not offset-paginated

**Decision:** `GET /devices/history` takes `?cursor=&limit=` and returns
`{ items, nextCursor }`. `nextCursor: null` means end of list. The cursor is
`base64url("<iso timestamp>|<event id>")`, ordering is
`(createdAt DESC, id DESC)`, and a `@@index([userId, createdAt, id])` covers
the scan. Default limit 20, maximum 50. The admin lists keep their existing
page/pageSize offset pagination.

**Why not offset, given the admin lists use it:** `DeviceEvent` is
append-only and the user is looking at the newest end of it. With
`skip`/`take`, an event arriving between two page requests shifts every older
row down one, so page 2 begins with a row page 1 already showed — a duplicate
in a security log, which is exactly where a reader must be able to trust what
they are counting. A keyset asks "what comes strictly after this position",
which is unaffected by inserts. The admin lists are filtered, roughly static
views where a page number is genuinely what an operator wants.

**Why `id` is in the sort key and in the cursor:** `createdAt` is not unique.
Two events can land in the same millisecond — a lock and its event, or several
`UNLOCK_FAILED`s from a script. Ordering by timestamp alone leaves their
relative order undefined, so a page boundary falling between them skips a row
or serves it twice. `(createdAt, id)` is a total order. Two tests pin this:
six events sharing one millisecond paged three at a time, and a tie split by a
boundary with distinct rows either side.

**The cursor is opaque, not a capability, and deliberately not signed.** Every
query is filtered by the session's `userId`, so the worst a hand-forged cursor
can do is move the window within the caller's own events — there is a test
that builds a cursor from another user's event and asserts nothing of theirs
comes back. Signing would protect nothing that is not already protected. It
must be signed the moment a cursor carries something the caller could not
derive.

**Validation is in two stages, because base64url decoding is lenient:**
`cursorSchema` checks length (200 max) and alphabet before anything is
decoded, so an oversized value is refused without allocating for it; the
service then validates the payload and answers 400 `INVALID_CURSOR`. The
timestamp is round-tripped through `toISOString()` and compared, which is what
rejects a value `Date` parses loosely — `new Date('2026-10-16')` succeeds, and
a bare "did it parse" check would accept it.

**Also decided: no eligibility gate on the feed.** `requireAuth` and nothing
more — no `requirePaid`, no ownership check. This is the user's own record: a
user awaiting allocation has no events and gets an empty list, and a refunded
user can still read what happened to the safe they are holding. Withholding it
would be withholding their own data, and an empty list is the honest answer
where an error would not be.

---

## 2026-10-16 — Notifications: an in-app table, and what is worth interrupting someone for

**Decision:** A `Notification` table (`id`, `userId`, `type`, `deviceEventId`,
`createdAt`, `readAt`) with its own `NotificationType` enum, written through a
`Notifier` interface. `GET /notifications` returns unread first then newest
first, plus the **total** unread count; `POST /notifications/read` marks rows
read and is idempotent.

**What triggers a notification — and what does not:**

| Event | Notifies | Why |
| --- | --- | --- |
| `UNLOCK_CONFIRMED` | **yes** | The safe opened. If it was not the owner, this is the one message that matters. |
| `UNLOCK_FAILED` with the attempt limit burned | **yes** | Five wrong codes against one challenge is either someone who no longer has the code, or someone guessing at a physical safe. |
| `UNLOCK_FAILED`, a single wrong or expired code | no | A mistyped digit is the most ordinary thing a legitimate owner does. |
| `UNLOCK_REQUESTED` | no | A code being sent is not the safe opening, and the user triggered it themselves. |
| `LOCK` | no | Locking is the safe state. |

The omissions are the decision. A notification per typo would train people to
ignore the bell, and the bell's only job is to still mean something on the day
it matters. Everything above is in `/history` regardless — the feed is the
complete record, notifications are the interruptions.

**Why a separate enum from `DeviceEventType`:** most device events notify
nobody, so a shared enum would carry values that are never legal here. A later
notification that is not about a device event (an allocation, say) would also
have to pose as one. `deviceEventId` is nullable for the same reason.

**Why the `Notifier` interface takes the transaction client:** the in-app
notification is written **inside** the transaction that records the
`UNLOCK_CONFIRMED` event, so neither can exist without the other. Three tests
pin it: a notifier that writes and then throws leaves no orphan row; a
notifier that cannot record at all rolls the unlock back entirely (the safe
stays locked and the code is not burned, so a retry works); and a failed
device command writes neither.

**That is a deliberate trade:** a notifier outage refuses to open the safe
rather than opening it silently. For a product that physically opens a safe,
"it opened and we never told you" is the worse of the two failures. The in-app
notifier is a single insert on the same connection, so the window for this is
very small.

**What this means for WhatsApp (step 4), without changing the unlock
service:** sending a message is not transactional and must not happen from
inside `notifyUnlock` — a rollback cannot unsend it, which would mean telling
someone their safe opened when it did not. Step 4's implementation writes an
**outbox row** through the same client and a worker sends it after the commit.
The interface already supports that; it is why the method takes a client
rather than just ids.

**No `NOTIFIER` env variable yet,** unlike `DEVICE_GATEWAY`. With one
implementation it would have exactly one legal value — configuration that
cannot be configured. It arrives in step 4 with the second implementation, and
probably as a composite (in-app *and* WhatsApp) rather than a choice between
them, which is a different shape from the gateway's enum and not worth
guessing at now.

**Mark-read ignores ids that are not the caller's** rather than answering 403
or 404. Either would confirm whether an id exists, which is an existence
oracle on another account's rows, and a legitimate client only ever sends back
ids it was given. Only `readAt: null` rows are touched, so a repeat call
reports `markedRead: 0` and does not move a timestamp that already records
when the user first saw it.

**Retention is an open question, and nothing deletes events today.** See
CLAUDE.md's open questions. `DeviceEvent` is the user-visible security record
of a physical safe, so a retention period is a policy decision rather than a
default to pick quietly.

---

## 2026-10-16 — `UNLOCK_FAILED` reasons are a column, not reconstructed from the audit log

**Decision:** `DeviceEvent.failureReason` is a nullable `UnlockFailureReason`
enum (`WRONG_CODE`, `EXPIRED`, `TOO_MANY_ATTEMPTS`, `NO_CHALLENGE`). Existing
`UNLOCK_FAILED` rows stay `null` and render as a generic "Unlock failed".
**There is no backfill.**

**Why not read it from `AuditLog`:** the reason was already being recorded
there, but `AuditLog` is the internal security trail — it holds IPs, user
agents and admin actions, and it is explicitly not what users see. Joining a
user-facing page onto it would put a table with that content one careless
`select` away from a response body. Two tables with two audiences is the
existing design; this follows it.

**Why no backfill:** the mapping would be a guess. An audit row and an event
row are correlated by `userId`, `deviceId` and a timestamp, not by a foreign
key, so matching them up would be heuristic — and a *wrong* reason on a
security event is worse than an absent one. "Unlock failed" with no detail is
honest about what is actually known.

**Consequence:** the enum values differ in spelling from the audit metadata
`reason` strings (`wrong_code`, …), which are already written and asserted by
tests. `STORED_REASON` in `deviceControl.service.ts` is the single place the
two are tied together, so a fifth reason cannot be added to one without the
compiler demanding the other.

---

## 2026-10-16 — Notification polling, not websockets, and it stops when nobody is looking

**Decision:** The web client polls `GET /notifications` every **60 seconds
while the tab is visible**. It stops on `visibilitychange` to hidden, and on
becoming visible again it fetches **immediately** rather than waiting out the
rest of an interval. No websockets, no server-sent events.

**Why:** a socket per signed-in tab is a connection to authenticate, keep
alive, reconnect and scale, for a payload that changes a few times a day. The
poll degrades to "the badge is up to a minute stale", which is an acceptable
property for a notification about something that already happened — the
authoritative record is `/history`, one click away.

**Why it must pause:** a background tab left open overnight would otherwise
make ~480 requests whose answer nobody can see. The immediate fetch on return
is the other half of the same point: the first thing a returning user sees
must be current, not up to a minute stale.

**Consequence:** a new `notifications` limiter (120 per 5 minutes per user),
sized to clear several visible tabs plus a fetch on every visibility change
and bell open. A failed poll keeps the last good data rather than blanking the
bell. If the staleness ever becomes a real complaint, the answer is a shorter
interval or a push channel for unlocks specifically — not a socket for a badge.

---

## 2026-10-16 — Polish: the mock badge gives up the sticky slot, and reduced motion is honoured

**Two small fixes, recorded because both were wrong in a way that only shows
up on one page or one OS setting.**

**The mock badge is no longer sticky.** It was `sticky top-0 z-50`; the
`/history` day headings are `sticky top-0 z-10`. Both claim the same position
and the badge wins on z-index, so scrolling the activity feed parked each day's
heading underneath an opaque amber bar — on the one page where knowing which
day you are looking at is the point. Raising the headings' z-index only inverts
the problem (the heading then covers the banner's text), and offsetting them
with `top-[height]` needs a height that changes when the banner wraps on a
narrow screen or expands to show the demo credentials. A dev-only banner has no
claim on the sticky slot: it now scrolls away with the rest of the page.

**`prefers-reduced-motion: reduce` is now honoured**, which it previously was
not at all. Transitions collapse to nothing; the loading spinner is **slowed to
1.5s rather than stopped**. Stopping it leaves a static arc that reads as a
broken page rather than a busy one, and the thing it reports — a command in
flight to a physical safe — is exactly when a user should not be guessing.
Every spinner already sits beside its own text and an `aria-busy` /
`role="status"`, so the information survives regardless; the exception just
keeps the visual affordance for people who can see it.

---

## 2026-10-16 — Reset tokens are a plain SHA-256, and the OTP is not

**Decision:** `PasswordResetToken.tokenHash` is `sha256(token)` — the same
construction as `RefreshToken`, with **no keyed HMAC and no new environment
variable**. `RESET_TOKEN_HMAC_SECRET` was considered and deliberately not
added.

**Why, and why the OTP differs:** an unkeyed hash is reversible exactly when
the input space is small enough to enumerate. A reset token is 32 bytes from
`crypto.randomBytes` — 2^256 possibilities, so someone holding a database dump
has a digest and no path back to the token. The unlock OTP is an HMAC under
`OTP_HMAC_SECRET` because a 6-digit code has **10^6** possibilities, which the
same attacker walks in milliseconds; there, the key living outside the database
is the only thing that makes the stored digest useless. Same table, same
threat, different answers, because the entropy is different by 70 orders of
magnitude.

A secret that protects nothing is not free: it is another required variable in
every deployment, another thing to rotate, and another way for the API to fail
to boot. The *structural* properties are what matter here and both are kept —
the raw token is never stored, never logged (`mayPrintResetToken` gates the dev
console print exactly like `mayPrintOtp`), never returned in a response body,
and never written to an audit row. Tests assert all four.

**Consequence:** nothing needs adding to `apps/api/.env` for password reset.

---

## 2026-10-16 — Reset does not sign anyone in; change-password revokes all and reissues

**Decision:** `POST /auth/password/reset` returns `{ status: 'ok' }` — no user,
no cookies — and the UI sends the visitor to `/login`. `POST
/auth/password/change` revokes **every** refresh token for the user and issues
the caller a fresh family in the same transaction, so they stay signed in on
the device they used and are signed out everywhere else.

**Why reset does not log in:** holding a reset link proves control of a
delivery channel, not that the holder is the account owner. A link can be
forwarded, sit in a shared browser's history, or be read on a screen someone
else can see. "You may set a password, now sign in with it" costs the
legitimate user one extra step and costs an opportunist the entire session.

**Why change-password reissues rather than just revoking:** changing a password
is how someone evicts a session they no longer trust, so revoking nothing makes
the feature cosmetic. But revoking everything *including the tab in front of
you* logs people out for doing the right thing, which teaches them not to do it
again. All three steps are one transaction — revoke and reissue separately
leaves a window where the caller holds no valid refresh token, and a parallel
request landing in that window is indistinguishable from a replay.

**A wrong current password is a 400 `PASSWORD_INCORRECT`, never a 401.** The
web client treats 401 as "session expired" and runs its shared
refresh-and-retry path; a 401 here would mean mistyping your own password
signed you out. The session is in fact perfectly valid — only the submitted
credential was wrong.

---

## 2026-10-16 — Access tokens stay un-revocable for up to 15 minutes

**Decision:** Password reset and change-password both revoke every *refresh*
token. Neither can invalidate an **access** token that has already been issued:
it is a stateless signed JWT, so another device's access token keeps working
until it expires — at most 15 minutes — it simply cannot be renewed. This
window is accepted and nothing new is built to close it.

**Two options were considered and not taken:**

1. **A `tokenVersion` column on `User`, checked on every request.** Bumping it
   on a password change would invalidate every outstanding access token
   immediately. The cost is that every authenticated request becomes a database
   read, which is precisely the property the stateless access token exists to
   avoid — and it would apply to all traffic, forever, to shorten a 15-minute
   window on a rare event.
2. **A revocation list (a denylist of jti claims) in memory or Redis.** Same
   per-request lookup, plus state to replicate and expire, plus a new failure
   mode: if the list is unreachable the service has to choose between refusing
   every request and trusting every token.

**Why 15 minutes is acceptable here:** the attacker this protects against
already had a live session. What a reset or a change takes away is their
*ability to keep it* — within a quarter of an hour they are locked out, with no
way back in, and the owner holds the only working password. Shrinking
`ACCESS_TOKEN_TTL` shrinks the window further and needs no new code if that
trade ever looks wrong.

**Revisit if** an "end all other sessions now" control is ever user-facing. A
button that promises immediate eviction and delivers it in up to 15 minutes is
a different thing from an invisible implementation detail, and that promise
would justify option 1.

---

## 2026-10-16 — A deliberate revocation is not a theft signal

**The bug, found by walking the flow against a running server rather than by a
test:** `POST /auth/password/change` revokes every refresh token and issues the
caller a new one. Moments later another device — a phone in a pocket, a
background tab polling `/notifications` every 60 seconds — presents its
now-revoked token to `/auth/refresh`. Reuse detection saw a revoked token with
no `replacedById`, correctly concluded "this was not a rotation", and ran
`revokeAllForUser`. That cascade revoked the **successor** too. Net effect:
you changed your password and were silently signed out of the device you
changed it on, seconds afterwards, with `REFRESH_REUSE_DETECTED` in the audit
log claiming theft that never happened.

**Decision:** `RefreshToken.revokedReason` records *why* a token was revoked
(`ROTATED`, `LOGOUT`, `PASSWORD_CHANGE`, `PASSWORD_RESET`, `REUSE_CASCADE`).
Replaying a token revoked by `PASSWORD_CHANGE` or `PASSWORD_RESET` returns a
plain 401 `REFRESH_TOKEN_INVALID` and **does not cascade**. Every other
reason behaves exactly as before.

**Why this is not a weakening of reuse detection:** the cascade answers "one
token leaked and we cannot know which other sessions are compromised". After a
password change that question is already settled — every session was revoked
deliberately a moment ago, and the only token the cascade can still reach is
the legitimate successor. It has nothing left to protect and one thing left to
break. The attacker's stolen token is dead either way; the difference is purely
whether the owner's new session dies with it.

**It also fixes what the user is told.** "Your session was ended for security
reasons" is the wrong message for someone who just reset their own password,
and a false theft signal in the audit log is worse than no signal: it would
have fired on *every* password change, which is exactly how a real one gets
ignored.

**Consequence:** `revokedReason` is null for rows revoked before the column
existed, and null falls through to the old behaviour — treated as theft, which
is the safe direction to be wrong in. Two tests pin the regression (one for
change, one for reset): the stale device is refused as an ended session, the
caller's own refresh still succeeds, and no `reuse_detected` row is written.
The existing reuse-detection tests are unchanged and still pass, so genuine
replay still kills the family.
