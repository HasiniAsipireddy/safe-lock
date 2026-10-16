# CLAUDE.md — Smart Safe Lock Platform

## Project Overview
A web platform (mobile-first, later converted to a mobile app) to remotely lock/unlock a physical smart safe.

**Core flow**
1. User signs up and logs in.
2. User pays a one-time amount via **Razorpay**.
3. After verified payment, admin/system **allocates a safe lock** (device) to the user.
4. User opens the dashboard and sees their safe with its status (Locked / Unlocked / Offline).
5. **Lock:** user taps "Lock" -> command is sent to the device.
6. **Unlock:** user taps "Unlock" -> an **OTP is sent** (SMS/email) -> user enters OTP -> if valid, unlock command is sent to the device.
7. Hardware integration comes later; build the software layer behind a **device abstraction** so a mock device works now and the real one plugs in later.

## Tech Stack (defaults — change if needed)
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS. Mobile-first, PWA-friendly. Keep all business logic in the backend so the future mobile app (React Native / Flutter) can reuse the same API.
- **Backend:** Node.js + Express + TypeScript, REST API under `/api/v1`.
- **Database:** PostgreSQL with Prisma ORM.
- **Auth:** Email/phone + password (argon2id). Short-lived JWT access token (15 min, `Path=/`) + **opaque, hashed, rotating** refresh token (7 days, `Path=/api/v1/auth`), both in httpOnly cookies. See "Session & Auth Rules" below.
- **Payments:** Razorpay (Orders API + Checkout + Webhooks).
- **OTP delivery:** SMS provider (MSG91 / Twilio) behind a `NotificationService` interface; email fallback.
- **Device comms (later):** MQTT over TLS (e.g. EMQX / HiveMQ / AWS IoT Core). Use a mock device driver until hardware is ready.
- **Hosting:** any; keep config in environment variables.

## Folder Structure
```
/apps
  /web            # Next.js frontend
  /api            # Express backend
/packages
  /shared         # shared types, zod schemas, constants
CLAUDE.md
```
Backend layout (`/apps/api/src`):
```
config/        env loading + validation (zod)
modules/
  auth/
  users/
  payments/    # Razorpay order, verify, webhook
  devices/     # safe locks, allocation
  commands/    # lock/unlock requests
  otp/
  audit/
lib/
  razorpay.ts
  mqtt.ts
  deviceDriver/  # interface + MockDriver + MqttDriver
middleware/    # auth, rateLimit, validate, errorHandler
```

## Data Model (Prisma — starting point)
- **User**: id, name, email, phone, passwordHash, role (`USER` | `ADMIN`), createdAt
- **Payment**: id, userId, razorpayOrderId (unique), razorpayPaymentId (nullable, unique), amount (paise, Int), currency, status (`CREATED` | `PAID` | `FAILED` | `REFUNDED`), paidAt, createdAt
  — **the signature is verified and discarded, never stored**: keeping it buys nothing and
  widens what a database leak exposes.
