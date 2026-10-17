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

> **SUPERSEDED (2026-10-17)** by "Password reset is a one-time code, not a
> link" at the end of this file. The token this entry describes no longer
> exists: nothing could deliver it, so reset was replaced by an 8-digit code
> whose digest **is** keyed — for precisely the reason given below, since
> 10^8 is enumerable and 2^256 is not. Kept because the reasoning is still
> the right way to decide the question; only the premise changed.

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

---

## 2026-10-16 — WhatsApp is the delivery channel; phone stays required

**Decision:** OTP delivery, unlock alerts and password-reset notices go over
the **Meta WhatsApp Cloud API**, behind a `WhatsAppClient` seam with a fake and
a real implementation selected by `WHATSAPP_PROVIDER=fake|cloud`. `User.phone`
stays **required and unique**, in the 10-digit national form it has always
stored; E.164 is derived at the delivery boundary by `toE164`.

**Why no nullable phone / email-only signup:** it was considered and is a
deliberate non-goal for now. Making `phone` nullable touches signup, the
unique constraint, the admin lists and the shared types, in exchange for a
state the product has no channel for anyway. "No channel" therefore means
**"phone not verified yet"**, which is a state the user can fix in a minute,
rather than "this account can never receive a message".

**Why India-only normalisation:** the signup form has always demanded a
10-digit Indian mobile, the price is in paise, and a number we cannot validate
is a number we cannot be confident WhatsApp will reach. A valid E.164 number
with the wrong country code is rejected rather than stored and discovered at
the first unlock.

**No grandfathering.** Every existing account starts unverified and must
verify before it can unlock. Nothing is deployed and there are no live users,
so the migration cost is zero and the alternative — a flag exempting "old"
accounts — is a permanent hole nobody would ever close.

**Consequence:** `maskPhone` is the only phone representation allowed into a
log line or an audit row, and it is allowlisted in both the logger's redaction
regex and the audit service's metadata scrubber. Full numbers are redacted
everywhere else, including `to`, `recipient`, `msisdn` and `templateParams`.

---

## 2026-10-16 — A WhatsApp failure must not stop a safe from opening

**Decision:** The in-app notification stays **atomic with and blocking on** the
unlock transaction, exactly as step 2 decided. The WhatsApp message does not:
`WhatsAppNotifier` writes an `OutboundMessage` row through the same transaction
client, and a poll worker sends it after the commit. This reverses step 2's
trade-off **for the external channel only**.

**Why the reversal is right here and wrong there:** step 2's rule — a notifier
that cannot record rolls the unlock back — rests on the in-app notifier being a
single insert on the same connection, which effectively cannot fail on its own.
"The safe opened and we never recorded it" is then genuinely the worse failure.
A third-party HTTP API is not like that. Applying the same rule to WhatsApp
would mean **a safe that refuses to open because a notification channel is
down**, which is far worse than a late message: the owner is standing in front
of their safe, and the authoritative record (the in-app notification and
`/history`) is written either way.

**Sending from inside the transaction is wrong in both directions.** A message
already delivered cannot be unsent by a rollback, so someone could be told
their safe opened when it did not; and a send that blocks the transaction makes
the outage fatal. Writing a row is a local insert, so it keeps the atomicity
and moves the only fallible part outside.

**The outbox is deliberately minimal, and does not need a queue.** One table,
one `setInterval`, `FOR UPDATE SKIP LOCKED` to claim (the same pattern as the
device allocation pick), capped attempts with exponential backoff (30s, 2m, 8m,
32m, capped at an hour). The property that matters — a rollback cannot unsend a
message — comes from writing the row inside the transaction, not from the
transport. A broker would add concurrency and scheduling this workload has no
use for, plus a service to run and a second failure domain. The upgrade seam is
`lib/outbox/outbox.service.ts`; revisit when there is a second API instance,
which is the same trigger as the `TODO(scale)` on rate limiting.

**The worker starts from `server.ts` only, never `createApp()`.** A worker that
started with the app would tick during the test suite, racing every assertion
about outbox state. Tests call `processPending()` directly.

**`SKIPPED` is a distinct terminal status, not a kind of `FAILED`.** It means we
chose not to send — no verified number, no consent, cap spent — so nothing was
attempted and nothing should be retried. Collapsing the two would bury a real
provider outage inside a pile of "this user has no phone yet".

---

## 2026-10-16 — The outbox stores no template parameters, and what that forces

**Decision:** `OutboundMessage` has no column for message text or template
parameters. Parameters are rebuilt from live data at send time
(`lib/outbox/params.ts`).

**Why:** parameters can contain a one-time code, and writing a code to a table
is the one thing the OTP design exists to prevent — only an HMAC of a code is
ever stored. A queued payload column would quietly undo that.

**What it forces, and why that is also correct:** the two OTP kinds
(`UNLOCK_OTP`, `PHONE_OTP`) **cannot be queued at all** — `buildParams` throws
for them. So they are sent **inline**, which is independently right: the user is
waiting for the code, and one that arrives after a retry backoff has already
expired. The outbox therefore carries exactly the messages that are *about
something already recorded* — alerts and the reset notice — whose parameters
can be read back whenever the send happens.

**Consequence:** a dump of `OutboundMessage` says who was messaged about what,
and contains no codes. A test asserts the table's exact column list, so adding
a `params` column later has to be a deliberate decision rather than a quiet
one.

---

## 2026-10-16 — The reset message carries no token

**Decision:** The password-reset WhatsApp template tells the user a reset was
requested and carries **no token and no link**. The token reaches them only
through the flow they started.

**Why:** a WhatsApp message is persistent, forwardable and backed up to
whatever cloud the account is mirrored to. A reset token is an account takeover
in one string, valid for 30 minutes. Putting one in a chat thread means it
outlives its window in someone's message history and on every device that
account is signed in to. The message that *is* worth sending is the alert
half — "a reset was requested; if it wasn't you, your password still works" —
which is the half that matters for a physical-security product.

**This is a narrowing of what was asked for**, recorded here rather than done
silently. It is also why `OutboundMessageKind.PASSWORD_RESET` takes no
parameters.

