# CLAUDE.md — Smart Safe Lock Platform

## Project Overview
A web platform (mobile-first, later converted to a mobile app) to **rent** a
physical smart safe by the hour and lock/unlock it remotely.

**Core flow**
1. User signs up and logs in.
2. User picks how many hours they need and **books a safe**. The safe is held
   while they pay; the clock starts when the money lands, not when they booked.
3. They pay for the booking via **Razorpay**. A verified payment is the only
   thing that makes a booking `ACTIVE`.
4. The dashboard shows their safe, its status (Locked / Unlocked / Offline) and
   the time left.
5. **Lock:** user taps "Lock" -> command is sent to the device.
6. **Unlock:** user taps "Unlock" -> an **OTP is sent** (WhatsApp) -> user
   enters OTP -> if valid, unlock command is sent to the device.
7. **Extend** (more hours) or **collect** ("I've got my things"), which ends
   the booking and returns the safe.
8. Run over and an **overstay fee** accrues after a grace period. The safe will
   not open until it is paid; locking still works.
9. Hardware integration comes later; build the software layer behind a **device
   abstraction** so a mock device works now and the real one plugs in later.

**Nobody owns a safe.** There is no one-time purchase, no `Device.ownerId` and
no admin allocation — those were the purchase model, replaced on 2026-10-17.
See `docs/decisions.md`.

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
- **User**: id, name, email, phone, passwordHash, role (`USER` | `ADMIN`), createdAt, **phoneVerifiedAt**, **whatsappConsentAt**, **whatsappConsentVersion**
  — `phone` stays **required and unique** in its 10-digit national form; E.164
  is derived at the delivery boundary. Nullable phone / email-only signup is a
  deliberate non-goal (`docs/decisions.md`). `phoneVerifiedAt` null means **no
  unlock and no WhatsApp message of any kind**; locking is still allowed.
- **Booking**: id, userId, deviceId, status (`PENDING_PAYMENT` | `ACTIVE` |
  `OVERSTAY` | `COMPLETED` | `CANCELLED` | `EXPIRED_UNPAID`), hours, startsAt,
  endsAt (nullable), holdExpiresAt (nullable), reservedUntil, pricePaise,
  currency, **the rate snapshot** (hourlyRatePaise, overstayMultiplierBps,
  graceMinutes, capHours, collectionWindowMinutes), overstaySettledAt,
  overstayPaidPaise, overstayWaivedAt, completedAt, completionReason
  (`COLLECTED` | `COLLECTION_WINDOW_LAPSED` | `ADMIN_FORCE_COMPLETED`,
  nullable), adminNote, timestamps
  — **one rental of one safe**, and the thing that grants all access. Two raw-SQL
  constraints do the real work (see Business Rules): the gist exclusion
  constraint over `tsrange(startsAt, reservedUntil)` and the one-live-per-user
  partial unique index.
  — `endsAt` is **null while pending**: the clock starts when the money lands.
  `reservedUntil` is the overlap constraint's upper bound and covers the grace
  period and collection window too — the safe may still hold someone's
  belongings for all of it. The sweeper pushes it out during an overstay.
  — The rate snapshot exists so **config changes never re-price a live
  booking**. `overstayMultiplierBps` is basis points (15000 = 1.5x); money
  never touches a float.
  — `overstayWaivedAt` is deliberately separate from `overstaySettledAt`, and
  a waive leaves `overstayPaidPaise` at zero. A write-off must not look like
  revenue.
- **Payment**: id, userId, razorpayOrderId (unique), razorpayPaymentId (nullable, unique), amount (paise, Int), currency, status (`CREATED` | `PAID` | `FAILED` | `REFUNDED`), paidAt, **purpose** (`BOOKING` | `EXTENSION` | `OVERSTAY`), **bookingId** (nullable), **quoteExpiresAt**, **reviewReason**, **reviewClearedAt**, createdAt
  — **the signature is verified and discarded, never stored**: keeping it buys nothing and
  widens what a database leak exposes.
  — every payment belongs to a booking; `purpose` is NOT NULL. There is no
  account-level activation any more.
  — `reviewReason` (`BOOKING_EXPIRED_DEVICE_TAKEN` | `OVERSTAY_QUOTE_EXPIRED` |
  `BOOKING_NO_LONGER_PAYABLE`) marks **real money we took and could not
  apply**. The row stays `PAID` — never pretend otherwise — and is listed for
  an admin to refund by hand.
  — `quoteExpiresAt` is set for an `OVERSTAY` payment: the fee grows while the
  user is at the checkout, so the quote is binding for a bounded window and the
  Razorpay order carries the same `expire_by`.