- **WebhookEvent**: id, eventId (unique — Razorpay's `x-razorpay-event-id`), type, processedAt
  — the idempotency ledger. An event id already present is acknowledged and dropped.
- **Device** (safe lock): id, serialNumber (unique), status (`UNASSIGNED` | `ASSIGNED` | `RETIRED`), lockState (`LOCKED` | `UNLOCKED` | `UNKNOWN`, **default `LOCKED`**), lockStateUpdatedAt, online (bool), lastSeenAt, **ownerId (nullable, UNIQUE — one device per user)**, allocatedAt, credentialHash (nullable, reserved for the hardware phase)
  — `credentialHash` is **never populated or returned** today and appears in no `select` list.
  The unique `ownerId`, not just a service check, is what makes concurrent allocation safe.
  — An **allocated** device is never `UNKNOWN`: allocation sets `LOCKED`, unassign sets
  `UNKNOWN`. `lockStateUpdatedAt` is the last **acked** state change, so it stays null
  through allocation — neither of those is a device ack.
- **UnlockChallenge**: id, userId, deviceId, otpHash, expiresAt, attempts, consumedAt, createdAt
  — only `HMAC-SHA256(code, OTP_HMAC_SECRET)` is stored. A 6-digit space is 10^6, so a
  slow hash buys nothing; the key living outside the database is what protects it.
  A new request **consumes any older open challenge**, so one code is live at a time.
- **DeviceEvent**: id, deviceId, userId, type (`LOCK` | `UNLOCK_REQUESTED` |
  `UNLOCK_CONFIRMED` | `UNLOCK_FAILED`), source (`WEB`), failureReason
  (`WRONG_CODE` | `EXPIRED` | `TOO_MANY_ATTEMPTS` | `NO_CHALLENGE`, nullable),
  requestId, createdAt
  — the **user-visible** activity feed `/history` reads, indexed on
  `[userId, createdAt, id]`. Distinct from `AuditLog`, the internal security trail.
  — `requestId` is **internal**: it is in no `select` the history endpoint uses.
  `failureReason` is null on rows written before the column existed; those render
  as a generic "Unlock failed" and are **not** backfilled.
  — The index carries `id` because `/history` is keyset-paginated on
  `(createdAt DESC, id DESC)`; `createdAt` alone is not unique.
- **Notification**: id, userId, type (`UNLOCK_CONFIRMED` |
  `UNLOCK_FAILED_MAX_ATTEMPTS`), deviceEventId (nullable), createdAt, readAt
  — written **in the same transaction** as the event it describes, through the
  `Notifier` seam, so neither can exist without the other. Its own enum, not
  `DeviceEventType`: most device events notify nobody. Holds **no message text** —
  copy comes from `NOTIFICATION_COPY` in `@safelock/shared` at render time.
- ~~**Command**~~ — **deferred to the MQTT gateway.** The mock acks synchronously, so
  there is nothing in flight to track and nothing to time out. Command ids/nonces and the
  15s timeout land with it. See `docs/decisions.md`.
- **RefreshToken**: id, userId, tokenHash (unique — sha256 of an opaque token; the raw value is never stored), familyId, expiresAt, revokedAt, replacedById, graceUsedAt, userAgent, ip, createdAt
- **AuditLog**: id, userId, deviceId, action, ip, userAgent, metadata (json), createdAt

## Business Rules
- A user cannot be allocated a device until a payment is **verified server-side** (status `PAID`).
- One device belongs to one user at a time, and **a user owns at most one device**
  (unique `Device.ownerId`). Same answer as the payment rule, which refuses a second
  order once a user has a `PAID` payment.
- **All allocation goes through `allocateDevice(userId, deviceId?)`** — one function, so
  the admin endpoint and (later) webhook auto-allocation cannot drift. Omit `deviceId`
  for "next available", which picks the oldest `UNASSIGNED` row under
  `FOR UPDATE SKIP LOCKED` so two admins never collide.
- Allocation is **manual by an ADMIN today**; the seam for automatic allocation from the
  payment webhook is in place. See `docs/decisions.md`.
- Retiring an `ASSIGNED` device is refused (`DEVICE_STILL_ASSIGNED`) — unassign first, so
  hardware is never retired out of a user's hands.
- **A refund does not reclaim the device.** `hasPaid: false` with
  `deviceAllocated: true` is a real state: the dashboard shows an explicit
  "payment refunded" state with no controls, and the admin Users tab flags the row.
  Reclaiming is a deliberate admin action.
- **Locking** requires an authenticated session + ownership check — and, per the refund
  state above, must **also** require a paid user. Neither condition implies the other.
- **Unlocking** ALWAYS requires a valid OTP, on top of paid + ownership. No exceptions,
  no bypass flags in production.
- Every lock/unlock attempt (success or fail) is written to `AuditLog`.
- Admin responses are an **explicit allow-list** via Prisma `select` — never whole rows.
  No password hashes, token hashes or `credentialHash`, ever.
- Audit metadata holds ids, counts and error codes only; the audit service drops any
  key matching `email|phone|password|secret|token|hash`. **Failed** admin actions are
  audited too, with the error code.

## Razorpay Integration Rules
- Keys in env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. **Never expose the key secret to the frontend**; only `KEY_ID` goes to the client.
- Amounts are in **paise** (INR x 100). Store integers, never floats.
- Flow:
  1. `POST /api/v1/payments/order` -> backend creates a Razorpay order (`razorpay.orders.create`) and saves a `Payment` row with `CREATED`.
  2. Frontend opens Razorpay Checkout with the returned `orderId`.
  3. On success, frontend calls `POST /api/v1/payments/verify` with `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`.
  4. Backend verifies signature: HMAC-SHA256 of `order_id + "|" + payment_id` using the key secret; compare with `crypto.timingSafeEqual`. Only then mark `PAID`.
  5. **Webhook** `POST /api/v1/payments/webhook` (events `payment.captured`, `payment.failed`, `refund.processed`): verify `X-Razorpay-Signature` against the **raw request body** using the webhook secret. Webhook is the source of truth — it must be **idempotent** (ignore events already processed).
- Never trust the frontend's claim that payment succeeded.
- Use Razorpay **test mode** keys in development; test cards/UPI are in Razorpay docs.
- Handle refunds/failed payments: do not allocate (or revoke allocation per policy).

## Session & Auth Rules
- **Access token**: signed JWT, 15 min, cookie `safelock_at` at `Path=/`. Stateless.
- **Refresh token**: 32 opaque random bytes, 7 days, cookie `safelock_rt` at
  **`Path=/api/v1/auth`** so it is never sent to payment/device/admin routes.
  Only `sha256(token)` is stored — a JWT was rejected because it cannot be revoked.
- **Rotation**: `POST /auth/refresh` revokes the presented token and issues a
  successor in the same `familyId` (one login = one family), linked by `replacedById`.
- **Reuse detection**: replaying a rotated token after the grace window — or a
  second time — revokes the whole family *and* every other refresh token for that
  user, audits `REFRESH_REUSE_DETECTED`, and returns 401.
- **Grace window**: `REFRESH_GRACE_WINDOW_MS` (10s, in `refreshToken.service.ts`).
  A replay inside it mints **one** sibling in the family (two tabs racing), tracked
  by `graceUsedAt` and audited as `REFRESH_GRACE_USED`. **Set to 0 to disable.**
  Applies only to tokens revoked *by rotation* — never to a logout or cascade
  revocation. Tradeoff documented in `docs/decisions.md`.
- **Logout** revokes the presented refresh token server-side, then clears cookies.
  Cookies must be cleared with the same `Path` they were set with.
- Cookies are `httpOnly`, `sameSite=lax`, `secure` in production. **This requires
  web and API to be same-site in production.** The mobile app will need a bearer
  token flow, not cookies.
- **CSRF**: `originCheck` on every POST/PUT/PATCH/DELETE except the Razorpay
  webhook. Exact string match against `WEB_ORIGIN` — **never** a prefix or regex.
  Missing `Origin` + auth cookies → 403 `CSRF_ORIGIN_REJECTED`.
- **Rate limiting**: login/signup carry two limbs — per IP and per
  `sha256(lowercased identifier)`. The 429 must be identical whether or not the
  account exists. Limiters are **not** skipped in tests; build an app with small
  limits instead.
- **Request IDs**: `X-Request-Id` honoured if it matches `[A-Za-z0-9._-]{1,64}`,
  else generated. Present in every log line, every error body (`error.requestId`)
  and the response header. Never log request bodies on auth routes.

## OTP Rules (Unlock)
- 6-digit numeric code generated with `crypto.randomInt`, **not** `Math.random`.
- Store only a **hash** (HMAC/bcrypt) of the OTP, never plaintext.
- Expiry: 5 minutes. Single-use (set `consumedAt` on success).
- Max 5 wrong attempts per OTP, then invalidate it.
- Rate limit OTP sending: e.g. max 3 requests / 10 minutes / user, plus per-IP limit.
- OTP is bound to `userId` + `deviceId` + purpose; reject if any mismatch.
- Never log OTPs or return them in API responses. The dev console print is guarded by
  `mayPrintOtp(NODE_ENV)` in `otp.service.ts` — true only for `development`/`test`, so an
  unset or misspelled `NODE_ENV` falls through to silence, not to printing a code.
- A new request **invalidates the previous challenge**, so exactly one code is ever live.
  Without that, "5 attempts per challenge" silently becomes "5 attempts per request".
- Endpoints (no device id in the path — the device is resolved from the session, so
  there is no id a caller could substitute):
  - `POST /api/v1/devices/unlock/request`
  - `POST /api/v1/devices/unlock/confirm` `{ otp }` -> on success sends the unlock command.
- Failures are **400s with distinct codes** (`OTP_INVALID`, `OTP_EXPIRED`,
  `OTP_TOO_MANY_ATTEMPTS`, `OTP_NOT_FOUND`) — not 429 for the attempt limit, which the
  client reads as "back off and retry" when the challenge is in fact dead.

## Device / Hardware Layer
Define one interface and keep everything else hardware-agnostic
(`apps/api/src/lib/deviceGateway/`):
```ts
interface DeviceGateway {
  readonly name: string;
  sendLock(serialNumber: string): Promise<DeviceCommandResult>;
  sendUnlock(serialNumber: string): Promise<DeviceCommandResult>;
}
```
- **Two methods, not one `sendCommand(type)`** — unlocking has a precondition
  (a verified OTP) that locking does not, and the asymmetry should be visible
  at every call site.
- **The interface takes a serial number and nothing else**: no user, no payment
  state, no request. Authorisation is settled before anything reaches a gateway.
- `MockDeviceGateway` (now): small delay, **always acks** — a flaky mock makes
  every test flaky. Selected by `DEVICE_GATEWAY=mock`.
- `MqttGateway` (later): topics like `safes/{serial}/cmd` and `safes/{serial}/state`; TLS + per-device credentials/certs; device sends an **ack** with the command id.
- Commands will be time-limited (e.g. 15s). If no ack -> mark `TIMEOUT` and show the user "device not responding". **Not built yet** — see the `Command` note above.
- Commands must include a nonce/command id + timestamp to prevent replay. **Also deferred**: the mock cannot lose or replay a message.
- UI reflects real state from the device ack, not "button pressed": `lockState`
  only moves when a command is **acked**, and the dashboard renders what the
  server returned rather than an optimistic guess.

## Activity History & Notifications
- `GET /api/v1/devices/history?cursor=&limit=` — the caller's own events, newest
  first. **Cursor-based, not offset-based** (default 20, max 50): the feed is
  append-only, and an offset duplicates rows across pages as new events land.
  The cursor is an opaque `base64url("<iso>|<id>")`; a malformed, tampered or
  oversized one is a **400 `INVALID_CURSOR`**, never a silent full scan.
- **No eligibility gate on history or notifications** — `requireAuth` only. A
  user awaiting allocation and a refunded user both read their own record and
  get an **empty list, not an error**. Do not add `requirePaid` here.
- `GET /api/v1/notifications` (unread first, with the **total** unread count,
  not the page's) and `POST /api/v1/notifications/read` `{ ids? }` — idempotent;
  ids that are not the caller's are ignored, never 403'd.
- **What notifies:** `UNLOCK_CONFIRMED`, and `UNLOCK_FAILED` only once the
  attempt limit is burned. **Not** a single wrong code, not `UNLOCK_REQUESTED`,
  not `LOCK`. Rationale in `docs/decisions.md` — a notification per typo trains
  people to ignore the bell.
- Notifications go through `Notifier` (`apps/api/src/lib/notifier/`), whose
  `notifyUnlock(client, event)` **takes the transaction client**. WhatsApp
  (step 4) must write an outbox row through it rather than sending inline — a
  rollback cannot unsend a message.
- The web client **polls** `/notifications` every 60s while the tab is visible,
  pauses when hidden, and fetches immediately on becoming visible. No websockets.
- Event retention is **undecided and nothing deletes events** — see the open
  questions.

## API Conventions
- Base path `/api/v1`, JSON only, consistent error shape: `{ "error": { "code": "...", "message": "..." } }`.
- Validate every request body/query with **zod**.
- Authorization on every device route: confirm `device.ownerId === req.user.id`.
- Use proper HTTP codes (401 unauthenticated, 403 forbidden, 404, 409 conflict, 429 rate limit).
- Keep controllers thin; put logic in services.

## Security Requirements (this is a physical-security product — be strict)
- HTTPS only; secure, httpOnly, sameSite cookies; CORS restricted to known origins.
- Hash passwords with argon2/bcrypt; enforce a minimum password strength.
- Rate limit login, signup, OTP, and command endpoints; add account lockout/backoff for repeated failures.
- Helmet, input sanitization, parameterized queries (Prisma handles this).
- Secrets only in env vars, never committed. Provide `.env.example` with placeholder values.
- Don't hardcode any device secrets or master unlock codes.
- Log security events (failed logins, failed OTPs, unlocks) to `AuditLog`; notify the user on every unlock.
- Optional later: 2FA for login, geofence/new-device alerts, emergency/manual override via physical key (hardware side).

## Frontend Pages
- `/signup`, `/login`
- `/pay` — plan/price + Razorpay Checkout
- `/dashboard` — safe status card, Lock / Unlock buttons, last activity
- `/dashboard/unlock` — OTP entry (6 input boxes, resend timer 30s)
- `/history` — activity log, grouped by local day, "Load more" (not infinite
  scroll — an endless list has no end for a keyboard or screen reader user).
  Rows are icon **plus** text, never colour alone. The unread bell lives in
  `AppHeader`.
- `/admin` (role ADMIN) — payments list, device inventory, allocate device
- UX: big touch-friendly buttons, clear status colors, loading/disabled states while a command is pending, confirm dialog on Lock.

## Environment Variables
Authoritative copies: `apps/api/.env.example` and `apps/web/.env.example`.

Backend (`apps/api/.env`):
```
NODE_ENV=development
PORT=4000
WEB_ORIGIN=http://localhost:3000   # exact-match allowlist; CORS_ORIGINS is a legacy alias
TRUST_PROXY=false                  # only `true`/hop-count when actually behind a proxy
LOG_LEVEL=info
SEED_ADMIN_EMAIL=                  # db:seed; password must be 12+ chars, no default
SEED_ADMIN_PASSWORD=
SEED_ADMIN_NAME=
SEED_ADMIN_PHONE=
# SEED_ALLOW_PRODUCTION=true       # required for db:seed when NODE_ENV=production
# Dev DB runs in Docker on host port 5433 (see docker-compose.yml) to avoid
# clashing with a local PostgreSQL install on 5432.
DATABASE_URL=postgresql://safelock:safelock_dev_only@localhost:5433/safelock
TEST_DATABASE_URL=postgresql://safelock:safelock_dev_only@localhost:5433/safelock_test
JWT_ACCESS_SECRET=change_me   # signs the access token only
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=7      # refresh tokens are opaque, not signed
# JWT_REFRESH_SECRET          # legacy, unused — refresh tokens are not JWTs
SAFE_PRICE_PAISE=99900        # paise; the ONLY source of the price
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx
OTP_HMAC_SECRET=change_me     # REQUIRED, 32+ chars; keys the unlock-code HMAC.
                              # Keep it separate from JWT_ACCESS_SECRET.
DEVICE_GATEWAY=mock           # mock (only value today; mqtt arrives with hardware)
# Not yet used — added with WhatsApp delivery and the MQTT gateway:
# SMS_PROVIDER_API_KEY=xxxxx
# MQTT_URL=mqtts://broker.example.com
# MQTT_USERNAME=
# MQTT_PASSWORD=
```

Frontend (`apps/web/.env.local`):
```
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_USE_MOCK_API=true
```
There is no `NEXT_PUBLIC_RAZORPAY_KEY_ID`: the key id comes back from
`POST /payments/order`, so the browser holds no payment config of its own.

## Commands
This repo uses **npm workspaces** (not pnpm) — see `docs/decisions.md`.
Target runtime is **Node 22 LTS** (`.nvmrc`, root `package.json` `engines`).
Setup and Razorpay/webhook instructions are in `README.md`.
```
npm install
npm run db:up                                # PostgreSQL 16 in Docker, host port 5433
npm run dev:api                              # tsx watch, :4000  (separate terminal)
npm run dev:web                              # next dev,   :3000  (separate terminal)
npm --workspace apps/api run prisma:migrate  # prisma migrate dev
npm --workspace apps/api run db:seed         # create/update the ADMIN from SEED_ADMIN_*
npm --workspace apps/api run db:cleanup-tokens  # prune dead refresh tokens
npm test                                     # vitest + supertest against safelock_test
npm run lint && npm run typecheck            # runs across all workspaces
```
Dependencies are **pinned exactly** (`.npmrc` → `save-exact=true`). Do not
reintroduce carets in `apps/api`, and keep `zod` on the same exact version in
all three workspaces — two copies break schema type assignability.
There is no root `dev` that runs both servers: `&` backgrounding is not
portable to PowerShell, so use two terminals.

## Coding Guidelines for Claude
- Use TypeScript strict mode; no `any` unless justified.
- Small, focused files and functions; shared types live in `/packages/shared`.
- Write tests for: payment signature verification, webhook idempotency, OTP generation/expiry/attempt limits, device ownership checks, and command timeout handling.
- Before adding a new dependency, check if existing ones cover it.
- Never weaken a security rule (OTP requirement, signature verification, ownership checks) to make something "work" — ask first.
- When unsure about a requirement (pricing, number of devices per user, refund policy, OTP channel), ask rather than assume. Record decisions in `/docs/decisions.md`.
- Make small, reviewable commits; update this file when architecture decisions change.

## Open Questions (to decide)
- ~~Price and plan structure~~ → **provisionally** one-time ₹999 (`SAFE_PRICE_PAISE=99900`),
  changeable via env. Confirm the real figure and whether GST is included.
- **OTP channel — still open and now user-facing.** Codes are currently printed to the
  API console only, so unlock works in development and **not in production**:
  `deliverOtp` logs a warning and sends nothing there. WhatsApp vs SMS vs email needs
  deciding before launch. One function body to change.
- ~~Auto-allocation vs manual admin allocation~~ → **manual by ADMIN now**, with
  `allocateDevice()` ready for the webhook to call. Decide when to switch it on.
- **Serial number format is provisional** (`^SAFE-[0-9A-Z]{4,12}$`). Confirm what the
  units are actually stamped with, and whether the serial is also the device's MQTT
  identity, **before ordering hardware** — changing it later means a migration plus
  re-labelling stock.
- Should a refund auto-reclaim the device? Currently **no** (flagged for an admin
  instead) — tied to the refund policy question below.
- Admin list page size is 20 (max 100). Confirm if that is wrong for real volumes.
- Hardware protocol finalized? (MQTT vs HTTP/WebSocket, Wi-Fi vs GSM module)
- **Refund / device return policy — still open, and now blocking.** `/refund-policy`
  is a published placeholder; the 11 decisions needed are listed on that page and in
  `apps/web/src/app/refund-policy/page.tsx`.
- **How long should `DeviceEvent` rows be retained? — open, nothing deletes them.**
  The activity feed is the user-visible security record of a physical safe, so
  "keep forever" and "prune after N months" are both defensible and the choice is
  a policy one. Needs deciding: a retention period (if any), whether a user may
  delete their own history (probably not — it is a security log), and what
  happens to `Notification` rows pointing at a pruned event (`deviceEventId` is
  already `onDelete: SetNull`). Related: `AuditLog` has no retention policy
  either, and refresh tokens are pruned at 30 days by `db:cleanup-tokens`.
- Number of safes per user? (The API currently refuses a second order once a user has
  one `PAID` payment, which implies **one**.)
- Business details for the legal pages: `[BUSINESS NAME]`, `[ADDRESS]`, `[EMAIL]`,
  `[PHONE]`, GSTIN, support hours, grievance officer.

## Roadmap
1. ✅ Auth + user model — argon2id, rotating opaque refresh tokens with reuse
   detection, `/auth/signup|login|refresh|logout|me`, Origin check, two-limb rate
   limiting, pino + request ids, DB-backed `/health`, ADMIN seed script
2. ✅ Razorpay payment (test mode) + webhook — order / verify / webhook / `payments/me`,
   `requirePaid` middleware, legal pages
3. ✅ Device inventory + allocation (admin) — `Device` model, `allocateDevice` with
   SKIP LOCKED, `requireAdmin`, `/admin` panel (devices / users / payments / audit),
   `GET /devices/mine`, dashboard allocation states
4. ✅ Lock/Unlock flow with OTP using `MockDeviceGateway` — `assertCanOperate`
   (paid AND assigned, with `REFUNDED_CONTACT_SUPPORT` kept distinct from
   `NOT_PAID`), `POST /devices/lock|unlock/request|unlock/confirm`, HMAC'd
   single-use codes, `DeviceEvent` + `AuditLog` on every state change,
   row-locked transactions, dashboard controls and OTP dialog
5. ✅ Activity history + unlock notifications — `GET /devices/history` with
   cursor pagination and strict cursor validation, `DeviceEvent.failureReason`,
   a `Notification` table written through the `Notifier` seam inside the
   unlock transaction, `/notifications` list + idempotent mark-read, the
   `/history` page and a polling header bell. Retention is still open.
6. Real hardware via MQTT — also brings the `Command` table, command nonces and the
   15s ack timeout, all deliberately deferred until there is a transport that can
   lose a message
7. Convert to mobile app (reuse `/api/v1`)

**Postponed (deliberately not built):** WhatsApp/SMS phone verification. There
is no `phoneVerifiedAt` column and no `requireVerifiedPhone` middleware. The
places it will hook in are marked `TODO(phone-verification)` in
`apps/api/src/modules/payments/payments.routes.ts` and the Prisma schema.