**The cap applies here, unlike to an unlock code.** An unlock code is an owner
reaching their own safe and must never be cap-blocked — that would be the cap
doing more harm than the abuse it prevents. A reset alert is triggered by an
*unauthenticated* request against a known address, which is exactly the
endpoint someone would use to bombard a stranger's phone.

**And the cap must not become an oracle.** `/auth/password/forgot` answers
byte-identically for a registered address, an unregistered one, a user with no
verified phone, and a user whose cap is spent. Any observable difference would
hand back the disclosure the identical response was built to deny — "this
address has an account that has been messaged a lot today" is still an answer.
Four tests pin this.

---

## 2026-10-16 — Phone uniqueness fails closed, and the masked number rescues the typo

**Decision:** Requesting verification for a number that belongs to **another**
account answers exactly like a success — same status, same body shape — and
**sends nothing**. The collision is recorded only in the audit log.

**Why:** `User.phone` is unique, so the number cannot be taken either way. The
question is what the caller learns. "That number is already registered" lets
anyone test whether a given mobile has a Safe Lock account, and therefore
probably a safe in their house. For a physical-security product that is a worse
disclosure than it first appears, and the endpoint is authenticated only in the
sense that *some* account is signed in — not that it has any claim to the
number being tested.

**The cost, and how it is paid:** a user who mistypes a digit into a stranger's
number would otherwise see "code sent" and wait forever. So the response
carries the **masked** number (`+91 98****10`) and the UI shows it prominently.
They supplied the number, so it reveals nothing, and it is enough to recognise
that the number is not theirs.

**Also decided:** no code is ever sent to a number the caller has not proved a
claim to. That is the other half of failing closed — answering identically
while still messaging the stranger would be worse than the oracle.

---

## 2026-10-16 — `PHONE_NOT_VERIFIED` gates unlock, not lock

**Decision:** `assertCanOperate` refuses an **unlock** without
`phoneVerifiedAt`, with a 403 and its own error code. **Locking is not
gated.** The check sits after paid/refunded and before the device lookup.

**Why lock stays open:** locking needs no one-time code, it is the safe
direction, and blocking it would leave an unverified user unable to secure
their own safe. A gate that prevents someone protecting their valuables is a
gate doing harm.

**Why that order:** paid and refunded come first because they are facts about
the account the user may be unable to change right now. An unverified number is
fixable in a minute, so saying so is more useful than `NO_DEVICE` — which the
user can do nothing about — and checking it before the device lookup means
someone still waiting on allocation learns to verify in the meantime.

**Consequence:** `requestUnlock` *and* `confirmUnlock` both check it. The second
call is the one that moves the bolt, and a number could have been unverified
between the two.

---

## 2026-10-16 — Webhook authentication is the HMAC, and CSRF does not apply

**Decision:** `POST /api/v1/webhooks/whatsapp` verifies `X-Hub-Signature-256` —
HMAC-SHA256 over the **raw body bytes** with the app secret, constant-time
compared — and is exempt from the Origin check and carries no cookies. `GET`
answers Meta's verify-token handshake. Both are rate limited per IP.

**Why CSRF does not apply:** CSRF is the abuse of a browser's *ambient
credentials*. This endpoint has none to abuse — no cookie, no session, no
`Authorization` — so there is nothing for a cross-site request to borrow. And a
forged request cannot produce a valid signature without the shared secret,
which is a stronger claim than an `Origin` header: a header is supplied by the
caller, a signature cannot be. The Razorpay webhook has relied on exactly this
since step 2; `app.ts` now keeps both paths in one `RAW_BODY_PATHS` list used by
the parser bypass and the originCheck exemption.

**The signature is checked in middleware, before the handler.** An
unauthenticated caller never reaches `JSON.parse`, let alone the database, so
the attack surface of a public endpoint is one HMAC comparison. A test posts
non-JSON with a bad signature and asserts **401 rather than 400** — a 400 would
prove the body had been parsed first.

**Idempotency is by rank, not by a ledger.** Statuses apply only when they move
the record forward (sent → delivered → read), so Meta's retries and
out-of-order deliveries cannot walk it backwards, and a repeat does not even
move the timestamp. `failed` applies from any state, because it is news rather
than progress. Unlike the Razorpay webhook there is no `WebhookEvent` ledger:
the update is already idempotent by construction, and a ledger would be a
second thing to keep correct.

**An unknown message id is a 200, not a 404.** A retry cannot fix "we never
issued that id" — it is a message from another environment, or a pruned row —
and Meta retries anything that is not a 2xx, forever.

---

## 2026-10-16 — The OTP delivery-failure window, stated rather than hidden

**Decision:** When a code cannot be delivered, `requestUnlock` **consumes the
challenge it just created** and answers 502 `OTP_DELIVERY_FAILED`. The
unlock-request rate limiters refund a 5xx, so an outage does not also burn the
user's three-codes-per-ten-minutes.

**Why consume it:** leaving the challenge open would mean a live code for five
minutes that the owner never received — a code usable only by someone who
intercepted it. The user gets a clear error and can simply ask again.

**The window, plainly:** the commit and the send are two steps and **nothing can
make them atomic** — a send cannot join a database transaction, and a
transaction cannot un-send. If the process dies between the commit and the
compensating consume, an undelivered challenge stays open until it expires on
its own five minutes later. Three things bound it: that is the same five-minute
exposure an ordinary unread code already has; it requires a crash inside a
window of roughly a hundred milliseconds; and the code only ever existed in the
memory of the process that died. Closing it properly would need a two-phase
protocol with the provider, which Meta does not offer.

**Why the refund is scoped to 5xx:** every 4xx still counts, so a caller
cycling request/confirm with wrong codes is bounded exactly as before. There
are tests for both halves.

---

## 2026-10-16 — A per-user daily cap on WhatsApp sends

**Decision:** `WHATSAPP_DAILY_SEND_CAP` (default **10**) messages per user per
**rolling** 24 hours, across every kind. Counted from `OutboundMessage` rows
that were actually attempted (`PENDING`, `SENT`, `FAILED`); `SKIPPED` rows cost
nothing and do not consume the allowance.