- **WebhookEvent**: id, eventId (unique — Razorpay's `x-razorpay-event-id`), type, processedAt
  — the idempotency ledger. An event id already present is acknowledged and dropped.
- **Device** (safe lock): id, serialNumber (unique), status (`AVAILABLE` | `NEEDS_INSPECTION` | `RETIRED`), lockState (`LOCKED` | `UNLOCKED` | `UNKNOWN`, **default `LOCKED`**), lockStateUpdatedAt, online (bool), lastSeenAt, **inspectionNote**, **inspectionNotedAt**, credentialHash (nullable, reserved for the hardware phase)
  — `credentialHash` is **never populated or returned** today and appears in no `select` list.
  — **Nobody owns a device.** `ownerId` and `allocatedAt` are gone with the
  purchase model: a safe is occupied for the duration of a `Booking` and free
  otherwise, and the exclusion constraint on `Booking` is what makes concurrent
  booking safe.
  — `NEEDS_INSPECTION` means a booking ended without the renter confirming
  collection, so the contents are unknown. **Not bookable** until an admin
  clears it with a required note. `MAINTENANCE` can wait for hardware.
  — `lockStateUpdatedAt` is the last **acked** state change. Clearing an
  inspection asserts `LOCKED` without touching it: that is a claim about
  process, not a state the hardware confirmed.
  — **also, with the hardware:** `doorState` (`CLOSED` | `OPEN` | `UNKNOWN`),
  `commandSeq`, `commandKeyVersion`, `credentialIssuedAt`, `firmwareVersion`,
  `rssi`, `clockSynced`, `bootId`, `lockCommandFailedAt`, `unexpectedUnlockAt`.
  — `doorState` is **distinct from `lockState`**: a bolt can be extended with
  the door standing open, and the completion flow has to tell those apart.
  `UNKNOWN` means *we do not know* — a failed sensor or firmware mid-boot —
  and never "there is no sensor", which is now an unsupported configuration.
  A unit reporting it is flagged and excluded from the booking pick.
  — `commandSeq` is allocated under the device row lock, which is what makes it
  monotonic under concurrency: two tabs tapping Unlock would otherwise be
  handed the same number and the device would reject the second as a replay.
  — `rssi` exists because a metal safe is a Faraday cage and the likeliest
  field failure is a unit on the edge of Wi-Fi range. `clockSynced` gates
  **nothing** — replay protection is the sequence number, so a device with no
  time source is not degraded — and is shown to admins anyway.
  — `credentialHash` **is** populated now, by
  `POST /admin/devices/:id/credential`, and is still in no `select` list and
  returned by nothing. Nulled on retirement.
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
- **PhoneVerification**: id, userId, phoneE164, otpHash, expiresAt, attempts, consumedAt, requestedIp, userAgent, createdAt
  — the **candidate** number lives here and only reaches `User.phone` on
  confirmation, so changing a verified number leaves the old one live and
  receiving codes until the new one is proved. Same HMAC, TTL and attempt
  limit as `UnlockChallenge`; a new request supersedes the old one.
- **OutboundMessage**: id, userId, kind, status (`PENDING` | `SENT` | `FAILED` |
  `SKIPPED`), attempts, failureCategory, nextAttemptAt, **sendAt**,
  **bookingId**, **dedupeKey** (unique), providerMessageId
  (unique), deliveryStatus, deliveryUpdatedAt, deviceEventId, timestamps
  — the WhatsApp outbox. Written **inside** the unlock transaction by
  `WhatsAppNotifier` (a local insert, so still atomic) and sent by a poll
  worker **after** the commit, so a WhatsApp outage cannot stop a safe from
  opening. **Holds no message text and no template parameters** — they are
  rebuilt at send time, which is why a one-time code can never be queued.
  `SKIPPED` is terminal and distinct from `FAILED`: nothing was attempted.
  — **`sendAt` is a due time and never moves**; `nextAttemptAt` is retry
  backoff and only moves forward. The claim query requires both to have
  elapsed, so a backoff can never pull a message earlier than its due time.
  — a row with a `bookingId` is **re-validated against the live booking before
  it is sent**, and `dedupeKey` (`<bookingId>:<kind>:<discriminator>`) makes
  scheduling idempotent without a prior read — the discriminator is `endsAt`,
  a payment id or the due time, deliberately never `now`.
  — skip reasons `CANCELLED` (a state change withdrew it), `NOT_APPLICABLE`
  (re-validation refused it) and `STALE` (claimed too late to be true) are
  kept distinct: which guard fired is the diagnostic.
- **Command**: id, deviceId, bookingId (nullable), type (`LOCK` | `UNLOCK`),
  status (`PENDING` | `SENT` | `ACKED` | `REJECTED` | `FAILED` | `TIMED_OUT` |
  `EXPIRED` | `CANCELLED`), seq, attempts, issuedAt, expiresAt, sentAt,
  ackedAt, **lateAckedAt**, failureCategory, userId (nullable), **systemActor**
  (`COMPLETION` | `SWEEPER` | `ADMIN`, nullable), **challengeId** (nullable)
  — one instruction to one safe, and the row that makes "we asked" a different
  fact from "it happened". Built with the MQTT gateway, as planned: a mock that
  acks in process has nothing in flight to track.
  — **`@@unique([deviceId, seq])`** is the database insisting on what the row
  lock computes. `seq` is monotonic per device and the device rejects anything
  at or below the highest it has seen, so a captured command cannot be
  replayed — its number is spent. Gaps are fine; the device requires
  *increasing*, not contiguous.
  — `EXPIRED` and `TIMED_OUT` are deliberately distinct. `TIMED_OUT` means we
  reached the safe and it never answered, so its state is **unknown**;
  `EXPIRED` means the command never left the building, so we know nothing
  moved. One needs reconciling, the other a retry.
  — exactly one of `userId` and `systemActor` is set, and that is the test for
  "is anyone waiting on this". **A user command is never retried**; a system
  `LOCK` is (10s, 60s, 300s, three attempts).
  — `lateAckedAt` records that we had already given up when the answer came. A
  dashboard saying "failed" and a row saying `ACKED` would otherwise be an
  unexplainable contradiction.
  — `challengeId` is the **immutable** record of which code bought this
  command, which is what lets a late `OK` still consume a code the timeout had
  released. See `docs/device-protocol.md` §5.5.
- **RefreshToken**: id, userId, tokenHash (unique — sha256 of an opaque token; the raw value is never stored), familyId, expiresAt, revokedAt, **revokedReason** (`ROTATED` | `LOGOUT` | `PASSWORD_CHANGE` | `PASSWORD_RESET` | `REUSE_CASCADE`, nullable), replacedById, graceUsedAt, userAgent, ip, createdAt
  — `revokedReason` exists for exactly one decision: whether a replay is
  **theft**. `PASSWORD_CHANGE` / `PASSWORD_RESET` replays are not. Null on rows
  revoked before the column existed, and null means "treat as theft".
- **PasswordResetCode**: id, userId, codeHash, expiresAt, attempts, consumedAt, requestedIp, userAgent, createdAt
  — an **8-digit** one-time code, stored as
  `HMAC-SHA256("pwreset:v1:" + code, OTP_HMAC_SECRET)`. **Keyed**, unlike the
  32-byte token it replaces, and for the same reason that one was not: 10^8 is
  enumerable, 2^256 is not. The `pwreset:v1:` prefix is domain separation, so a
  reset digest can never equal an unlock digest for the same digits.
  **No new env var.** See `docs/decisions.md`.
  — `attempts` is **load-bearing**: 8 digits is only safe because five guesses
  is five guesses. Incremented by a conditional update whose `where` carries
  the limit, so the check and the increment are one statement and the correct
  code also fails once they are gone.
  — Requesting a reset **consumes any older open code**, so one is live at a
  time. Redeeming one revokes every refresh token for the user.
- **AuditLog**: id, userId, deviceId, action, ip, userAgent, metadata (json), createdAt

## Business Rules
- **No two bookings may occupy one safe at the same time**, and that is a
  Postgres **exclusion constraint** (`Booking_device_no_overlap`), not a service
  check. The service checks too, but a check is a read followed by a write and
  two concurrent bookings can both pass the read. The constraint is what is true
  under concurrency — the same reasoning the old unique `Device.ownerId` had.
- **One live booking per user**, enforced by a partial unique index
  (`Booking_one_live_per_user`). This is what closes the obvious abuse of
  holding a safe before paying.
- **The safe is held from creation, and the clock starts at payment.**
  `PENDING_PAYMENT` reserves it for `BOOKING_HOLD_MINUTES`; `endsAt` is null
  until the money lands and is then set to `paidAt + hours`, so a slow checkout
  never eats purchased time. The hold still reserves the *whole intended
  window*, or the payment would have nowhere to land.
- **Status is derived from the server clock on every read**
  (`effectiveBookingStatus`). The sweeper is a reconciler, not an authority:
  a late, wedged or never-run sweeper cannot make a safe unlockable. **Clients
  must branch on `effectiveStatus`, never `status`.**
- **A booking becomes `ACTIVE` only from a verified payment.** Nothing a client
  sends can do it, and settlement happens in the same transaction that marks
  the `Payment` row `PAID`.
- **Only `COLLECTED` returns a safe to the pool.** A lapsed collection window
  or an admin force-complete leaves the contents **unknown**, so the device goes
  to `NEEDS_INSPECTION` and is unbookable until an admin clears it with a
  required, audited note. Handing the next renter a safe containing someone
  else's property — with the ability to unlock it — is the failure this
  prevents.
- **An unpaid overstay is never completed automatically.** The fee is capped,
  the safe stays reserved, and the row appears in the admin flagged list. See
  `docs/decisions.md` and the abandoned-items open question.
- **Collect is refused while an overstay fee is outstanding**
  (`OVERSTAY_PAYMENT_REQUIRED`, 402). The fee is the only leverage the product
  has. Allowed from `ACTIVE`, and from `OVERSTAY` once settled or waived.
- Retiring a safe with a live booking is refused (`DEVICE_HAS_LIVE_BOOKING`) —
  force-complete first, so hardware is never retired out of a renter's hands.
- **A refund does not end a booking.** A safe someone is physically using
  cannot be reclaimed by a webhook, and a booking already used has nothing to
  revoke. Force-completing a refunded booking is a deliberate admin action.
- **Money that cannot be applied stays `PAID`** and gets a `reviewReason`,
  appearing in the admin needs-refund queue. We never rewrite a payment to
  pretend it did not happen. Refunds are **manual**, in the Razorpay dashboard,
  recorded here with an audited note.
- **A scheduled message is checked twice: when the booking changes, and again
  before it is sent.** A state change cancels pending rows; the worker
  re-reads the live booking and the *same read* produces the template
  parameters. Either guard alone would nearly do; both are kept because a
  forgotten cancellation must be harmless rather than a false claim about a
  safe holding someone's property. A deadline message claimed more than
  `REMINDER_MAX_LATENESS_MINUTES` late is dropped, not sent — late is false.
- **WhatsApp is never the source of truth for a booking.** It is a nudge
  toward the dashboard, which derives everything from the server clock on
  every read. Booking events write **no** in-app `Notification` rows — see
  `docs/decisions.md`.
- **Locking** requires an authenticated session plus a live booking. Allowed
  during an unpaid overstay, and not phone-gated.
- **Unlocking** ALWAYS requires a valid OTP, on top of a live booking, no
  outstanding fee, and a **verified phone** (`PHONE_NOT_VERIFIED`, 403). No
  exceptions, no bypass flags in production. **Locking is deliberately less
  gated**: it needs no code and no settled fee, it is the safe direction, and
  blocking it would leave someone unable to secure a safe they are standing at.
- **Unlock eligibility is re-checked inside the confirm transaction**, with the
  device row locked — not only at request time. A booking can end between a
  code being verified and the bolt moving. Completing a booking also consumes
  every open `UnlockChallenge` for it; the two guards are independent.
- **Rates are snapshotted onto every booking.** Changing an env var must never
  re-price a booking that is already running. The overstay multiplier is basis
  points, never a float.
- **A safe is bookable only if it is `AVAILABLE`, online, and its door sensor
  is reporting.** Renting one we cannot command — or whose closure we cannot
  verify — is selling a product that does not work, and both failures are
  invisible at the moment of sale and obvious an hour later. A safe that goes
  offline *after* the booking is not cancelled: there is money involved and it
  may come back in seconds, so it raises an admin flag instead.
- **`UNLOCK` is never published to a device that is not `AVAILABLE`**
  (409 `DEVICE_NOT_OPERABLE`), checked under the device row lock in the same
  transaction that allocates the sequence number. `LOCK` still is — a safe
  under inspection is exactly a safe an admin may need to close.
- **Retirement revokes the credential** (`credentialHash` nulled, audited);
  `NEEDS_INSPECTION` deliberately keeps it. Keeping a live credential is not
  the same as keeping a live safe, and revoking the inspecting one would make
  the device that most needs attention the device nobody can reach.
- **A safe reporting itself open with no booking entitled to it is reconciled
  closed**: a system `LOCK`, a flag raised on issue, an audit row, retries with
  backoff, and `NEEDS_INSPECTION` on exhaustion. "Entitled" is
  `unlockEligibility` on the live booking, not `Booking.status`.
- Every lock/unlock attempt (success or fail) is written to `AuditLog`.
- Admin responses are an **explicit allow-list** via Prisma `select` — never whole rows.
  No password hashes, token hashes or `credentialHash`, ever.
- Audit metadata holds ids, counts and error codes only; the audit service drops any
  key matching `email|phone|password|secret|token|hash`. **Failed** admin actions are
  audited too, with the error code.

## Razorpay Integration Rules
- Keys in env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. **Never expose the key secret to the frontend**; only `KEY_ID` goes to the client.
- Amounts are in **paise** (INR x 100). Store integers, never floats.
- **Orders are created from the booking routes, never `/payments/order`** —
  which is gone, along with `/payments/me`. The amount always comes from a
  booking's snapshotted rates, so no code path reads one from a request body
  and every order schema is `.strict()`.
- Flow:
  1. `POST /api/v1/bookings` -> holds a safe, `PENDING_PAYMENT`, no money yet.
  2. `POST /api/v1/bookings/:id/order` (or `/extend/order`, `/overstay/order`)
     -> backend computes the amount, creates a Razorpay order with an
     `expire_by`, and saves a `Payment` row with `CREATED` and its `purpose`.
  3. Frontend opens Razorpay Checkout with the returned `orderId`.
  4. On success, frontend calls `POST /api/v1/payments/verify` with `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`.
  5. Backend verifies signature: HMAC-SHA256 of `order_id + "|" + payment_id` using the key secret; compare with `crypto.timingSafeEqual`. Only then mark `PAID`.
  6. **Webhook** `POST /api/v1/payments/webhook` (events `payment.captured`, `payment.failed`, `refund.processed`): verify `X-Razorpay-Signature` against the **raw request body** using the webhook secret. Webhook is the source of truth — it must be **idempotent** (ignore events already processed).
- **Settling a payment and applying it to its booking happen in one
  transaction.** A booking must never be `ACTIVE` without the money, and money
  must never be taken without either an effect or a `reviewReason`.
- **`expire_by` is set deliberately**: to the booking's hold for a `BOOKING`
  order, and to the quote TTL for an `OVERSTAY` one. The gateway refusing a
  late attempt is the cheapest place to stop it; what gets through is handled
  in the settlement, never silently.
- Never trust the frontend's claim that payment succeeded.
- Use Razorpay **test mode** keys in development; test cards/UPI are in Razorpay docs.
- **Refunds are manual.** There is no refund call in this codebase: an admin
  refunds in the dashboard and records it with `POST
  /admin/payments/:id/clear-review`. `refund.processed` marks the row
  `REFUNDED` and clears any review flag; it does **not** end the booking.

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
  **Exception:** `RefreshToken.revokedReason` records why a token was revoked,
  and a token revoked by `PASSWORD_CHANGE` or `PASSWORD_RESET` answers a plain
  401 `REFRESH_TOKEN_INVALID` **without cascading**. Those revocations were
  deliberate and already covered every session, so the cascade can only reach
  the legitimate successor — which is how changing your password used to sign
  you out of the device you changed it on. See `docs/decisions.md`.
- **Grace window**: `REFRESH_GRACE_WINDOW_MS` (10s, in `refreshToken.service.ts`).
  A replay inside it mints **one** sibling in the family (two tabs racing), tracked
  by `graceUsedAt` and audited as `REFRESH_GRACE_USED`. **Set to 0 to disable.**
  Applies only to tokens revoked *by rotation* — never to a logout or cascade
  revocation. Tradeoff documented in `docs/decisions.md`.
- **Logout** revokes the presented refresh token server-side, then clears cookies.
  Cookies must be cleared with the same `Path` they were set with.
- **Password reset** is two endpoints, neither authenticated:
  `POST /auth/password/forgot` `{ identifier }` (email **or** phone) and
  `POST /auth/password/reset` `{ identifier, code, password }`. An **8-digit
  code**, 15 minutes, 5 attempts, single use; a new request supersedes the old
  one. **Reset does not log the user in** — no user, no cookies; they sign in
  with the new password. It revokes every refresh token with
  `revokedReason: PASSWORD_RESET`.
- **`/forgot` answers byte-identically for every input** — registered email,
  unknown email, registered phone, unknown phone, a user with no verified
  number, and a user whose daily WhatsApp cap is spent. Six cases, one answer,
  one test asserting the set has exactly one member. The difference is recorded
  only as two distinct audit actions.
- **Every reset failure answers identically too**: unknown identifier, no
  outstanding code, wrong code, expired, used, attempts exhausted — all 400
  `RESET_CODE_INVALID` with one message. Exhaustion is distinguished only in
  the audit log.
- The **minimum interval between codes** is enforced server-side as a limiter
  limb keyed on the hashed identifier, evaluated **before any lookup**, so its
  429 is identical for a real and a fake account. The UI countdown reads the
  same shared constant.
- Delivery goes through the `ResetSender` seam to **WhatsApp, to a verified
  number only** — the message now carries the code (8 digits, 15 minutes,
  5 attempts, single-use is a credential a forwardable message can carry; a
  32-byte token was not). A user with no verified phone has **no channel**, and
  `/forgot-password` says so generically without revealing which case it hit.
- **`POST /auth/password/change`** (authenticated) verifies the current
  password, then revokes **every** refresh token and reissues a fresh family to
  the caller in one transaction: still signed in here, signed out everywhere
  else. A wrong current password is a **400 `PASSWORD_INCORRECT`, never a
  401** — a 401 sends the web client through refresh-and-retry and would sign
  someone out for a typo.
- **Access tokens cannot be revoked early.** Reset and change-password both
  kill every refresh token, but an already-issued access token stays valid for
  up to **15 minutes** — it just cannot be renewed. Accepted deliberately; the
  two alternatives (a `tokenVersion` column, a jti denylist) and why they were
  not taken are in `docs/decisions.md`.
- **`PATCH /auth/profile`** updates the **name and nothing else**.
  `updateProfileSchema` is `.strict()`, so a body also carrying `email` or
  `phone` is a 400 — both are identifiers needing a verification flow that does
  not exist, and silently ignoring them would look like a change that worked.
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
- **Delivery is WhatsApp, sent inline and never queued.** `deliverOtp` returns
  its outcome; on failure `requestUnlock` **consumes the challenge it just
  created** and answers 502 `OTP_DELIVERY_FAILED`, so no undelivered code is
  left live. The two unlock-request limiters refund a 5xx (an outage must not
  burn the user's allowance); every 4xx still counts. The ~100ms window between
  commit and compensation is documented in `docs/decisions.md`.
- A code can never be queued: `OutboundMessage` stores no template parameters,
  so `buildParams` **throws** for the OTP kinds. A code that arrived after a
  retry backoff would have expired anyway.
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
**The wire protocol is `docs/device-protocol.md`** — approved 2026-10-19 and
the authority on topics, signing, the command lifecycle and the firmware
requirements. This section is the summary; that document is the contract a
firmware developer implements against.

One interface, two implementations (`apps/api/src/lib/deviceGateway/`):
```ts
interface DeviceGateway {
  readonly name: string;
  start(handler: DeviceInboundHandler): Promise<void>;
  stop(): Promise<void>;
  sendLock(command: OutboundCommand): Promise<PublishResult>;
  sendUnlock(command: OutboundCommand): Promise<PublishResult>;
}
```
- **A gateway's job ends at "the broker took it".** The old interface returned
  `{ acked }`, which was honest for an in-process mock and cannot survive a
  radio: a publish and an ack are two events separated by an unbounded amount
  of time, and either can be lost. The ack arrives later through
  `DeviceInboundHandler`.
- **Two methods, not one `sendCommand(type)`** — unlocking has a precondition
  (a verified OTP) that locking does not, and the asymmetry should be visible
  at every call site.
- **The interface still takes no context**: no user, no booking, no payment
  state, no request. What it gained is the opposite of context — a command id,
  a sequence number and a key version, the three things that make a packet
  unforgeable and unreplayable. Authorisation is settled before anything
  reaches a gateway.
- `MockDeviceGateway` (`DEVICE_GATEWAY=mock`): small delay, **always acks** — a
  flaky mock makes every test flaky. Refused in production.
- `MqttDeviceGateway` (`DEVICE_GATEWAY=mqtt`): MQTT 5 over TLS,
  `safelock/v1/<serial>/{cmd,ack,state,status}`. **`retain: false` on `/cmd` is
  hardcoded and asserted by a test** — a retained command is re-delivered on
  every reconnect, and for `UNLOCK` that is a safe which opens itself every
  time its Wi-Fi flaps.
- **Per-device keys are derived, never stored.** `K_d = HMAC(master, "…:kv:
  serial")`, so a database leak yields no device key. Every command carries
  `kv`, so the master secret can rotate without a flag day.
- **Commands are time-limited (`COMMAND_TTL_MS`, 15s)** and the sweeper writes
  down what a read already knows: `effectiveCommandStatus` derives a timeout
  from the clock on every read, so a wedged sweeper still shows a waiting user
  the right answer.
- **`lockState` moves only on an ack**, and on the **measured** state rather
  than the requested one — a `FAILED` ack reporting `UNLOCKED` records
  `UNLOCKED`, because the safe is open and the dashboard must say so.
- `SimulatedDevice` (`apps/api/src/lib/deviceSimulator/`) stands in for the
  firmware, which is out of scope. It implements the device side of the
  protocol, signs with the real `K_d`, and **can be told to misbehave** — drop
  an ack, hold one, forge a signature, ack a foreign command, reboot
  mid-command, go silent, jam. Run against the dev broker with
  `npm --workspace apps/api run simulate -- SAFE-0001`.
- **Every misbehaviour test asserts the misbehaviour was delivered before it
  asserts the server's response.** §13 is the reasoning: such a test fails by
  *passing*, because "the server recorded nothing" is equally true of a
  simulator that never connected.

## Activity History & Notifications
- `GET /api/v1/devices/history?cursor=&limit=` — the caller's own events, newest
  first. **Cursor-based, not offset-based** (default 20, max 50): the feed is
  append-only, and an offset duplicates rows across pages as new events land.
  The cursor is an opaque `base64url("<iso>|<id>")`; a malformed, tampered or
  oversized one is a **400 `INVALID_CURSOR`**, never a silent full scan.
- **No eligibility gate on history or notifications** — `requireAuth` only. A
  user who has never booked and one whose booking ended last week both read
  their own record and get an **empty list, not an error**. It is a security
  log *about them*; withholding it would be withholding their own data.
- `GET /api/v1/notifications` (unread first, with the **total** unread count,
  not the page's) and `POST /api/v1/notifications/read` `{ ids? }` — idempotent;
  ids that are not the caller's are ignored, never 403'd.
- **What notifies:** `UNLOCK_CONFIRMED`, and `UNLOCK_FAILED` only once the
  attempt limit is burned. **Booking events notify nobody in-app** — the
  dashboard renders their deadlines live from the server clock, which is
  better than a record of a moment, and WhatsApp carries the nudge. **Not** a single wrong code, not `UNLOCK_REQUESTED`,
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

## WhatsApp, Verification & Outbox
- One seam, `WhatsAppClient` (`apps/api/src/lib/whatsapp/`), two
  implementations chosen by `WHATSAPP_PROVIDER`. **Templates only, never free
  text** — Meta requires a pre-approved template, so there is no method that
  sends an arbitrary string and no user input can become message content.
- `FakeWhatsAppClient` records sends in memory and can be told to fail
  deterministically (delivery failure is a real path with required behaviour).
  `mayUseFakeWhatsApp(NODE_ENV)` guards it exactly like `mayPrintOtp`.
- `CloudApiWhatsAppClient` has a timeout and **never retries**: a send is not
  idempotent, so a blind retry risks a second code on someone's phone.
  Retrying is the outbox's decision, from a typed error category.
- **Nothing is sent from inside a transaction.** `WhatsAppNotifier` writes an
  outbox row through the transaction client; the worker sends after the commit.
  The in-app notification keeps step 2's atomic-and-blocking contract.
- **Rental lifecycle messages are scheduled, not immediate.** Five kinds
  (`BOOKING_CONFIRMED`, `BOOKING_ENDING_SOON` ×2, `OVERSTAY_STARTED`,
  `OVERSTAY_SETTLED`, `COLLECTION_CLOSING`) are written with a future `sendAt`
  inside the transaction that justified them — `booking.messages.ts` plans and
  cancels, `lib/outbox/bookingMessages.ts` re-validates and builds the
  parameters. Lead times are `BOOKING_REMINDER_LEAD_MINUTES` and
  `COLLECTION_REMINDER_LEAD_MINUTES` in `@safelock/shared`, **not** env, since
  they appear in approved template copy *and* in UI text promising them.
- **The overstay notice is due at `endsAt + grace + 60s`**, never at the
  boundary: the fee is exactly zero at `endsAt + grace`, and re-validation
  requires an outstanding fee, so a notice due at that instant would be
  refused on every poll until it went stale.
- **Two send budgets.** `WHATSAPP_DAILY_SEND_CAP` counts user-triggered kinds
  (`PHONE_OTP`, `PASSWORD_RESET`, `UNLOCK_ALERT`, `FAILED_ATTEMPTS_ALERT`);
  `WHATSAPP_BOOKING_SEND_CAP` counts the five above, and only rows actually
  `SENT`, so extensions re-creating reminders cost nothing. `UNLOCK_OTP` still
  ignores the cap. A dropped booking message is `SKIPPED`/`CAP_REACHED` and
  **counted on the admin Bookings row** — a renter never told about a fee must
  not be invisible.
- **A waived overstay sends no receipt**, only the collection reminder: a
  write-off worded as a payment would be a lie about money. The admin who
  waives is expected to tell the renter. See `docs/decisions.md`.
- **`urlButtonSuffix` is the only dynamic part of a link.** Meta fixes the
  base in the approved template, so it cannot point off-site, and every caller
  builds it from a booking id plus a fixed segment. `PUBLIC_WEB_URL` is the
  canonical base and is deliberately not `WEB_ORIGIN`.
- Phone numbers are normalised to **E.164** by `toE164` in
  `@safelock/shared`; `maskPhone` (`+91 98****10`) is the **only** phone
  representation allowed in a log line or audit row, and is allowlisted in
  both the logger regex and the audit scrubber.
- `POST /api/v1/webhooks/whatsapp` verifies `X-Hub-Signature-256` over the
  **raw body** with the app secret, constant-time, **before parsing** — 401
  otherwise. Exempt from `originCheck` like the Razorpay webhook: there are no
  ambient credentials to abuse and an HMAC is a stronger claim than an Origin
  header. Idempotent by status rank, so retries cannot walk a record backwards.
- **No test can reach the network**: `test/setup.ts` replaces `fetch` with a
  throwing stub for the whole suite, and the Cloud client is unit-tested
  against a stub.

## API Conventions
- Base path `/api/v1`, JSON only, consistent error shape: `{ "error": { "code": "...", "message": "..." } }`.
- Validate every request body/query with **zod**.
- Authorization on every device route goes through `assertCanOperate`, which
  resolves the safe **from the caller's live booking** — there is no device id
  in any path, so there is no id a caller could substitute, and no `ownerId`
  left to compare against.
- **A lock or unlock answers 202 with a command id**, never a device summary.
  The bolt has not moved yet; clients poll `GET /devices/commands/:id`.
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
- `/forgot-password` — email field; the confirmation panel is worded to be true
  for a registered and an unregistered address alike, since the API answers
  identically. In mock mode it shows the token and a link, guarded like
  `peekMockUnlockCode`.
- `/reset-password` — identifier (prefilled from `/forgot-password`) + the
  8-digit code + new password. One error message for every failure, because the
  API has only one. **Ends at "sign in", not signed in.**
- `/account` — phone verification (`#phone`), name (editable), email
  (read-only, with the reason), and change-password. Independent forms: a
  password change ends every other session and a name change does not, so they
  do not share a button. The verification step shows the **masked** number the
  code went to, which is the only way a user who mistyped can notice — the API
  answers identically for a number owned by someone else.
- A **"verify your phone" prompt** appears on `/dashboard` and `/account` for
  any unverified user, not only when an unlock is refused: discovering the
  requirement when you need to open your safe is discovering it too late. The
  Unlock button is disabled with the reason shown; Lock stays enabled.
- `/book` — duration picker, the price for each allowed duration **from the
  server's quote** (the client does no money arithmetic), and the overstay rule
  stated with its real figures *before* anyone pays. `/pay` is gone.
- `/dashboard` — the booking card plus, once paid, the safe's controls. Three
  shapes, all decided from `effectiveStatus`: no booking (book one), awaiting
  payment (pay or cancel, with the hold counting down), paid (time left,
  extend, collect — and during an overstay the fee and paying it, then a
  collection countdown). The four purchase states are gone with their flags.
- `/bookings/[id]/extend` — where a reminder links. The booking is **named in
  the URL** because a message is written at one moment and read at another, so
  it cannot link to "whatever is current". Durations and prices come from the
  server's `extension` block; refusals name the remedy. `?next=` anywhere is
  validated by `safeInternalPath`, which resolves the value against the
  current origin and refuses anything that escapes.
- `/dashboard/unlock` — OTP entry (6 input boxes, resend timer 30s). Once the
  code is accepted the entry **goes away**: everything after that point is
  about the safe, not the digits, so offering boxes to retype a *correct* code
  into would be a lie about what the user can still do — and a motor fault
  must never read as "you mistyped it". The dialog then polls the command and
  can be dismissed with "Close and check later", which is honest: closing
  stops the polling, not the command.
- `/history` — activity log, grouped by local day, "Load more" (not infinite
  scroll — an endless list has no end for a keyboard or screen reader user).
  Rows are icon **plus** text, never colour alone. The unread bell lives in
  `AppHeader`.
- `/admin` (role ADMIN) — **Bookings** (opens on "needs attention", the only
  list nothing else surfaces), device inventory with Clear inspection, users
  with their current booking, payments with a needs-refund queue, audit.
  Allocate and Unassign are gone.
- **The Devices tab carries the hardware's own account of itself**: last seen,
  firmware, RSSI, a clock warning, whether it is provisioned, the flags with
  **their remedy** (a list of problems with no suggested next step is a list
  people stop opening), a lazily-fetched recent-commands expander, and
  "Issue credential".
- **The credential is shown once, in a panel rather than a toast**, and the
  dialog before it warns that a *re-issue* revokes the password the unit is
  currently using — so a safe in the field that is not then re-provisioned
  goes silent. That has to be said before the button, not after.
- **A payment that could not be applied is never rendered as success.**
  `needsReview` gets its own panel saying the money arrived, is logged for a
  refund, and do not pay again.
- **A command's outcome is wording, and the wording is in
  `COMMAND_OUTCOME_COPY`** (`@safelock/shared`), like `NOTIFICATION_COPY`: the
  API owns the fact, the UI owns the phrasing. `TIMED_OUT` says we cannot
  confirm what happened and pointedly does **not** say the safe stayed shut —
  the bolt may have moved and the ack been lost, and a late
  `UNLOCK_CONFIRMED` in the feed must not contradict what the user was told.
  `EXPIRED` can afford to be definite: nothing left the building.
- **An offline safe disables Unlock** and says the safe also opens with its
  physical key. The API refuses the unlock *request* before a code is sent, so
  offering the button would spend the user's send cap and their
  three-codes-per-ten-minutes on a code that cannot work. **Lock stays
  enabled**: refusing to let someone try to secure their own safe would be the
  wrong way to be careful.
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
RENTAL_HOURLY_RATE_PAISE=10000   # paise/hour; the ONLY source of the rate.
                                 # PROVISIONAL. Snapshotted onto every booking,
                                 # so changing it never re-prices a live one.
RENTAL_MIN_HOURS=1
RENTAL_MAX_HOURS=24
OVERSTAY_MULTIPLIER_BPS=15000    # basis points: 15000 = 1.5x. Never a float.
OVERSTAY_GRACE_MINUTES=15        # free minutes after endsAt
OVERSTAY_CAP_HOURS=24            # bounds the bill for someone who vanishes
COLLECTION_WINDOW_MINUTES=30     # time to collect after an overstay is settled
BOOKING_HOLD_MINUTES=10          # how long an unpaid booking holds its safe;
                                 # the Razorpay order expiry matches it
OVERSTAY_QUOTE_TTL_MINUTES=15    # how long an overstay quote is binding
PUBLIC_WEB_URL=                  # the ONE canonical base for links in messages.
                                 # Optional outside production (defaults to
                                 # http://localhost:3000); REQUIRED in
                                 # production, where it must be https, not
                                 # loopback and free of placeholders. NOT
                                 # WEB_ORIGIN, which is a list.
REMINDER_MAX_LATENESS_MINUTES=5  # past this a scheduled booking message is
                                 # SKIPPED/STALE. Keep well above
                                 # OUTBOX_POLL_INTERVAL_MS (5s).
BOOKING_SWEEP_INTERVAL_MS=60000  # reconciler only; correctness never depends
                                 # on it, because every read derives status
                                 # from the clock
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx
OTP_HMAC_SECRET=change_me     # REQUIRED, 32+ chars; keys the unlock-code HMAC.
                              # Keep it separate from JWT_ACCESS_SECRET.
                              # Password reset needs NO secret of its own — its
                              # tokens are 32 random bytes under a plain sha256.
DEVICE_GATEWAY=mock           # mock | mqtt. `mock` is REFUSED in production:
                              # it acks every command without a device.
DEVICE_COMMAND_HMAC_SECRET=   # REQUIRED for mqtt, 32+ chars, and must DIFFER
                              # from OTP_HMAC_SECRET — they rotate
                              # independently. Keys every per-device K_d.
DEVICE_COMMAND_KEY_VERSION=1  # which K_d version new provisioning hands out
COMMAND_TTL_MS=15000          # a command's lifetime. Under the ~20s a person
                              # will stare at a spinner
COMMAND_LATE_ACK_MAX_MS=600000   # past this an ack is dropped for command
                                 # purposes — its *state* is still applied
COMMAND_SWEEP_INTERVAL_MS=5000   # reconciler only; every read derives a
                                 # timeout from the clock
COMMAND_MAX_ATTEMPTS=3           # system LOCK retries (10s, 60s, 300s)
COMMAND_FAILURE_FLAG_THRESHOLD=3 # consecutive failures before a device is flagged
DEVICE_HEARTBEAT_SECONDS=60      # how often a unit reports unprompted
DEVICE_OFFLINE_AFTER_SECONDS=180 # three missed heartbeats, so one lost packet
                                 # is not an outage
WHATSAPP_PROVIDER=fake        # fake | cloud. `fake` is REFUSED in production.
# Required when WHATSAPP_PROVIDER=cloud, in every environment:
# WHATSAPP_ACCESS_TOKEN=      # System User token for production
# WHATSAPP_PHONE_NUMBER_ID=   # not the phone number itself
# WHATSAPP_APP_SECRET=        # keys the webhook HMAC
# WHATSAPP_WEBHOOK_VERIFY_TOKEN=   # a random string you choose
# WHATSAPP_TEMPLATE_* (ten names), WHATSAPP_LANGUAGE, WHATSAPP_API_VERSION,
# WHATSAPP_TIMEOUT_MS, OUTBOX_POLL_INTERVAL_MS, OUTBOX_MAX_ATTEMPTS, and the
# TWO send budgets — WHATSAPP_DAILY_SEND_CAP (default 10, user-triggered
# kinds) and WHATSAPP_BOOKING_SEND_CAP (default 20, rental lifecycle) — see
# apps/api/.env.example
# Required when DEVICE_GATEWAY=mqtt, in every environment. The URL must use
# TLS in production. The API connects with ONE privileged server credential
# whose ACL denies it write access to ack/state/status — there is no reason for
# the server to be able to forge a device report. Devices get a per-device
# credential from POST /admin/devices/:id/credential, shown once.
# MQTT_URL=mqtts://broker.example.com   # mqtt://localhost:1883 for `npm run db:up`
# MQTT_USERNAME=
# MQTT_PASSWORD=
# MQTT_TIMEOUT_MS=5000
```

Frontend (`apps/web/.env.local`):
```
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_USE_MOCK_API=true
```
There is no `NEXT_PUBLIC_RAZORPAY_KEY_ID`: the key id comes back from the
booking order endpoints, so the browser holds no payment config of its own.

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
npm --workspace apps/api run db:cleanup-tokens  # prune dead refresh + reset tokens
npm --workspace apps/api run simulate -- SAFE-0001   # a simulated safe on the dev broker
npm --workspace apps/api run simulate -- SAFE-0001 --misbehave DROP_ACK
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
- ~~Price and plan structure~~ → **the model is now hourly rental**, not a
  one-time purchase. `RENTAL_HOURLY_RATE_PAISE=10000` (₹100/hour) is a
  development placeholder, exactly as the ₹999 was. **Still to confirm:** the
  real hourly rate, whether GST is included, and the four overstay parameters
  (1.5x multiplier, 15-minute grace, 24-hour cap, 30-minute collection window)
  — all four are plausible guesses, not decisions anybody has made.
- ~~OTP channel~~ → **decided: WhatsApp (Meta Cloud API).** Unlock codes,
  verification codes and alerts are delivered through the `WhatsAppClient` seam.
  Working in production **once ten templates are approved by Meta and the four
  `WHATSAPP_*` credentials are set** — see README. **Two of the five rental
  templates cannot be submitted until the production domain is decided**: their
  dynamic URL button bakes in a base URL, which must match `PUBLIC_WEB_URL`. Until then
  `WHATSAPP_PROVIDER=fake` is the only legal value, and the env schema refuses
  `fake` in production so a half-configured deploy fails at boot rather than
  silently sending nothing.
- **Email provider for password reset — open, and the one real gap left.**
  Reset now works over WhatsApp (an 8-digit code), but only to a **verified
  phone**, so a user who never verified and then forgets their password still
  has no self-service path. `/forgot-password` answers byte-identically and
  says reset goes to a verified number; the dashboard and `/account` nag
  unverified users precisely to shrink this window. The long-term fix is an
  email sender (the seam is `lib/resetSender/`, which an email implementation
  joins as a composite, not a replacement).
- ~~Auto-allocation vs manual admin allocation~~ → **moot.** Allocation is
  gone: paying for a booking is what gets a safe, and which safe is decided
  under a row lock by the booking service.
- **The abandoned-items process — open, and the one the software deliberately
  refuses to decide.** If a renter overstays and never pays, the booking stays
  `OVERSTAY` forever, the fee stays capped, the safe stays reserved, and the row
  sits in the admin flagged list. Nothing releases it automatically, because
  handing the next renter a safe that may still contain somebody's property is
  the one outcome worth avoiding at any cost. **Needs deciding:** how long to
  hold an abandoned safe, how to contact the renter, what disposal is lawful,
  and who signs it off. Probably a legal question as much as a product one.
- **Who gets the safe when an overstay collides with the next booking? — open,
  and reachable today.** It does not need future-dated bookings, only
  back-to-back ones. The sweeper now **clamps** the overstaying booking's
  reservation at the next booking's start rather than forcing past it (which
  the exclusion constraint rightly refused, and which used to abort every
  sweep — see `docs/decisions.md`). The overstayer keeps the safe physically
  and keeps accruing a fee; the next renter keeps their booking. **Needs
  deciding:** bump the new booking, compensate them, substitute another safe,
  or refuse back-to-back bookings tighter than the turnaround. The flagged
  list surfaces it; nothing resolves it.
- **Future-dated bookings — not built.** Bookings are "from now" only. Adding
  them widens the collision above from "the next hour" to "next Tuesday", and
  would want a real answer to it first.
- ~~**Serial number format**~~ → **confirmed** (`^SAFE-[0-9A-Z]{4,12}$`), and
  it **is** the device's MQTT identity: client id = username = certificate CN =
  serial, and `K_d` is derived from it. One identity, no lookup table to get out
  of sync. Changing it now means a migration, re-labelled stock *and*
  re-provisioning the fleet.
- **A mismatched key version is mutual incomprehension, not a readable
  rejection — open, and found while implementing.** A device re-provisioned to
  `kv=2` whose row still says `kv=1` refuses commands correctly with
  `BAD_KEY_VERSION`, and the server **cannot read the refusal**: device reports
  are signed with the device's own `K_d` and an ack carries no `kv`, so the
  signature is checked under the version they disagree about. Safe, and the
  right way round to be wrong — a mis-provisioned safe looks exactly like a
  hostile one — but it makes `BAD_KEY_VERSION` a reason the server can
  essentially never see. Both candidate fixes are in `docs/device-protocol.md`
  §2.3. Pinned by a test either way.
- ~~Serial number format is provisional~~ (`^SAFE-[0-9A-Z]{4,12}$`). Confirm what the
  units are actually stamped with, and whether the serial is also the device's MQTT
  identity, **before ordering hardware** — changing it later means a migration plus
  re-labelling stock.
- Admin list page size is 20 (max 100). Confirm if that is wrong for real volumes.
  Note the Bookings tab's `flagged` filter is applied **after** pagination, since
  the fee depends on `now` against a per-row snapshot — so `total` counts the
  unfiltered set.
- Hardware protocol finalized? (MQTT vs HTTP/WebSocket, Wi-Fi vs GSM module)
- **Refund / device return policy — still open, and now blocking.** `/refund-policy`
  is a published placeholder; the 11 decisions needed are listed on that page and in
  `apps/web/src/app/refund-policy/page.tsx`. Under the rental model a refund no
  longer withdraws access, and force-completing a refunded booking is a
  deliberate admin action.
- **How long should `DeviceEvent`, `Booking` and `AuditLog` rows be retained? —
  open, nothing deletes any of them.** The activity feed is the user-visible
  security record of a physical safe, so "keep forever" and "prune after N
  months" are both defensible and the choice is a policy one. Needs deciding: a
  retention period (if any), whether a user may delete their own history
  (probably not — it is a security log), and what happens to `Notification`
  rows pointing at a pruned event (`deviceEventId` is already
  `onDelete: SetNull`). Refresh tokens are pruned at 30 days by
  `db:cleanup-tokens`; nothing else is.
- Number of safes per user at once? **One**, enforced by the
  `Booking_one_live_per_user` partial unique index. Confirm that is the intent
  for real customers.
- **Does a waived overstay need an immediate message?** A waiver deliberately
  sends no receipt — wording a write-off as a payment would be a lie about
  money — so the renter gets only the collection reminder and the admin who
  waived is expected to tell them. A sixth template would fix it. Nobody has
  said whether waivers will be common enough to matter.
- **The reminder lead times** (30 and 10 minutes before the end, 10 before the
  collection deadline) and `WHATSAPP_BOOKING_SEND_CAP=20` are plausible
  numbers, not measured ones. They live in `@safelock/shared` rather than the
  environment because they appear in approved template copy *and* in UI text
  promising them, so changing them is a code change plus a template review.
- Business details for the legal pages: `[BUSINESS NAME]`, `[ADDRESS]`, `[EMAIL]`,
  `[PHONE]`, GSTIN, support hours, grievance officer.

## Roadmap
1. ✅ Auth + user model — argon2id, rotating opaque refresh tokens with reuse
   detection, `/auth/signup|login|refresh|logout|me`, Origin check, two-limb rate
   limiting, pino + request ids, DB-backed `/health`, ADMIN seed script
2. ✅ Razorpay payment (test mode) + webhook — order / verify / webhook,
   legal pages. *(The one-time purchase shape, `payments/me` and `requirePaid`
   were all removed in step 8; the signature and webhook machinery stayed.)*
3. ✅ Device inventory — `Device` model, `requireAdmin`, `/admin` panel,
   `GET /devices/mine`. *(Allocation was built here and removed in step 8.)*
4. ✅ Lock/Unlock flow with OTP using `MockDeviceGateway` — `assertCanOperate`,
   `POST /devices/lock|unlock/request|unlock/confirm`, HMAC'd single-use codes,
   `DeviceEvent` + `AuditLog` on every state change, row-locked transactions,
   dashboard controls and OTP dialog
5. ✅ Activity history + unlock notifications — `GET /devices/history` with
   cursor pagination and strict cursor validation, `DeviceEvent.failureReason`,
   a `Notification` table written through the `Notifier` seam inside the
   unlock transaction, `/notifications` list + idempotent mark-read, the
   `/history` page and a polling header bell. Retention is still open.
6. ✅ Account management — password reset (`/auth/password/forgot|reset`, one
   live single-use token, byte-identical responses, no auto-login),
   `POST /auth/password/change` (revoke-all-then-reissue), `PATCH /auth/profile`
   (name only, `.strict()`), the `/forgot-password`, `/reset-password` and
   `/account` pages, plus a polish pass (mock badge unstuck from the sticky
   history headings, `prefers-reduced-motion` honoured).
7. ✅ WhatsApp delivery + phone verification — `WhatsAppClient` seam (fake +
   Cloud API), `OutboundMessage` outbox with a poll worker, `CompositeNotifier`
   (in-app stays atomic, WhatsApp cannot block an unlock), `ResetSender`,
   `POST /account/phone/request-verification|confirm`, `PHONE_NOT_VERIFIED`
   gating unlock only, a rolling daily send cap, and the signed delivery
   webhook. **Needs five Meta-approved templates before it works in
   production.** Password reset was then switched from an undeliverable
   32-byte token link to an 8-digit code (2026-10-17), which is what makes it
   actually work. Email-only reset is still open.
8. ✅ **Rental bookings** (2026-10-17) — the purchase model replaced wholesale.
   `Booking` with a gist exclusion constraint and a one-live-per-user index,
   snapshotted rates, a hold that starts the clock at payment, overstay fees
   with a grace period and a cap, extensions, collection, a reconciling
   sweeper that decides nothing, `NEEDS_INSPECTION` for safes whose contents
   are unknown, per-purpose payments with a manual-refund queue, `/book`, a
   rewritten dashboard and an admin Bookings tab. `Device.ownerId`,
   allocation, `requirePaid`, `hasPaid` and `deviceAllocated` are all gone.
   See `docs/decisions.md`.
8b. ✅ **Rental reminders** (2026-10-17) — five scheduled WhatsApp templates
   across a booking's life, `sendAt` on the outbox with a staleness floor,
   cancellation at the state change plus re-validation at send, two send
   budgets, dropped messages surfaced to admins, `extensionAvailability` as the
   one answer to "can this be extended?", the `/bookings/:id/extend` page a
   reminder links to, and `safeInternalPath` for `?next=`. Also fixed a live
   bug: the unlock-code template was being sent two parameters where Meta
   permits one, so no code would have been delivered in production.
9. ✅ **Real hardware via MQTT** (2026-10-22) — the protocol in
   `docs/device-protocol.md`, approved 2026-10-19 and implemented behind it.
   `Command` with a per-device sequence number and a deadline; derived `K_d`,
   canonical signing strings and closed enums on the wire; lock and unlock
   answering **202 with a command id** instead of pretending to be
   synchronous; `MqttDeviceGateway` plus a dev broker enforcing the production
   ACLs; a sweeper that retries a system lock and escalates to
   `NEEDS_INSPECTION`; §8.3's reconcile for a safe found open with nobody
   entitled to it; a `SimulatedDevice` standing in for firmware, with
   misbehaviours and tests that prove delivery before asserting a response;
   credential issue and revocation; a booking pick that refuses safes it
   cannot reach or whose door sensor is silent; and a web client that polls a
   command to its outcome.
   **The lock-after-completion path now has the guarantee the roadmap owed
   it**: the command is a row, it retries on a backoff, and on exhaustion the
   device is flagged and sent for inspection rather than recorded closed while
   physically open.
   **Still owed:** firmware (out of scope — the simulator stands in), the
   broker chosen for the pilot being stood up (HiveMQ Cloud; §9), and the
   `kv`-mismatch decision in the open questions.
10. Convert to mobile app (reuse `/api/v1`)

**Built in step 7:** WhatsApp phone verification. `phoneVerifiedAt` exists and
`assertCanOperate` enforces it for unlock. There is still **no
`requireVerifiedPhone` middleware on the payment routes** — the
`TODO(phone-verification)` markers in
`apps/api/src/modules/payments/payments.routes.ts` remain, deliberately:
gating payment on verification is a product decision, not a security one, and
nobody has made it.
