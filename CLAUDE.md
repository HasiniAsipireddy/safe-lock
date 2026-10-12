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
- **Auth:** Email/phone + password (bcrypt/argon2), JWT access token (short-lived) + refresh token (httpOnly cookie).
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
- **Payment**: id, userId, razorpayOrderId, razorpayPaymentId, razorpaySignature, amount (paise), currency, status (`CREATED` | `PAID` | `FAILED` | `REFUNDED`), createdAt
- **Device** (safe lock): id, serialNumber (unique), secretOrCertRef, status (`UNASSIGNED` | `ASSIGNED` | `RETIRED`), lockState (`LOCKED` | `UNLOCKED` | `UNKNOWN`), online (bool), lastSeenAt, ownerId (nullable)
- **OtpRequest**: id, userId, deviceId, purpose (`UNLOCK`), codeHash, expiresAt, attempts, consumedAt, createdAt
- **Command**: id, deviceId, userId, type (`LOCK` | `UNLOCK`), status (`PENDING` | `SENT` | `ACKED` | `FAILED` | `TIMEOUT`), createdAt, ackedAt
- **AuditLog**: id, userId, deviceId, action, ip, userAgent, metadata (json), createdAt

## Business Rules
- A user cannot be allocated a device until a payment is **verified server-side** (status `PAID`).
- One device belongs to one user at a time. Allocation is atomic (use a DB transaction to avoid double allocation).
- Allocation can be automatic (pick next `UNASSIGNED` device) or manual by admin — implement admin endpoint first, automate later.
- **Locking** requires only an authenticated session (+ ownership check).
- **Unlocking** ALWAYS requires a valid OTP. No exceptions, no bypass flags in production.
- Every lock/unlock attempt (success or fail) is written to `AuditLog`.

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

## OTP Rules (Unlock)
- 6-digit numeric code generated with `crypto.randomInt`, **not** `Math.random`.
- Store only a **hash** (HMAC/bcrypt) of the OTP, never plaintext.
- Expiry: 5 minutes. Single-use (set `consumedAt` on success).
- Max 5 wrong attempts per OTP, then invalidate it.
- Rate limit OTP sending: e.g. max 3 requests / 10 minutes / user, plus per-IP limit.
- OTP is bound to `userId` + `deviceId` + purpose; reject if any mismatch.
- Never log OTPs or return them in API responses (in dev only, a mock notifier may print to console behind `NODE_ENV !== 'production'`).
- Endpoints:
  - `POST /api/v1/devices/:id/unlock/request-otp`
  - `POST /api/v1/devices/:id/unlock/verify` `{ otp }` -> on success creates an `UNLOCK` command.

## Device / Hardware Layer
Define one interface and keep everything else hardware-agnostic:
```ts
interface DeviceDriver {
  sendCommand(deviceId: string, type: 'LOCK' | 'UNLOCK'): Promise<void>;
  getState(deviceId: string): Promise<{ lockState: string; online: boolean }>;
}
```
- `MockDriver` (now): simulates delay + random ack, updates DB state.
- `MqttDriver` (later): topics like `safes/{serial}/cmd` and `safes/{serial}/state`; TLS + per-device credentials/certs; device sends an **ack** with the command id.
- Commands are time-limited (e.g. 15s). If no ack -> mark `TIMEOUT` and show the user "device not responding".
- Commands must include a nonce/command id + timestamp to prevent replay.
- UI should reflect real state from device ack, not just "button pressed".

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
- `/history` — audit/activity log
- `/admin` (role ADMIN) — payments list, device inventory, allocate device
- UX: big touch-friendly buttons, clear status colors, loading/disabled states while a command is pending, confirm dialog on Lock.

## Environment Variables (`.env.example`)
```
NODE_ENV=development
DATABASE_URL=postgresql://user:pass@localhost:5432/safelock
JWT_ACCESS_SECRET=change_me
JWT_REFRESH_SECRET=change_me
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx
OTP_HMAC_SECRET=change_me
SMS_PROVIDER_API_KEY=xxxxx
MQTT_URL=mqtts://broker.example.com
MQTT_USERNAME=
MQTT_PASSWORD=
DEVICE_DRIVER=mock   # mock | mqtt
```

## Commands
This repo uses **npm workspaces** (not pnpm) — see `docs/decisions.md`.
Target runtime is **Node 22 LTS** (`.nvmrc`, root `package.json` `engines`).
```
npm install
npm run dev                                  # run web (add api to the root dev script when it exists)
npm run dev --workspace apps/web
npm --workspace apps/api run prisma:migrate  # prisma migrate dev
npm --workspace apps/api test
npm run lint && npm run typecheck            # runs across all workspaces
```

## Coding Guidelines for Claude
- Use TypeScript strict mode; no `any` unless justified.
- Small, focused files and functions; shared types live in `/packages/shared`.
- Write tests for: payment signature verification, webhook idempotency, OTP generation/expiry/attempt limits, device ownership checks, and command timeout handling.
- Before adding a new dependency, check if existing ones cover it.
- Never weaken a security rule (OTP requirement, signature verification, ownership checks) to make something "work" — ask first.
- When unsure about a requirement (pricing, number of devices per user, refund policy, OTP channel), ask rather than assume. Record decisions in `/docs/decisions.md`.
- Make small, reviewable commits; update this file when architecture decisions change.

## Open Questions (to decide)
- Price and plan structure (one-time vs subscription)?
- OTP channel: SMS, email, or both?
- Auto-allocation vs manual admin allocation of devices?
- Hardware protocol finalized? (MQTT vs HTTP/WebSocket, Wi-Fi vs GSM module)
- Refund / device return policy?
- Number of safes per user?

## Roadmap
1. Auth + user model
2. Razorpay payment (test mode) + webhook
3. Device inventory + allocation (admin)
4. Lock/Unlock flow with OTP using MockDriver
5. Audit log + history page
6. Real hardware via MQTT
7. Convert to mobile app (reuse `/api/v1`)