**Why:** every message costs money and lands on a real person's phone. An
uncapped send endpoint is both a billing risk and a way to use this product to
harass someone.

**Why rolling rather than calendar-day:** a calendar cap resets at midnight in
a timezone we did not choose, which hands an abuser a predictable refill and a
legitimate user an arbitrary cliff.

**Where it does and does not apply:**
- **Unlock codes ignore it.** An owner reaching their own safe must not be
  locked out by a messaging quota; the unlock rate limiter (3 per 10 minutes)
  and the paid-plus-verified-plus-allocated gate already bound that path.
- **Verification and reset respect it**, and answer differently on purpose:
  verification is authenticated, so it returns 429 `WHATSAPP_SEND_CAP_REACHED`
  with the time the window reopens; `/forgot-password` is unauthenticated, so it
  stays byte-identical and silently skips the send.

---

## 2026-10-16 — Templates, and why the names come from the environment

**Decision:** Five approved templates, one per `OutboundMessageKind`, with
their **names read from `WHATSAPP_TEMPLATE_*` environment variables** rather
than hardcoded.

**Why from the environment:** template names are created and approved per
WhatsApp Business account in Meta's console. Hardcoding a name would assume an
approval this codebase cannot verify, and a rejected or renamed template would
need a code change and a deploy rather than a config change.

**Categories matter and are not interchangeable.** The three code-carrying
templates are **authentication** category: Meta allows them to be delivered
outside the 24-hour customer-service window, which is exactly what an unlock
code needs, and requires a copy-code button with no custom URLs. The two alerts
are **utility** category — they are about a transaction the user performed.
Marketing category is never used and must not be: it is rate-limited by Meta
per user and can be switched off by the recipient, neither of which is
acceptable for a security alert.

**Consequence:** the exact template definitions to submit to Meta are in
`README.md`, alongside the production environment variables they map to. Until
they are approved, `WHATSAPP_PROVIDER=fake` is the only working configuration —
which the env schema enforces by refusing `fake` in production, so a
half-configured deployment fails at boot rather than silently sending nothing.

---

## 2026-10-17 — Password reset is a one-time code, not a link

**Supersedes** "2026-10-16 — Reset tokens are a plain SHA-256, and the OTP is
not", which remains above as the record of why the token was shaped that way.
Its reasoning was not wrong; its premise changed.

**The problem.** Step 4 decided the reset WhatsApp message would carry **no
token** — a chat message is persistent, forwardable and backed up to whatever
cloud the account is mirrored to, and a 32-byte reset token is an account
takeover in one string that outlives its expiry in someone's history. That was
right. The consequence was that nothing could deliver the credential: there is
no email sender, so the message contained nothing the user could act on and
**password reset did not work in production at all**. A safe credential nobody
can use is not a feature.

**Decision.** Reset is now an **8-digit one-time code**, delivered over the
channel that exists, with the identifier submitted alongside it:

- `POST /auth/password/forgot` `{ identifier }` — email **or** phone
- `POST /auth/password/reset` `{ identifier, code, password }`

15-minute expiry, 5 attempts, single use, a new request supersedes the old
code, and a server-enforced minimum interval between requests.

**Why 8 digits, and the tradeoff.** 10^8 against five attempts is a
1-in-20-million shot per code. Base32 would give 10^12, which the attempt cap
makes unreachable either way — the extra entropy buys nothing, while digits buy
a numeric keypad on mobile, no case handling, no "is that O or 0" on a code
read off a message, and a working `autocomplete="one-time-code"`. **The
tradeoff this accepts is real:** 8 digits is safe *because* the attempt counter
works. Base32 would survive a broken attempt limit; this will not. The counter
is therefore load-bearing, and is where the test weight went.

**Why the digest is keyed now, having argued against keying it before.** The
step 3 entry's claim was that an unkeyed hash is reversible exactly when the
input space is enumerable, and that 2^256 is not. Both halves still hold —
**10^8 is**, so the code is stored as `HMAC-SHA256("pwreset:v1:" + code,
OTP_HMAC_SECRET)`. The secret is the existing one rather than a new variable:
these are the same kind of thing (short-lived one-time codes), and rotating the
key invalidates at most 15 minutes of outstanding codes either way. The
`pwreset:v1:` prefix is domain separation, so a reset digest can never equal an
unlock digest for the same digits even under one key — there is a test.
**Nothing new is required in `.env`.**

**The attempt counter is atomic by construction.** The increment is a
conditional update whose `where` carries `attempts < RESET_CODE_MAX_ATTEMPTS`,
`consumedAt: null` and an unexpired `expiresAt`. The check and the increment
are therefore one statement: twenty parallel guesses cost at most five
attempts, none of them gets a free evaluation, and the cap cannot be overshot.
Crucially there is **no branch that compares the digest before spending an
attempt**, so the *correct* code also fails once the attempts are gone. Three
tests pin this, including twenty parallel wrong guesses and ten guesses from
distinct apparent clients with fresh limiter buckets.

**The per-account limit is the point, and its cost is accepted.** The counter
lives on the challenge row, so it is IP-independent: many addresses hammering
one account share one counter. The cost is that someone who knows your email
can burn your code's five attempts and force you to request another. That is a
nuisance confined to the reset flow — login is untouched — and a fresh code is
always obtainable, subject only to the minimum interval and the daily cap.
There is a test for that too. The alternative, per-IP only, is exactly the
brute-force surface a short code must not have.

**One answer for every failure.** Unknown identifier, no outstanding code,
wrong code, expired, already used, attempts exhausted — all return 400
`RESET_CODE_INVALID` with one message. This endpoint is unauthenticated, so any
difference would say whether an account exists and therefore whether somebody
owns a safe. Exhaustion is distinguished **only** in the audit log
(`auth.password.reset_code_exhausted`), because five wrong codes against one
reset is a signal worth being able to see.

**The minimum interval is server-side, and not an oracle.** It is a rate-limit
limb keyed on `sha256(identifier)` with a window of
`RESET_CODE_RESEND_COOLDOWN_SECONDS`, evaluated **before any database lookup**,
so its 429 is identical for a real and a fake account (verified over HTTP as
well as in tests). The UI countdown reads the same constant, so the two cannot
drift. It is separate from the 3-per-hour limb because "not two in a second"
and "not too many in a day" are different questions that one bucket cannot
express.

**The long-token path is removed, not deprecated.** `PasswordResetToken`,
`hashResetToken`, `RESET_TOKEN_BYTES`, `RESET_TOKEN_INVALID`, `resetTokenSchema`
and the `?token=` handling are all gone, with a destructive migration (no
deployment, no live users — consistent with the no-grandfathering decision). An
undeliverable credential is unreachable auth surface, which is where bugs live.
If an email sender lands later, a link is re-addable and will then have a
channel that can carry it.

**Unchanged from step 3:** reset still issues no session and clears cookies,
and still revokes every refresh token with `revokedReason: PASSWORD_RESET` so a
stale tab gets a plain 401 rather than a false theft cascade.

**Still open:** a user with no verified phone has no channel, so reset remains
unreachable for them. That is the email-provider question in CLAUDE.md, and the
reason the dashboard nags unverified users.

---

## 2026-10-17 — Rentals replace the one-time purchase (step 8)

The product is a **rental**: a user books a safe by the hour, pays, uses it,
and collects their belongings. The one-time ₹999 activation, permanent device
ownership and admin allocation are all gone. This is the largest model change
the codebase has had, so the reasoning is recorded at length.

### Nobody owns a device

`Device.ownerId` is deleted. Occupancy is a property of a `Booking`, not a
column on the device, which means the question "who has this safe" has an
answer with a *duration* attached. Everything that used to be derived from
ownership — `/devices/mine`, `assertCanOperate`, the admin device row — now
resolves through the caller's live booking instead.

### Two constraints, not two service checks

The purchase model's one correctness guarantee was a unique index on
`Device.ownerId`: the allocation service also checked, but a check is a read
followed by a write and two concurrent allocations can both pass the read. The
rental model needs the same guarantee for a harder shape, and gets it the same
way:

- `Booking_device_no_overlap` — `EXCLUDE USING gist (deviceId WITH =,
  tsrange(startsAt, reservedUntil, '[)') WITH &&)`, restricted by a `WHERE` to
  the three occupying statuses. Terminal rows leave the constraint entirely,
  which is what frees a safe.
- `Booking_one_live_per_user` — a partial unique index. This is what closes the
  obvious abuse of holding a safe before paying: without it anyone could open
  unpaid bookings until the pool was empty.

Both live in a raw-SQL migration because Prisma models neither. The service
still checks, and the checks still matter — they produce a decent error message
instead of a 500 — but the constraint is what is *true* under concurrency.

**`tsrange`, not `tstzrange`.** Prisma maps `DateTime` to `timestamp(3)`
*without* time zone and the driver writes every value as UTC. Casting to
`timestamptz` depends on the session `TimeZone`, which is therefore not
`IMMUTABLE`, and Postgres refuses a non-immutable expression in an index. A
`tsrange` over the stored UTC values is immutable and compares exactly the
instants we mean. The column types were checked against the live database, not
assumed.

**`[)` bounds**, so a booking reserved until 12:45 does not collide with one
starting at 12:45 — without which every back-to-back rental would be rejected.

The migration creates `btree_gist` itself (needed to mix `=` with `&&` in one
exclusion constraint). **Managed Postgres must allow that extension** — noted
in the README, because it is the one thing in this design that a hosting
provider can simply refuse.

There is a test that inserts overlapping rows directly, bypassing the service.
If the constraint were dropped by a future migration, every service-level test
would still pass and only that one would fail.

### The device is held from creation; the clock starts at payment

A `PENDING_PAYMENT` booking reserves a safe for `BOOKING_HOLD_MINUTES`, so a
user who pays is never told "sorry, gone". Two consequences had to be handled:

- **`endsAt` is null while pending** and set to `paidAt + hours` at activation.
  A slow checkout must not eat into purchased time. But the hold still has to
  reserve the *whole intended window* — otherwise another booking could be sold
  into it and the payment would have nowhere to land — so `reservedUntil` is
  computed from a provisional end of `now + hours`.
- **`reservedUntil` covers grace plus the collection window**, not just
  `endsAt`. The safe may still physically contain somebody's belongings for all
  of it, so a back-to-back booking must not be sold into the turnaround.

For a pending booking, then: `startsAt` = now, `endsAt` = null,
`holdExpiresAt` = now + hold, `reservedUntil` = provisional end + grace +
collection window. All four are set at creation, and the exclusion constraint
covers the hold from the first instant.

### Status is derived from the clock on every read

`effectiveBookingStatus` is the function every read asks, and the stored
`status` column is explicitly allowed to lag. The sweeper is a **reconciler**,
not an authority: it moves rows, releases safes and pushes `reservedUntil` out,
but it decides nothing. A sweeper that is late, wedged or has never run cannot
make a safe unlockable — that is the property which makes a 60-second loop safe
to operate, and nothing in the sweeper may ever become the only thing enforcing
a transition.

Clients must branch on `effectiveStatus`, never `status`, and the type's
documentation says so. The mock API derives it with the same shared function,
since it has no sweeper at all.

### Only `COLLECTED` returns a safe to the pool

This is the decision with the sharpest safety argument, and it overrode the
first draft of the plan, which released the device when a collection window
lapsed.

A booking can end three ways, recorded in `completionReason`:

| Reason | What happens to the safe |
|---|---|
| `COLLECTED` — the user said they have their things | back to `AVAILABLE` |
| `COLLECTION_WINDOW_LAPSED` | `NEEDS_INSPECTION` |
| `ADMIN_FORCE_COMPLETED` | the admin chooses, defaulting to `NEEDS_INSPECTION` |

The safe cannot tell whether it is empty. If a booking ends without the renter
confirming collection, the contents are **unknown**, and releasing it would
hand the next renter a safe containing someone else's property *along with the
ability to unlock it*. That is strictly worse than a safe sitting idle, so a
`NEEDS_INSPECTION` device leaves the bookable pool until an admin clears it
with a required, audited note.

`DeviceStatus` gains `NEEDS_INSPECTION` now. `MAINTENANCE` can wait for
hardware; there is nothing to maintain yet.

**An admin force-completing chooses**, defaulting to inspection. Making it
unconditional would leave an admin who has just looked inside unable to say so,
which pushes them towards clearing the flag immediately afterwards without
looking — the same two clicks with the check skipped. Defaulting the other way
would release a possibly-occupied safe on a careless click.

### An unpaid overstay is never completed, by design

If a renter overstays and never pays, the booking stays `OVERSTAY` forever:
the fee is capped (`OVERSTAY_CAP_HOURS`), the safe stays reserved (the sweeper
pushes `reservedUntil` out in hourly steps), and the row appears in the admin
flagged list. Nothing automatic releases it. The alternative — timing out and
releasing — is the same failure as above with a timer attached.

**Open question: the abandoned-items process.** What an operator actually does
with a safe whose renter never returns — how long to hold it, how to contact
them, what disposal is lawful — is a policy and probably legal question, not a
software one. The software's job is to refuse to make the decision silently,
which it now does.

### Collect is refused while a fee is outstanding

`OVERSTAY_PAYMENT_REQUIRED`, 402. Collect is allowed from `ACTIVE`, and from
`OVERSTAY` only once the fee is settled or waived. The fee is the only leverage
the product has, and letting someone take their belongings while owing it would
discard it. There is a test that collect during an unpaid overstay fails *and*
the device stays reserved — asserted by having the next renter try to book it
and be refused.

**Unlock is refused too; lock is not.** Refusing to let someone secure a safe
they are standing at would punish them in the one direction that creates risk
rather than recovering money. The same asymmetry the phone-verification gate
already had.

### Eligibility is re-checked inside the unlock transaction

A one-time code lives for five minutes and knows nothing about bookings, so a
code requested while a booking was live would otherwise still open the safe
afterwards. Two independent guards:

1. `confirmUnlock` re-runs `assertCanOperate` **inside the transaction, with
   the device row locked**. That is the load-bearing check; the one before the
   transaction exists to fail fast with a good message. A throw there rolls back
   the challenge claim too, so a refusal that is not the user's fault does not
   burn their code.
2. Completing a booking consumes every open `UnlockChallenge` for it.

Tested both ways: a code requested while `ACTIVE` then confirmed after
collection, after an overstay begins, and after an admin force-complete all
fail, and the bolt does not move.

### Extensions are allowed during the grace period

Someone five minutes over who wants another hour should be able to buy one
rather than be pushed into an overstay fee. Refused once a fee is actually
owed: the hour being extended has already been charged at the overstay rate, so
that money is refundable rather than applicable, and the answer to an overstay
is to pay it. Also refused if a later booking would collide — a limitation
worth naming, since the person who booked after you has the better claim.

Extensions are priced from the booking's **snapshot**, never the live config.

### Rates are snapshotted onto every booking

`hourlyRatePaise`, `overstayMultiplierBps`, `graceMinutes`, `capHours` and
`collectionWindowMinutes` are copied onto the row at creation and read from
there forever after. Changing an env var must never re-price a booking that is
already running. The multiplier is **basis points** (15000 = 1.5x) because
money must never touch a float and a fractional paisa cannot be charged.

Overstay is billed per **started** hour with `Math.ceil`, so five minutes over
costs an hour. That is stated on `/book` before anyone pays, which is the only
thing that makes it defensible.

### Money that cannot be applied stays PAID and gets flagged

Three ways a captured payment can arrive with nowhere to go, each with its own
`PaymentReviewReason`:

- `BOOKING_EXPIRED_DEVICE_TAKEN` — the hold lapsed and the safe went to someone
  else.
- `OVERSTAY_QUOTE_EXPIRED` — see below.
- `BOOKING_NO_LONGER_PAYABLE` — cancelled or completed before the money landed.

In every case the `Payment` row **stays `PAID`**. We do not rewrite a payment
to pretend it did not happen; that would put a lie in the one table that must
not contain one. The row gets a `reviewReason`, appears in the admin
needs-refund queue, and the user is told plainly — `VerifyPaymentResponse`
carries `needsReview`, and the UI renders it as a red panel saying the money
arrived, could not be applied, is logged for a refund, and do not pay again.

**Refunds are manual.** There is no refund call anywhere in this codebase. An
admin refunds in the Razorpay dashboard — the only place with the authority and
its own ledger — and then records it here with a required, audited note
(`POST /admin/payments/:id/clear-review`), which never touches `status`. The
`refund.processed` webhook flips the row to `REFUNDED` and clears the flag by
itself when it arrives, so the manual action covers the cases where it never
does. Leaving a refunded row on the queue is wrong in the direction that gets a
second refund issued.

### A late payment re-activates when it can

If a payment lands after the hold lapsed and the safe is **still free**, the
booking is re-activated with a full fresh clock — the exclusion constraint
re-checks the write, so this is safe. If the safe has been **taken**, nothing
is forced: taking it back from a paying renter to give it to an earlier one
would only move the problem, so the money is flagged.

The Razorpay order's `expire_by` is set to the hold, so the gateway refuses
most late attempts before they reach us — the cheapest place to stop them.
That makes this window small rather than routine. Both branches are tested.

### The overstay quote is binding for a bounded window

A fee grows while the user is at the checkout, so the quoted amount is honoured
for `OVERSTAY_QUOTE_TTL_MINUTES` (default 15) and the Razorpay order carries
the same `expire_by`. Three cases:

- **Within the window**, however much the fee has grown: settle it, and absorb
  the difference. The alternative — settling partially and leaving a residue —
  creates a loop in which the user can never finish paying, which is worse than
  giving away at most one started hour. The audit row records what was absorbed
  so the giveaway is visible.
- **Past the window, amount still covers the fee**: settle it. The TTL exists
  to stop us accepting too little, not to punish lateness.
- **Past the window, fee has outgrown it**: **do not settle.** Flag it
  `OVERSTAY_QUOTE_EXPIRED` for a manual refund. Settling would quietly accept
  less than is owed and open the collection window on a part payment. The fee
  stays outstanding, so unlock and collect are still refused and the user can
  request a fresh quote — which is the behaviour the tests assert end to end.

### The lock command is sent after the commit

Every booking completion commands the safe locked, and the gateway call happens
**after** the transaction, never inside it — the same rule the WhatsApp outbox
follows, for the same reason: a network round trip cannot join a transaction,
and a transaction cannot un-send one. It is best effort and logged loudly on
failure, because a booking that has ended has ended whether or not the bolt
moved, and failing the request would leave the database and the user's view
disagreeing.

**Real hardware must confirm this (step 9).** `lockState` only moves on an ack,
so an unacked command leaves the stored state alone — which is correct but
means a safe can be recorded as closed while physically open. With MQTT this
becomes a `Command` row with a nonce and a 15-second timeout, and a completion
whose lock is never acked will need to raise an operational alert rather than
just a log line.

### A refund no longer withdraws access

Under the purchase model, `hasPaid: false` with `deviceAllocated: true` was a
real state with its own dashboard screen. It is gone: what grants access is a
booking you paid for, and a refund does not un-rent the hours you have already
used. A safe somebody is physically holding cannot be reclaimed by a webhook
either. Whether a refunded booking should be force-completed is a policy
question, and the answer today is that an admin decides — which is exactly what
the Bookings tab is for.

### The destructive migration

`Payment.purpose` is NOT NULL and every existing `Payment` row is an artefact
of a model that no longer exists, with no honest purpose to assign it, so the
rows are deleted. `Device.status` goes through `text` to be remapped, because
Prisma's generated cast cannot work when no old enum value exists in the new
enum: `UNASSIGNED` becomes `AVAILABLE`, `ASSIGNED` becomes `NEEDS_INSPECTION`
(it was in somebody's hands, so a human should look), `RETIRED` stays.
Consistent with the no-grandfathering decisions before it: no deployment, no
live users.

Removed outright rather than deprecated: `requirePaid` (middleware and test),
`allocateDevice`, `unassignDevice`, `GET /payments/me`, `POST /payments/order`,
`/admin/devices/:id/allocate`, `/admin/allocate-next`,
`/admin/devices/:id/unassign`, `PublicUser.hasPaid`,
`PublicUser.deviceAllocated`, and the error codes `NOT_PAID`, `NO_DEVICE`,
`REFUNDED_CONTACT_SUPPORT`, `ALREADY_PAID`, `ALREADY_HAS_DEVICE`,
`NO_DEVICES_IN_STOCK`, `PAYMENT_REQUIRED`. `DEVICE_STILL_ASSIGNED` became
`DEVICE_HAS_LIVE_BOOKING`, since nothing is assigned to anybody any more but
retiring an occupied safe is still refused. Dead auth surface is where bugs
live.

Two tests pin absences rather than behaviour: `/auth/me` no longer carrying
the purchase flags (a client still reading `hasPaid` would get `undefined` and
treat every user as unpaid), and `/payments/me` answering 404 (so the route
cannot quietly return carrying a price the booking rules no longer agree with).

### A correctness fix the test suite found

`effectiveBookingStatus` treated a stored `OVERSTAY` row as overstaying
forever, ignoring `endsAt`. An extension bought during the grace period moves
`endsAt` forward, so the user would have been told they were overstaying time
they had just paid for — and the sweeper's own "pull it back to ACTIVE" branch
was unreachable. It now returns `ACTIVE` when the end is back in the future and
nothing has been settled or waived (an extension is refused once either has
happened, so the ordering is safe).


### A sweeper bug that only a live run found

Verifying the build over HTTP against a running server turned up a defect no
test in the suite would have caught, and it is the most serious thing fixed in
this step.

**The collision.** Back-to-back bookings are the ordinary case for a busy pool:
booking B starts exactly where booking A's reservation ends, which the `[)`
bounds permit. If A then overstays, the sweeper tries to push A's
`reservedUntil` an hour into the future — straight into B's window. The
exclusion constraint rejects the write, and it is **right** to: two bookings
cannot occupy one safe.

**Why it was serious.** The whole sweep ran in one `try`/`catch`. A single
colliding row threw out of the loop, the tick logged "Booking sweep failed",
and *every subsequent sweep failed identically* — because the colliding row was
still there. So for every booking in the system: holds stopped expiring, nothing
moved to `OVERSTAY`, and no collection window ever closed. One back-to-back
booking plus one overstay was enough to stop the reconciler permanently.

It did not make a safe unlockable — status is derived from the clock on every
read, which is exactly the property that kept this from being a security
incident rather than an operational one. But the design leans on that property
precisely so the sweeper can be allowed to lag, and "lags forever, silently" is
not lagging.

**Two fixes, and the reason for each:**

1. **Per-row isolation.** Each booking's reconciliation gets its own
   `try`/`catch` and a `failed` counter in `SweepResult`, logged at `warn`. One
   row that cannot be written must not stop the others. The outer catch stays
   as a backstop for failures outside the loop.
2. **Clamp instead of force.** `extendReservation` now looks up the next
   booking holding that device and extends only as far as its `startsAt` —
   possibly not at all. The booking still moves to `OVERSTAY` and still accrues
   a fee, so nothing the renter cares about changes; what is given up is the
   reservation, in the one case where somebody else has a better claim to it.

**What the clamp deliberately does not do** is decide who gets the safe. Two
people wanting one safe is a policy question — bump the new booking? compensate
them? substitute another safe? — and the sweeper's job is to make it visible,
not settle it. A clamped row has an unpaid fee or an occupied safe, so it is
already in the admin flagged list. This is the overstay-collision open question
in CLAUDE.md arriving earlier than expected: it does not need future-dated
bookings, only back-to-back ones.

**Why the tests missed it.** Every sweeper test used one booking per device, so
no test constructed the collision — and the service-level tests would all still
pass today with the clamp removed and the isolation reverted, as long as no
fixture happens to put two bookings on one safe. Five tests now pin it: the
status still moves, the reservation is clamped *at* the next start rather than
past it, an unrelated lapsed hold in the same sweep is still expired, repeated
sweeps stay healthy, and a row that genuinely cannot be written is counted
rather than thrown.

The HTTP verification earned its place in the checklist on this alone.

### Still open

- **The abandoned-items process** — above.
- **Future-dated bookings and overstay collisions.** Bookings are "from now"
  only. If future-dated booking is added, an overstay will be able to collide
  with a reservation that was legitimately sold — the current design handles it
  by refusing the extension and leaving the overstayer in place, which is right
  for back-to-back today but would need a real policy (bump? compensate?
  substitute safe?) once someone can book next Tuesday.
- **The hourly rate is provisional**, exactly like the ₹999 before it. 10000
  paise/hour is a development placeholder, and the 1.5x multiplier, 15-minute
  grace, 24-hour cap and 30-minute collection window are all guesses that look
  plausible rather than decisions anybody has made.
- **Retention** is still undecided, and `Booking` rows now join `DeviceEvent`
  and `AuditLog` in having no retention policy.

## 2026-10-17 — Rental reminders: scheduled messages (step 8b)

A booking has deadlines, and until now the only thing that knew about them was
a page the renter had to think to open. Five WhatsApp messages now follow a
rental: confirmed, ending soon (twice), overstay started, fee settled,
collection closing. The decisions worth recording are mostly about what the
feature deliberately does *not* do.

### Scheduling is a due time on an outbox row, not a job queue

`OutboundMessage` gains `sendAt`, and the claim query requires both
`sendAt <= now` and `nextAttemptAt <= now`. The two columns are kept apart on
purpose: `sendAt` is the moment the message is *about* and never moves once the
row exists, while `nextAttemptAt` is retry backoff and only ever moves forward.
Requiring both means a backoff can push a message later but never pull one
earlier — and "your booking ends in 30 minutes", delivered an hour early, is
the one direction a scheduled message must never move.

No new table, no broker, no scheduler. The upgrade seam is the same one the
outbox already documented.

### Two guards, independent, exactly like unlock eligibility

A state change cancels a booking's pending messages (`SKIPPED`/`CANCELLED`),
**and** every row carrying a `bookingId` is re-read against the live booking
before it is sent (`SKIPPED`/`NOT_APPLICABLE` if it no longer applies). Either
alone would be nearly enough. Both are kept because:

- cancellation can be forgotten in a future change — a new completion path, a
  new admin action — and re-validation makes that harmless rather than a false
  statement about a safe holding someone's property;
- re-validation alone would leave dead rows to be claimed and refused one by
  one, and would lose the record that we *meant* to tell someone something.

Keeping two **reasons** matters as much as keeping two guards: a pile of
`NOT_APPLICABLE` is the signal that a state change is failing to cancel what it
should. Collapsing them into one reason would hide precisely that.

Re-validation also **produces the template parameters from the same read** that
decides whether to send. Splitting "should we send?" from "what does it say?"
would let the two disagree, and the shape of that disagreement is a confident
lie about somebody's belongings.

### The overstay notice is scheduled a minute late, deliberately

The fee is exactly zero at `endsAt + grace` — accrual is `Math.ceil` per
started hour, so the boundary itself charges nothing. Re-validation requires an
outstanding fee. A notice due at that precise instant would therefore be
refused on every poll until it went stale, and the message that matters most
would be the only one that never arrived. `OVERSTAY_NOTICE_DELAY_SECONDS = 60`
moves it one minute past the boundary, where there is always a fee to name.

This is the kind of bug that is invisible in review and obvious in a test, so
there are tests from both sides of the boundary and a sweep of offsets across
it.

### Dedupe keys are built from stable identifiers, never from `now`

Settlement runs from **both** the verified Checkout callback and the webhook. A
key containing the current time would make the second run a different row and
send a second message. So: a confirmation is keyed on `endsAt`, a receipt on
the payment id, the deadline kinds on their own due time — facts two racing
transactions agree about. Scheduling is then
`createMany({ skipDuplicates: true })` with no prior read, which is the only
shape that is correct under concurrency.

**The known sharp edge.** A cancelled row keeps its key, so re-creating that
exact key is silently dropped — a reminder that never arrives, with no error
anywhere. It is unreachable today only because an extension adds whole hours
while the reminder leads are 30 and 10 minutes apart, so no new key can equal
an old one. That is an assumption about configuration, not a property of the
code, so a test asserts every re-created key differs from every cancelled one.
Changing the leads or the minimum extension fails there rather than in
production.

### Staleness: a late deadline message is a false one

`REMINDER_MAX_LATENESS_MINUTES` (default **5**) against
`OUTBOX_POLL_INTERVAL_MS` (default **5 seconds**) — sixty polls of headroom, so
a restart or a slow deploy discards nothing and only a real outage does. Past
the tolerance a booking message is `SKIPPED`/`STALE` and never sent: "your
booking ends in 10 minutes", arriving forty minutes after it ended, does not
inform anybody, it misinforms them about a safe holding their things.

A **retried** message past the tolerance is skipped too. That is intended for
reminders: the deadline it describes is gone either way.

Immediate kinds are exempt. A message about something that already happened —
an unlock alert, a receipt — has no deadline to miss and should go out however
late.

### Two send budgets, and which kind draws on which

`WHATSAPP_DAILY_SEND_CAP` (10) is now explicitly the **user-triggered**
budget: `PHONE_OTP`, `PASSWORD_RESET`, `UNLOCK_ALERT` and
`FAILED_ATTEMPTS_ALERT`. The last two are worth stating — they follow an action
somebody took, so they are user traffic and must not drift into the booking
budget or out of a budget altogether. `UNLOCK_OTP` alone skips the check, as it
always has, because a quota that can stop someone opening a safe they are
standing at does more harm than the abuse it prevents.

Booking traffic gets `WHATSAPP_BOOKING_SEND_CAP` (20). Not an exemption: a day
of two dozen extensions is still bounded, and nothing a client can call creates
one of these rows. The split exists so a chatty rental cannot drop the renter's
own verification code — and narrowing what the user budget counts makes that
protection sharper, not weaker.

The booking budget counts only rows actually **SENT**, unlike the user budget,
which counts `PENDING` too. Reminders are cancelled and re-created on every
extension, and a user who extends four times should not lose their overstay
notice to the ghosts of messages that were never delivered.

### A dropped message is visible, not silent

Two reasons drop a message rather than withdraw it: the booking budget is spent
(`CAP_REACHED`) or it was claimed too late (`STALE`). Both now appear as
`undeliveredMessages` on the admin Bookings row and flag it as needing
attention. A dropped overstay notice is a renter who was never told a fee had
started, and the first anyone would otherwise hear of it is the renter disputing
the fee.

On the booking rather than in a message log of its own: the question an admin
has is "is anything wrong with this booking?", and a fee the renter was never
warned about is wrong with the booking.

### No in-app notification rows for booking events

Asked and decided: **no**. The dashboard already renders the end time,
countdown, fee and collection deadline derived from the server clock on every
read, which is strictly better than a notification row — it is current rather
than a record of a moment. Bell rows would mean new `NotificationType` values
and copy for information the card shows live, and the bell's value is that it
still means something on the day it matters. WhatsApp is therefore never the
source of truth here; it is a nudge toward a page that is.

### A waived fee sends no receipt

`OVERSTAY_SETTLED` is refused for a waiver, and re-validation enforces that
independently of the scheduler: `overstayWaivedAt` leaves `overstayPaidPaise`
at zero, and "we received your payment of zero" is a lie about money. A sixth
approved template to say "no fee is outstanding" buys one sentence, so the
waived renter gets the **collection reminder only**.

**The accepted consequence:** a waived user receives no immediate message, so
the admin who waives is expected to tell them. Recorded here rather than left
as an accident. Worth revisiting if waivers turn out to be common.

### An extension re-sends the confirmation

No sixth template. "Safe X is yours until Y" is exactly the sentence an
extension needs, and the key is `endsAt`, so the new one is genuinely a
different message while a double settlement still produces one. The old
confirmation is not cancelled — it was true when it was sent.

### One function decides whether an extension is possible

`extensionAvailability(row, now)` is non-throwing and is what
`assertExtendable` now calls; the extension page, the dashboard and the order
endpoint all render its answer. Three implementations of one rule is three
chances to offer a button that 409s, and the button that 409s here is the one
somebody taps from a reminder with twenty minutes left.

A following booking now shortens the offer instead of refusing outright — "two
more hours but not five" is a better answer than "no", and it is the same
query. The dashboard also stops multiplying an hourly rate by a number of hours
in the browser, which it had been doing against the rule that the client does
no money arithmetic.

### `?next=` is validated by resolving it, not by pattern-matching it

`safeInternalPath` parses the value against the current origin with `new URL`
and requires the result to still be on that origin. Pattern-matching has to
anticipate every bypass — `//evil.test`, `/\evil.test` (WHATWG treats a
backslash as a slash for http(s)), `/%5Cevil.test`, `https:/evil.test` — and
resolving anticipates all of them at once, including the ones nobody has thought
of. The textual rules in front of the parse are shortcuts that cheaply refuse
things no honest link contains: control characters (URL parsers *strip* tabs and
newlines rather than rejecting them), colons, encoded separators, and anything
over 200 characters.

It lives in `@safelock/shared` as a pure function of a value and an origin,
which is what makes it testable: the web workspace has no test runner, so the
one-line browser wrapper reads `window.location.origin` and everything worth
asserting is asserted in the API suite. `@safelock/shared` is now in that
suite's `include` for the same reason.

The route guards read `window.location` inside their effects rather than using
`useSearchParams`, which opts a page out of static prerendering unless every
use sits in a Suspense boundary — it broke the production build of `/book` and
`/login`, and the build is what caught it.

### `PUBLIC_WEB_URL`, separate from `WEB_ORIGIN`

`WEB_ORIGIN` is a comma-separated CSRF and CORS allowlist that may legitimately
hold several origins. A deep link needs exactly one base, and taking the first
entry of a list would make what a message says depend on the order someone
typed an unrelated setting. It defaults to `http://localhost:3000` outside
production so a fresh clone needs no configuration, and production refuses to
boot unless it is set, `https:`, not a loopback host, and free of placeholder
text — a message carrying a link to `localhost` strands the reader, and the
whole point of these messages is the page they point at.

Meta fixes the URL base in the approved template and appends one variable at
send time, so `urlButtonSuffix` **cannot** send anyone off-site whatever it
contains. Every caller builds it from a booking id and a fixed path segment.

### A live bug the template work found

`deliverOtp` was passing `[code, serialNumber]` to `safelock_unlock_code`, an
AUTHENTICATION template whose Meta-fixed layout permits exactly one body
parameter. A second one is a `TEMPLATE` rejection — terminal, never retried —
so the real outcome was no code delivered, a compensated challenge and a 502 at
the moment somebody was standing at a safe trying to open it. Now `[code]`,
asserted with `toEqual` so an extra parameter fails in the suite rather than in
production. Nothing is lost: a user has one live booking, so the message is
unambiguous, and the serial is in `safelock_unlock_alert` where a second
parameter is allowed.

### Times are rendered by the API, in IST

A message is not a client render: there is no browser locale to read, no
component to re-render, and the string sits in somebody's chat history. So
`Asia/Kolkata` is written explicitly rather than taken from the server's
timezone — a deployment in another region must not change what a message says.
Money goes through the shared paise formatter, so a message and the UI cannot
disagree and no call site divides by 100 itself. If the product ever leaves
IST, `lib/outbox/messageFormat.ts` is the one place that changes.

### Still open, from this step

- **Whether a waived renter needs an immediate message.** Above.
- **The reminder lead times** (30 and 10 minutes) and the collection lead (10)
  live in `@safelock/shared` rather than the environment, because they appear
  in Meta-approved copy *and* in UI text promising them. Changing them is a
  code change plus a template review, which is the right amount of friction —
  but nobody has confirmed the numbers themselves.
- **`WHATSAPP_BOOKING_SEND_CAP = 20`** is a plausible bound, not a measured
  one.
- **Two of the five new templates depend on the production domain**, because
  their dynamic URL button bakes in a base URL. They cannot be submitted to
  Meta until the host is decided. See README.
