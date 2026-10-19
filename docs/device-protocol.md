# Safe Lock — Device Protocol v1

**Status:** **approved 2026-10-19**, including the four review decisions in §0
and the five amendments recorded with them. Implementation is in progress; the
protocol on the wire is this document.
**Scope:** the wire protocol between the API and an ESP32-based safe lock, the
broker it runs over, and the server-side command lifecycle. **Firmware is out of
scope** — this is the document a firmware developer implements against.

**Audience:** whoever writes the firmware, whoever operates the broker, and
whoever reviews the security of the thing that physically opens a safe.

---

## 0. The decisions this rests on

Settled before this document:

| Decision | Value |
| --- | --- |
| Device | ESP32, Wi-Fi (no GSM) |
| Transport | MQTT 5 over TLS, port 8883 |
| Serial format | `SAFE-XXXX` (`^SAFE-[0-9A-Z]{4,12}$`), confirmed |
| Locations | One. No `location` on any model — see open questions |
| Firmware | Not in this task. A simulator stands in for it |

Settled while reviewing this document (2026-10-18):

| Question | Decision |
| --- | --- |
| Broker | **HiveMQ Cloud** for the pilot; AWS IoT Core the documented scale path; Mosquitto in Docker for local dev. §9 |
| A verified code whose command fails | **Bound at confirm, consumed at ack**, unbound on a demonstrated failure. §5.6 |
| `NEEDS_INSPECTION` credentials | **Kept**, and the server still never issues `UNLOCK` to it. §2.3 |
| User lock while offline | **Refused**, 409 `DEVICE_OFFLINE`. Not queued. §6.2 |

Settled on approval (2026-10-19):

| Question | Decision |
| --- | --- |
| A safe found open with nobody entitled to it | The server **reconciles it closed**: `LOCK`, flag, audit, retry with backoff, escalate. §8.3 |
| A challenge whose command timed out | **Released in the same transaction** that writes `TIMED_OUT`; a late `OK` ack still consumes it. §5.5, §5.6 |
| Door sensor | **Units ship with one.** A sensor-less unit is **not supported for rentals**. §11.8 |

Three existing platform rules this protocol must not break, and does not:

1. **`lockState` moves only on an ack.** Never on a button press, never on a
   publish. A safe recorded as locked must have reported itself locked.
2. **Unlocking always costs a valid OTP**, plus a live booking, no outstanding
   fee, and a verified phone. Nothing here adds a bypass.
3. **Authorisation is settled before anything reaches the gateway.** The
   `DeviceGateway` seam takes a serial number and nothing else — no user, no
   booking, no payment state. That stays true.

---

## 1. Topics and ACLs

### 1.1 The topic tree

Every topic is namespaced by protocol version and keyed by **serial number**:

```
safelock/v1/<serial>/cmd      server → device   QoS 1, retain=false
safelock/v1/<serial>/ack      device → server   QoS 1, retain=false
safelock/v1/<serial>/state    device → server   QoS 1, retain=TRUE
safelock/v1/<serial>/status   device → server   QoS 1, retain=TRUE  (+ LWT)
```

**Why the serial and not the database id.** The `DeviceGateway` interface takes
`serialNumber` and nothing else, and that is deliberate — a transport that can
see the database id is a transport that has been handed a join key. The serial
is also the one identifier physically stamped on the unit, so a technician
holding a safe can find its topic. The device never learns its `Device.id`.

**Why `v1` is in the path.** A protocol change that is not backward compatible
gets `v2` topics and a `MqttDeviceGateway` that publishes to both during the
rollout. Versioning the payload alone would not help: a v1 device subscribed to
one topic cannot be told to stop listening.

**`/cmd` must never be published with `retain=true`.** A retained command is
re-delivered on every reconnect, forever. For `UNLOCK` that is the worst
available bug in this system: a safe that opens itself every time its Wi-Fi
flaps. The `MqttDeviceGateway` hardcodes `retain: false` for `/cmd` and a test
asserts it.

**Why `/state` and `/status` *are* retained.** The server must learn a device's
state on *its own* reconnect without waiting up to a heartbeat interval, and
without asking. A retained state message is the device's current truth, held by
the broker. It is safe to retain because it is a *report*, not an instruction —
replaying it to a subscriber causes nothing to move.

### 1.2 QoS

Commands are **QoS 1, not QoS 2**. QoS 1 is at-least-once, so a command can
arrive twice; that is handled by `commandId` de-duplication on the device (§3.4),
which we need anyway for replay protection. QoS 2 would buy exactly-once at the
cost of a four-packet handshake per command and a dependency on the weakest
part of every embedded MQTT stack. The de-duplication we already require makes
QoS 2 redundant.

### 1.3 ACLs, and how the broker enforces them

A device may publish **only** to its own `ack`, `state` and `status`, and
subscribe **only** to its own `cmd`. This is enforced at the broker by topic
patterns bound to the authenticated client identity — not by convention and not
by anything in the firmware.

The device's MQTT **client id, username and TLS certificate CN are all the
serial number**, so one identity drives the ACL.

HiveMQ Cloud / EMQX / Mosquitto (dynamic-security) express this as per-client
permissions with an identity substitution — Mosquitto's `%c`/`%u`, EMQX's
`${clientid}`:

```
# device role, applied to every device credential
pattern read    safelock/v1/%c/cmd
pattern write   safelock/v1/%c/ack
pattern write   safelock/v1/%c/state
pattern write   safelock/v1/%c/status
```

AWS IoT Core expresses the same thing as an IAM-style policy with
`${iot:Connection.Thing.ThingName}` / `${iot:ClientId}` substitution, which is
the strongest version of this — the policy is attached to the certificate, so a
stolen certificate used from a different client id fails to connect at all.

The API connects as **one privileged server client** with its own credential
(`safelock-api-<instance>`), not as a device:

```
# server role
write  safelock/v1/+/cmd
read   safelock/v1/+/ack
read   safelock/v1/+/state
read   safelock/v1/+/status
```

Note the asymmetry: the server can write to any `cmd` and read any report, and
**cannot** write to `ack`/`state`/`status`. There is no reason for the server to
forge a device report, so it is denied the ability — which also means a
compromised API credential cannot fabricate the security record, only issue
commands it could issue anyway.

**The ACL is a second line, not the first.** §3 signs every command and §4 signs
every report, so a fully compromised broker still cannot open a safe or forge a
state. The ACL's job is to stop one *device* from attacking another, which
signatures alone would not prevent — device A holds a valid key and could
otherwise publish to device B's `ack`.

---

## 2. Credentials and provisioning identity

### 2.1 What exists per device

Three distinct secrets, with three different jobs:

| Secret | Purpose | Lives on device as | Server stores |
| --- | --- | --- | --- |
| **MQTT credential** | Authenticates the TLS/MQTT connection | Client certificate + private key (prod) or password (dev) | Certificate fingerprint, or `sha256(password)` |
| **Command key** `K_d` | Lets the device verify a command really came from the server, and lets the server verify the device's reports | 32 bytes in encrypted NVS | **Nothing** — it is derived on demand |
| **Provisioning PoP** | One-time proof-of-possession for the BLE provisioning session | Nothing (used once) | Nothing (derived) |

**Never shared between devices.** Not one byte. There is no fleet password, no
shared PSK and no master unlock code anywhere in this design.

### 2.2 The command key is derived, not stored

```
K_d = HMAC-SHA256(DEVICE_COMMAND_HMAC_SECRET, "safelock:device-cmd:v1:" + keyVersion + ":" + serial)
```

One server-side master secret, one key per device, **no per-device key at rest on
the server**. This is the same move `OTP_HMAC_SECRET` makes and the same domain
separation the `pwreset:v1:` prefix makes: a database leak yields no device key,
because no device key is in the database.

The alternative — a random per-device key — would have to be stored
*reversibly* (HMAC verification needs the key, not a digest of it), which means
either plaintext secrets in a table or an envelope-encryption dependency. Both
are worse than a single secret held in the environment, where the OTP secret
already lives.

`keyVersion` is part of the derivation **and** part of every command (§3.1), so
rotation is possible without a flag day: the server can sign with `kv=2` for
re-provisioned devices while `kv=1` devices keep working until they are
re-provisioned. Without the version in the message a device could not tell which
key to verify against, and rotating the master would brick the fleet.

### 2.3 Rotation and revocation

| Event | MQTT credential | Command key | Effect |
| --- | --- | --- | --- |
| `Device.status → RETIRED` | **Revoked** — certificate revoked / password row deleted at the broker, `credentialHash` nulled | Irrelevant once it cannot connect | Unit is off the fleet. Refused today if it has a live booking (`DEVICE_HAS_LIVE_BOOKING`) |
| `Device.status → NEEDS_INSPECTION` | **Kept** | **Kept** | See below |
| Suspected credential compromise | Revoked, new one issued, device re-provisioned | Re-derived at the new `keyVersion` | |
| Master secret rotation | Untouched | `keyVersion` bumped; devices re-provisioned one at a time | Old devices keep working on `kv=n-1` |
| Unit lost or stolen | Revoked immediately | — | Admin action, audited |

**`NEEDS_INSPECTION` deliberately keeps its credential, and I want to flag that
as a disagreement with the brief.** The brief asks that neither retirement nor
`NEEDS_INSPECTION` leave a live credential. For retirement that is right. For
`NEEDS_INSPECTION` it would be actively harmful: that status means *a booking
ended and we do not know what is inside the safe* — it is still in the field,
still ours, and an admin is about to need it to report its state and accept a
`LOCK`. Revoking its credential would make the one device that most needs
attention the one device nobody can reach.

What `NEEDS_INSPECTION` must guarantee is that no *user* command reaches it, and
that is already true and comes from somewhere better than a credential: the
device is excluded from the booking pick, so no booking exists, so
`assertCanOperate` has nothing to authorise. The credential authenticates a
transport; eligibility is decided in the service. Conflating the two would make
the physical-security guarantee depend on broker state.

**The credential stays; `UNLOCK` does not.** Keeping a live credential is not
the same as keeping a live safe, and the two must not be allowed to drift
together. So the command issuer refuses outright: `UNLOCK` is never published
to a device whose `status` is not `AVAILABLE`, checked under the device row
lock in the same transaction that allocates the sequence number, and answered
`409 DEVICE_NOT_OPERABLE`. `LOCK` is still permitted — a safe under inspection
is exactly a safe an admin may need to close, and locking is the safe
direction everywhere else in this system too.

That makes the guarantee independent of how the device got there. A booking
should not exist for an inspecting device, but "should not exist" is a
consequence of the booking pick, and a physical-security guarantee should not
rest on a `WHERE` clause three modules away. **Test:** an `UNLOCK` to a
`NEEDS_INSPECTION` device is refused and nothing is published, written
alongside the test that a `RETIRED` device's credential is revoked (§2.3), so
the two halves of "which safes can still be commanded" are read together.

### 2.4 Stamped, burned, and provisioned

| Stage | What happens |
| --- | --- |
| **Manufacture** | Serial laser-etched on the case **and** printed as a QR code. Written to a read-only NVS partition. ESP32 flash encryption and secure boot enabled and the eFuses burned — without flash encryption, NVS is readable off a desoldered chip |
| **Inventory** | `POST /admin/devices` registers the serial. Status `AVAILABLE`, `lockState LOCKED`, `online false`, no credential yet |
| **Credential issue** | `POST /admin/devices/:id/credential` mints the MQTT credential and shows it **once**. Only `sha256` / the fingerprint is stored. There is no endpoint that reads one back |
| **Provisioning** | Installer uses the app/CLI over BLE (§12) to hand the device its Wi-Fi credentials, MQTT credential and `K_d` |
| **First contact** | Device connects, publishes retained `status: online` and a `state`. The admin device row goes online. Only then is it genuinely bookable |

The serial maps to credentials **one to one, in both directions**: client id =
username = certificate CN = serial, and `K_d` is derived from the serial. There
is no lookup table to get out of sync, and a device cannot be handed another
device's identity without also being handed its serial — at which point it *is*
that device as far as the broker, the ACL and the signature all agree.

---

## 3. Command messages

### 3.1 Format

Published to `safelock/v1/<serial>/cmd`, QoS 1, **retain false**:

```json
{
  "v": 1,
  "kv": 1,
  "commandId": "cmve5a8ci0016m4w37nmdf0gj",
  "type": "UNLOCK",
  "serial": "SAFE-0001",
  "seq": 42,
  "issuedAt": "2026-10-18T18:14:24.491Z",
  "ttlMs": 15000,
  "sig": "k7Rb…"
}
```

| Field | Notes |
| --- | --- |
| `v` | Payload version. Must equal `1` or the device rejects with `BAD_VERSION` |
| `kv` | Command-key version (§2.2) |
| `commandId` | The `Command.id`. The only correlation key. Also the de-duplication key |
| `type` | `LOCK` \| `UNLOCK`. Two values, matching the two gateway methods — there is no parameterised `sendCommand` anywhere in this system, on purpose |
| `serial` | Repeated **inside** the signed payload, so a command cannot be lifted from one topic to another. §3.5 |
| `seq` | Strictly increasing per device. Allocated under the device row lock |
| `issuedAt` | Server wall clock, RFC 3339 UTC. Advisory — see §3.3 |
| `ttlMs` | Relative lifetime from receipt. Authoritative on the device |
| `sig` | `base64url(HMAC-SHA256(K_d, canonical))`, 32 bytes |

### 3.2 The signature

The HMAC is over a **canonical string**, never over the JSON:

```
safelock-cmd:v1|<kv>|<commandId>|<type>|<serial>|<seq>|<issuedAtEpochMs>|<ttlMs>
```

JSON is not canonical — key order, whitespace and number formatting all vary by
serialiser, so signing the bytes a particular library produced would make the
protocol depend on that library on both ends. A pipe-joined field list is
unambiguous, trivial in C, and cannot be made to parse differently by a
whitespace change.

The `safelock-cmd:v1` prefix is domain separation, so a command signature can
never collide with an ack or state signature (§4.3) computed under the same key.

**The signature is what makes a compromised broker survivable.** A broker that
can read every packet, inject any packet and impersonate the server still cannot
produce a valid `sig`, so it cannot open a safe. That is the property worth
having, and it is why the ACL in §1.3 is described as the second line rather
than the first.

### 3.3 Clocks: the ESP32 has no trusted one

A freshly booted ESP32 has no idea what time it is. Both mechanisms are
specified, with a clear division of labour:

**`ttlMs` is authoritative and always enforced.** On receipt the device records
`esp_timer_get_time()` and discards the command if it has not completed within
`ttlMs`. This needs no wall clock at all, only the monotonic counter, which is
available from the first instruction.

**`issuedAt` is an extra check, used only when SNTP has synced.** If the device
has a synced clock it additionally rejects a command whose `issuedAt` is more
than `ttlMs + CLOCK_SKEW_MS` (60s) in the past, or more than `CLOCK_SKEW_MS` in
the future. This catches a command that sat in a broker queue or a captured
packet replayed later from a different path.

**With no time source, the protocol is still safe, and this is the important
part: replay protection comes from `seq`, not from the clock.** A captured
command cannot be replayed because its sequence number is already spent — the
device has persisted `lastSeq` and will reject anything at or below it,
regardless of what time it thinks it is. The TTL is not a security control; it
exists so the device does not act on a command the *user* has already given up
on. Conflating the two would make the whole design depend on a clock the
hardware cannot guarantee.

A device whose SNTP sync fails must therefore **still operate normally**. It
reports `clockSynced: false` in its state messages, which the admin panel shows,
but it is not degraded.

### 3.4 Replay protection, and what the device does

The device holds `lastSeq` in NVS (survives reboot and power loss) and the last
8 `commandId`s in RAM. On every command, in this order:

1. `v` recognised? else ack `REJECTED` / `BAD_VERSION`
2. `kv` is a key it has? else `REJECTED` / `BAD_KEY_VERSION`
3. `serial` matches its own? else `REJECTED` / `WRONG_DEVICE`
4. `sig` valid, verified in **constant time**? else `REJECTED` / `BAD_SIGNATURE`
5. `commandId` seen recently? else continue; if seen, **re-ack the stored
   result** — do not act again
6. `seq > lastSeq`? else `REJECTED` / `SEQ_REPLAY`
7. Clock check per §3.3? else `REJECTED` / `EXPIRED`
8. Persist `lastSeq = seq`, **then** drive the bolt

Signature before sequence, so an unauthenticated packet can never consume a
sequence number — otherwise anyone able to publish could wedge a device by
sending `seq: 2^31`.

Note step 5 re-acks rather than ignoring: a QoS 1 duplicate must produce an
answer, or a legitimate retry whose first ack was lost looks like silence.

**Every rejection is acked.** A device that silently drops a command it dislikes
is indistinguishable from a device that is offline, and those two need different
answers in the UI and different escalation. The reason code is what makes a
rejection diagnosable.

### 3.5 Sequence allocation

`Device.commandSeq Int @default(0)`, incremented inside the same transaction
that creates the `Command`, under the **existing** `SELECT … FOR UPDATE` on the
device row:

```sql
UPDATE "Device" SET "commandSeq" = "commandSeq" + 1 WHERE "id" = $1 RETURNING "commandSeq"
```

The row lock is already taken by `lockDeviceRow` for exactly this kind of
reason, so monotonicity costs nothing new and two concurrent taps cannot be
allocated the same number. A rolled-back transaction leaves a gap in the
sequence, which is fine — the device requires *increasing*, not *contiguous*.

---

## 4. Ack and state messages

### 4.1 Ack

Published to `safelock/v1/<serial>/ack` on **every** command, including rejections:

```json
{
  "v": 1,
  "commandId": "cmve5a8ci0016m4w37nmdf0gj",
  "seq": 42,
  "result": "OK",
  "reason": null,
  "lockState": "UNLOCKED",
  "doorState": "CLOSED",
  "measuredAtUptimeMs": 918273,
  "bootId": "a3f1…",
  "sig": "Qp2…"
}
```

| `result` | Meaning |
| --- | --- |
| `OK` | The command was accepted and the mechanism reached the requested state |
| `REJECTED` | The device refused it before acting. Nothing moved |
| `FAILED` | It tried and the mechanism did not get there |

`reason` is a closed enum, required for `REJECTED` and `FAILED`, null for `OK`:

```
BAD_VERSION  BAD_KEY_VERSION  WRONG_DEVICE  BAD_SIGNATURE  SEQ_REPLAY
DUPLICATE    EXPIRED          UNSUPPORTED
MOTOR_FAULT  JAMMED           DOOR_OBSTRUCTED  LOW_POWER  SENSOR_FAULT
```

The first group is the device refusing (`REJECTED`), the second is the mechanism
failing (`FAILED`). Keeping them one enum with two groups means a reason always
implies its result, and the server validates that it does.

**`lockState` and `doorState` are the measured physical state, not the
requested one**, and the server stores the measurement. That has a consequence
worth stating: a `FAILED` ack that reports `lockState: "UNLOCKED"` still moves
`Device.lockState` to `UNLOCKED`. The command failed; the safe is open; the
dashboard must say the safe is open. Recording the intent instead of the
measurement is how a product ends up telling someone their safe is locked while
it stands open.

`doorState` is `CLOSED` \| `OPEN` \| `UNKNOWN`, with `UNKNOWN` for a unit with
no door sensor fitted. Nullable would invite "absent means closed", which is the
wrong direction to guess in.

### 4.2 State

Published to `safelock/v1/<serial>/state`, **retained**, on every state change
and as a heartbeat every `DEVICE_HEARTBEAT_SECONDS` (60):

```json
{
  "v": 1,
  "lockState": "LOCKED",
  "doorState": "CLOSED",
  "firmwareVersion": "1.0.3",
  "rssi": -62,
  "lastSeq": 42,
  "bootId": "a3f1…",
  "clockSynced": true,
  "reason": "HEARTBEAT",
  "uptimeMs": 918273,
  "sig": "Lm9…"
}
```

`reason` is `BOOT` \| `CHANGE` \| `HEARTBEAT` \| `COMMAND`. A `BOOT` report is
how the server learns a device restarted; `bootId` (random per boot) is how it
learns that even if it missed the report.

**On change *and* on a heartbeat.** On change alone, a lost message means a
permanently wrong dashboard. On a heartbeat alone, the UI lags by up to a
minute. Both, and the heartbeat doubles as the liveness signal in §9.

`rssi` is included because the single most likely field failure is a safe on the
edge of Wi-Fi range, and that is far cheaper to diagnose from a number than from
a site visit.

### 4.3 Signing device reports

Acks and state reports are signed with the same `K_d`, over the same canonical
style with their own prefixes:

```
safelock-ack:v1|<commandId>|<seq>|<result>|<reason|->|<lockState>|<doorState>|<bootId>|<measuredAtUptimeMs>
safelock-state:v1|<lockState>|<doorState>|<firmwareVersion>|<lastSeq>|<bootId>|<uptimeMs>|<reason>
```

**Why bother, given that a forged ack cannot open a safe.** It cannot — and that
is the point at which a reasonable person stops. But an unsigned report lets a
compromised broker rewrite the *security record* of a physical safe: forge
`UNLOCK_CONFIRMED` events the owner never caused, or show `LOCKED` on a safe
standing open. For this product the record is close to the product. The device
already holds `K_d` and an HMAC-SHA256 over ~100 bytes is microseconds on an
ESP32, so the cost is nil.

An invalid signature on an inbound message is **dropped, audited
(`DEVICE_MESSAGE_SIGNATURE_INVALID`) and never applied**. "Cannot verify" must
never degrade to "accept" — the same rule the Razorpay and WhatsApp webhooks
already follow.

State reports are replayable by design (they are retained, and a retained
message is re-delivered). That is harmless: `§5.4`'s ordering rules mean a stale
report cannot walk the record backwards, the same way the WhatsApp delivery
webhook is idempotent by status rank.

### 4.4 Status, last will and online detection

`safelock/v1/<serial>/status`, retained, QoS 1:

```json
{ "v": 1, "online": true, "bootId": "a3f1…", "firmwareVersion": "1.0.3" }
```

Published with `retain: true` immediately after a successful connect. The MQTT
**last will and testament** is registered at connect time as the same topic
with:

```json
{ "v": 1, "online": false }
```

also retained, so the broker publishes it when the device drops without a clean
disconnect. On a *clean* disconnect the device publishes the offline payload
itself first.

Status messages are **not signed**, and that is deliberate: the LWT is composed
by the device at connect time and published by the *broker* later, so the broker
would have to be trusted to hold a signature anyway, and a forged
`online: false` is a denial of service a hostile broker can achieve by simply
dropping packets. Liveness is not a security claim here — §9 derives `online`
from the heartbeat age as well, precisely so one retained flag is not the whole
answer.

---

## 5. Command lifecycle

### 5.1 The table

```prisma
model Command {
  id       String            @id @default(cuid())
  deviceId String
  /// Null for a system-issued command (completion lock, admin action).
  bookingId String?
  type     CommandType       // LOCK | UNLOCK
  status   CommandStatus     @default(PENDING)

  /// Monotonic per device. Allocated under the device row lock.
  seq      Int
  /// Publish attempts. A user command gets 1; a system LOCK retries.
  attempts Int               @default(0)

  issuedAt  DateTime         @default(now())
  /// issuedAt + COMMAND_TTL_MS. The server's authority on "too late".
  expiresAt DateTime
  sentAt    DateTime?
  ackedAt   DateTime?
  /// Set when an ack arrived after the row was already TIMED_OUT. §5.4
  lateAckedAt DateTime?

  failureCategory CommandFailureCategory?

  /// Who asked. Exactly one of these is set.
  userId String?
  /// SWEEPER | ADMIN | COMPLETION — a system actor, when userId is null.
  systemActor CommandActor?

  @@unique([deviceId, seq])
  @@index([status, expiresAt])
  @@index([deviceId, issuedAt])
}
```

`@@unique([deviceId, seq])` is the database insisting on what §3.5 computes.
`failureCategory` mirrors the ack reason enum plus `NO_ACK`, `PUBLISH_FAILED`
and `NOT_PUBLISHED` — a closed set, never a provider or broker string, exactly
as `OutboundFailureCategory` is.

### 5.2 States

| Status | Meaning | Set by |
| --- | --- | --- |
| `PENDING` | Row committed. Not yet published | the transaction |
| `SENT` | Broker accepted the publish (PUBACK) | the publisher, after commit |
| `ACKED` | Device acked `OK` | ack handler |
| `REJECTED` | Device acked `REJECTED` — nothing moved | ack handler |
| `FAILED` | Device acked `FAILED` — it tried, mechanism did not get there | ack handler |
| `TIMED_OUT` | `SENT`, no ack by `expiresAt` | sweeper |
| `EXPIRED` | Never published before `expiresAt` | sweeper |

`EXPIRED` and `TIMED_OUT` are distinct because they fail differently.
`TIMED_OUT` means the device did not answer — it may well have acted, and the
state is genuinely unknown. `EXPIRED` means the command never left the building
(broker down, or the process died between commit and publish), so we know
nothing moved. One needs reconciliation; the other needs a retry.

`COMMAND_TTL_MS` is **15 000** for a user-triggered command, matching the figure
CLAUDE.md has carried since step 4, and chosen to sit under the ~20s a person
will stare at a spinner.

### 5.3 The flow

```
┌─ transaction ─────────────────────────────────────────────┐
│ claim the unlock challenge (conditional update)           │
│ lockDeviceRow(deviceId)            ← FOR UPDATE           │
│ assertCanOperate(…, tx)            ← guard #2, under lock │
│ seq = UPDATE Device SET commandSeq = commandSeq+1 RETURNING│
│ Command.create({ PENDING, seq, expiresAt })               │
│ audit                                                     │
└─ commit ──────────────────────────────────────────────────┘
          ↓   nothing has been published yet
  gateway.sendUnlock(serial, command)   ← publish, outside the tx
          ↓
  Command → SENT        (or EXPIRED / failureCategory PUBLISH_FAILED)
          ↓
  202 { commandId, status: "SENT" }     ← the user's answer
          ↓   …device acts…
┌─ ack transaction ─────────────────────────────────────────┐
│ verify signature, verify commandId belongs to this device │
│ Command → ACKED / REJECTED / FAILED                       │
│ Device.lockState ← the **measured** state                 │
│ DeviceEvent(UNLOCK_CONFIRMED | UNLOCK_FAILED)             │
│ notifier.notifyUnlock(tx, …)        ← still atomic        │
│ consume the unlock challenge                              │
└───────────────────────────────────────────────────────────┘
```

**No publish happens inside a transaction, and no row lock is held across the
radio.** This is the whole point of the change, and it is the same rule the
outbox already follows for WhatsApp, for the same two reasons: a rollback cannot
un-publish, and a transaction that waits on a network round trip makes the
network outage fatal. Today's code calls the gateway inside the transaction while
holding the device row lock — correct for an in-process mock, and documented as
unacceptable over MQTT because it serialises the fleet behind one slow radio.

**Both existing eligibility guards are kept, and no third is added.**
`requestUnlock` checks at code-issue time; the confirm transaction re-checks
under the row lock. A guard at ack time would be theatre: by then the bolt has
moved, and refusing to *record* an unlock that physically happened is strictly
worse than recording it.

### 5.4 When `UNLOCK_CONFIRMED` is written, and what the user sees

**`UNLOCK_CONFIRMED` is written when the ack arrives, not when the command is
sent.** The event feed is the user-visible security record of a physical safe,
and the fact worth recording is that the bolt moved. Writing it on the request
would make `/history` a log of intentions.

This moves `notifier.notifyUnlock` into the ack transaction, which **preserves**
its step-5 contract rather than weakening it: the notification is still written
in the same transaction as the event it describes, so neither can exist without
the other. It is now atomic with the *true* event.

No `DeviceEvent` is written at confirm time at all. A row saying "a command was
sent" tells the owner nothing they did not just do, and `/history` is better for
not having one per unlock.

`UnlockFailureReason` gains four values for the new ways an unlock can fail
after a correct code: `DEVICE_TIMEOUT`, `DEVICE_REJECTED`, `DEVICE_FAILED`,
`DEVICE_OFFLINE`. Existing rows and existing reasons are untouched.

**What the user sees while pending.** `POST /devices/unlock/confirm` returns
**202** with `{ commandId, status, pollAfterMs }` instead of a device summary.
The dialog shows "Unlocking…" and polls `GET /devices/commands/:id` every second
for up to 20s, then stops and shows the timeout message. The endpoint is
`requireAuth` plus a check that the command belongs to the caller's current
booking. `GET /devices/lock` behaves the same way.

### 5.5 A late ack after `TIMED_OUT`

The rule, stated once: **a late ack updates the physical record and never
retracts what the user was told.**

**First, the timeout itself releases the code.** When the sweeper writes
`TIMED_OUT` it clears the challenge's `commandId` **in the same transaction as
the `Command` change** — one statement set, one commit. Two separate
transactions would leave a window in which the command is finished and the
code is still bound to it, and a user refreshing inside that window is told
their code is unusable for a command that has already given up on them. Since
it is one transaction, there is no such window: a timed-out command and a
released code become true together, and a sweeper that dies mid-pass leaves
neither.

Concretely, when an ack arrives for a command already `TIMED_OUT`:

1. The signature and device ownership are verified as normal.
2. `Device.lockState` is updated from the measurement. **Always.** The safe's
   actual state is not in dispute just because our timer expired.
3. The `Command` moves to `ACKED`/`REJECTED`/`FAILED` **and** stamps
   `lateAckedAt`, so the row records that we had already given up. A dashboard
   that showed "failed" and a database that says "acked" would otherwise be an
   unexplainable contradiction.
4. The `DeviceEvent` is written now — `UNLOCK_CONFIRMED` if the bolt moved.
   **The safe is open; the owner's security log must say so**, even though the
   request returned a failure. The in-app and WhatsApp notifications fire here,
   which is also when they are most useful: the user has been told it failed and
   needs to know it did not.
5. **A late `OK` consumes the challenge, and cancels any retry.** The code the
   timeout released in fact opened a safe, so it is spent: `consumedAt` is
   stamped — not `commandId` re-bound — and the code is dead forever. In the
   same transaction, any command still live for this device and challenge
   (a retry the user started after being told it failed, or a system `LOCK`
   queued by the reconciler in §8.3) is cancelled, because its premise was
   that the bolt had not moved and it has. Without both halves the released
   code would be a second use of a code that already worked — which is the one
   thing "single-use" has to mean. **Test:** one code, one timeout, one late
   `OK`, then a confirm with the same code — refused, and no second command
   row exists.
6. An ack for a command older than `COMMAND_LATE_ACK_MAX_MS` (10 minutes) is
   **dropped for command purposes** but its *state* is still applied, and the
   drop is audited. Past ten minutes the correlation is not worth trusting, but
   the measurement still is — the same shape of decision as the reminder
   staleness floor, where late is false but the underlying booking is still real.

An ack for a `commandId` that does not exist, or exists on a **different
device**, is dropped and audited (`DEVICE_ACK_FOREIGN_COMMAND`). A device may
only ack its own commands, checked by joining `Command.deviceId` to the serial
the message arrived on — not by trusting the payload.

Duplicate acks are idempotent: the terminal transition is a conditional update
(`WHERE status IN ('SENT','TIMED_OUT')`), so the second ack changes no command
row and writes no second event or notification.

### 5.6 The unlock challenge: bound at confirm, consumed at ack

A correct code now buys a *command*, and a command can fail after the code was
right. Burning the code for a motor fault would charge the user for our
hardware's mistake; leaving "single-use" loosely defined would be worse. So the
challenge gains a `commandId` column and the lifecycle splits in two:

```
verify code
  → UPDATE "UnlockChallenge" SET "commandId" = :id
      WHERE "id" = :c AND "commandId" IS NULL      ← the serialisation point

ACK OK              → consumedAt = now()   (dead forever)
TIMED_OUT / FAILED  → commandId = NULL     (retry with the same code)
REJECTED / EXPIRED  → commandId = NULL     (retry with the same code)

late ACK OK after a TIMED_OUT release
                    → consumedAt = now()   (dead forever; §5.5 step 5)
```

The last line is the one that keeps the invariant honest. A release is
provisional — it says *we have no evidence the bolt moved* — and evidence can
still arrive. When it does, the code goes back to being used, whether or not
it was handed out again in between.

**The concurrency property is unchanged.** Today's serialisation point is a
conditional `updateMany` on `consumedAt: null`; it becomes a conditional update
on `commandId: null`. Exactly one of N concurrent confirms wins, so exactly one
command is ever created — the loser still sees `OTP_NOT_FOUND`.

**Single-use stays literally true.** A code that opened a safe is consumed and
can never be used again. What is reusable is a code that *demonstrably did not
open anything* — which is not a used code, it is an unused one whose command
failed. Nothing is extended to make this work: the challenge keeps its original
`expiresAt`, and `attempts` is untouched, so the attacker's five guesses are
still five guesses inside the same five minutes.

**Bounded by `CHALLENGE_MAX_BINDS` (3).** Otherwise a jammed motor and a
determined user could spawn commands until the code expired. Past three, the
challenge is consumed and the user is told to request a new code.

The unbind happens wherever the terminal status is set — the ack handler for
`REJECTED`/`FAILED`, the sweeper for `TIMED_OUT`/`EXPIRED` — so there is no
path that leaves a challenge bound to a command that has finished.

### 5.7 The timeout sweeper

A fourth worker beside the outbox worker and the booking sweeper, started from
`server.ts` **only**, for the same reason as the other two: a loop that started
with `createApp()` would tick during the test suite and race every assertion.
Tests call `sweepCommands()` directly. `COMMAND_SWEEP_INTERVAL_MS` = 5 000.

Each pass:

- `SENT` and past `expiresAt` → `TIMED_OUT`, `failureCategory: NO_ACK`, the
  bound challenge released (`commandId = NULL`) **in the same transaction**,
  and for a user-triggered `UNLOCK` write `UNLOCK_FAILED` / `DEVICE_TIMEOUT`.
- `PENDING` and past `expiresAt` → `EXPIRED`, `NOT_PUBLISHED`, challenge
  released the same way.
- A **system** `LOCK` that timed out and is under `COMMAND_MAX_ATTEMPTS` (3) →
  re-issue with a fresh `seq` and a backoff (10s, 60s, 300s). §8.

Correctness does not depend on it, exactly as with the booking sweeper: the
command status endpoint derives "is this past its expiry" from the clock on
every read, so a wedged sweeper shows a user the right answer and merely leaves
rows untidy.

---

## 6. Offline devices

### 6.1 Deriving `online`

```
online = retained /status said online
         AND lastSeenAt is within DEVICE_OFFLINE_AFTER_SECONDS (180)
```

Both, because each misses something the other catches. The LWT catches a clean
drop in about a keepalive. The heartbeat age catches the case the LWT cannot: a
device still holding a TCP connection but wedged, or a broker that restarted and
lost its will. Three missed heartbeats before we call it offline, so one lost
packet is not an outage.

`lastSeenAt` advances on **any** authenticated inbound message — ack, state or
status. `online` is computed on read from `lastSeenAt`, not trusted from the
stored boolean, so the stored column can never be the stale authority. This is
the same reflex as `effectiveBookingStatus`.

### 6.2 What offline refuses

| Action | Offline behaviour |
| --- | --- |
| **Unlock request** (issue a code) | **Refused**, 409 `DEVICE_OFFLINE` |
| **Unlock confirm** | **Refused**, same code — re-checked under the row lock |
| **Lock** (user) | **Refused**, 409 `DEVICE_OFFLINE`. Not queued |
| **Lock** (system, on completion) | **Retried** with backoff, then escalated |
| **Lock** (system, reconciling an unexpected open) | Only ever issued *in response to* a live report, so the device is online by construction. Retried and escalated the same way (§8.3) |
| **Booking a safe** | Offline devices are excluded from the pick |

**Refusing the unlock request, before the code is sent, is the important one.**
Issuing an OTP for a safe that cannot receive a command spends the user's
WhatsApp send cap and their three-codes-per-ten-minutes allowance on a code that
cannot work. Refusing early with an accurate code costs them nothing.

**A user lock is refused rather than queued, and that is not a weakening of the
"never block locking" rule.** That rule is about *policy* gates — no OTP, no
settled fee, no verified phone needed to secure your safe — and it stands. This
is physics: we cannot reach the device. A queued lock that fires forty minutes
later is a command whose premise has expired, and would either show the safe as
locked when it is not (which `lockState`-moves-only-on-ack forbids) or sit
invisibly pending. "We cannot reach your safe right now" is the only honest
answer, and the UI pairs it with the physical remedy: the safe has a key.

**The system completion lock is the deliberate asymmetry**: nobody is waiting on
it, the correct end state is known and unambiguous, and the alternative is a
safe left open between renters. So that one retries. §8.

**Offline devices are excluded from the booking pick** (`online` fresh, in
addition to `status: AVAILABLE`). Renting someone a safe we cannot command is
selling a product that does not work. A device that goes offline *after* the
booking is made is not auto-cancelled — there is money involved and it may come
back within seconds — it raises an admin flag (§7) and refuses unlocks with a
clear code.

---

## 7. Admin visibility

Additions to the existing `/admin` panel, no new tab:

- **Devices tab** gains online/offline with `lastSeenAt` age, firmware version,
  RSSI, `clockSynced`, and a **Recent commands** expander per device (last 20:
  type, status, actor, latency, failure category).
- **Flagged devices**, surfaced the way the Bookings tab already opens on "needs
  attention". A device is flagged when any of:
  - offline **and** it has a live booking — someone has paid for a safe we
    cannot reach;
  - `COMMAND_FAILURE_FLAG_THRESHOLD` (3) consecutive `TIMED_OUT`/`FAILED`
    commands;
  - a completion `LOCK` that exhausted its retries (§8.1);
  - **reported `UNLOCKED` with no booking entitled to it** — flagged on issue
    of the reconciling `LOCK`, cleared when a report shows `LOCKED` (§8.3);
  - a tamper report (§11, when the hardware supports it).
- **Bookings tab** shows the device-unreachable flag on the affected row, beside
  the dropped-message count that is already there, and for the same reason: a
  renter who cannot open their safe must not be invisible.

Nothing in any admin response includes `credentialHash`, a signature, a key or a
sequence-signing input. The existing explicit-allow-list `select` discipline
covers this, and the test that asserts `OutboundMessage`'s exact column list
gets a sibling for `Command`.

---

## 8. Completion locking, retries, and the device fail-safe

### 8.1 Server side

`lockAfterCompletion` is today best-effort: it calls the gateway after the
commit and logs a failure. Under MQTT it becomes: create a `Command`
(`systemActor: COMPLETION`, no `userId`) after the completion commit, publish,
and let the ack handler settle it.

Retry and escalation:

1. No ack within 15s → `TIMED_OUT`, re-issue with a fresh `seq`. Backoff 10s,
   60s, 300s, `COMMAND_MAX_ATTEMPTS` = 3.
2. All attempts exhausted → `Device.lockCommandFailedAt` is stamped, the device
   is flagged for admins (§7), and an `AuditLog` row records it.
3. The device is **already** `NEEDS_INSPECTION` for every completion reason
   except `COLLECTED`, so for those the escalation adds urgency rather than
   state. For a `COLLECTED` booking whose lock never acked, the device goes to
   `NEEDS_INSPECTION` too — a safe that may be standing open must not be handed
   to the next renter, which is the same reasoning that status already exists
   for.

Step 3 is the part the current best-effort version cannot do, and it is what the
roadmap means by owing this path a real guarantee: today a safe can be recorded
closed while physically open.

### 8.2 Device side — the fail-safe (firmware requirements)

Normative requirements on the firmware. A simulator that violates any of these
is a useful test fixture; a device that does is a product recall.

1. **Default locked.** On boot, on power restore and after a watchdog reset, the
   bolt is driven to `LOCKED`. The device **must not** restore a last-known
   `UNLOCKED` state from NVS. Persisted state is for `lastSeq`, never for
   authority to be open.
2. **No command, no movement.** The bolt may be driven open **only** while
   processing a command that passed every check in §3.4. There is no local
   unlock path, no stored "unlock permitted" flag, no debug command, no master
   code, and no API that takes a code the device validates itself.
3. **A reboot abandons everything in flight.** A new `bootId` is generated, no
   command survives the restart, and `lastSeq` is read back from NVS before the
   first command is processed.
4. **Power loss is fail-secure.** Losing power mid-travel must leave the bolt
   mechanically where it is and must never drive it open. On restore the device
   re-asserts `LOCKED` — but if `doorState` is `OPEN` it reports honestly and
   does not drive a bolt into an open door. The mechanism this implies is a
   hardware question in §11.
5. **The device never decides eligibility.** It knows nothing about bookings,
   fees, users or OTPs, and must have no field in which such a thing could be
   expressed. Authorisation is settled server-side before a command exists —
   which is the same reason the `DeviceGateway` interface takes a serial and
   nothing else.

### 8.3 Reconciling a safe that should not be open

§8.1 handles the lock we *asked* for. This handles the one nobody asked for: a
safe that reports itself open when no booking entitles anyone to have it open.

A device reaches that state without any command of ours — a firmware fault, a
power event that left the bolt withdrawn, an inspection someone walked away
from, or simply a `COLLECTED` booking whose completion `LOCK` was lost and
whose retries were exhausted while the process was down. The common thread is
that the server's record and the physical world disagree, and the physical
world is the one holding somebody's property.

**The trigger, evaluated on every inbound `state` or `status` message:** the
device reports `lockState: UNLOCKED` and there is no booking whose effective
status permits it to be open. "Permits" is `unlockEligibility` on the device's
live booking, the same function the unlock path uses and derived from the same
server clock — not `Booking.status`, which a wedged sweeper can make stale, and
not a bare "has a booking", which would leave a safe open for a renter whose
collection window lapsed an hour ago.

**The response, in order:**

1. Issue a system `LOCK` (`systemActor: SWEEPER`, no `userId`, no
   `bookingId`), through the ordinary `Command` lifecycle — the same rows, the
   same seq allocation, the same ack handling. A reconcile is not a special
   kind of command, it is an ordinary command with a different reason for
   existing.
2. Flag the device for admins (§7) **immediately, on issue, not on failure.** A
   safe found open with nobody entitled to it is already an incident; that the
   lock then succeeded makes it a resolved one, not a non-event. The flag
   clears when a subsequent report shows `LOCKED`.
3. Write an `AuditLog` row (`DEVICE_UNEXPECTED_UNLOCKED_RECONCILED`) carrying
   the device id, the reported state, and the booking id and effective status
   that failed to permit it — ids and enum values only, as the audit scrubber
   requires.
4. **Retry with the same backoff and escalation as §8.1** — 10s, 60s, 300s,
   `COMMAND_MAX_ATTEMPTS` 3 — and on exhaustion stamp `lockCommandFailedAt`
   and move the device to `NEEDS_INSPECTION`. A safe we cannot close is not a
   safe to rent, and that is the status that already means exactly this.

**At most one reconcile in flight per device.** Issue is conditional on no live
system `LOCK` for the device, taken under the device row lock, so a device
heartbeating every 60s while jammed produces one retry chain and not one per
heartbeat. The same condition makes a reconnect storm harmless.

**This adds no queue of user-triggered commands, and must not be read as
softening §6.2.** A user `LOCK` to an offline device is still refused, 409
`DEVICE_OFFLINE`, never queued, because a person is standing there waiting for
an answer and "we cannot reach your safe" is the true one. The reconciler is
the opposite situation in every respect: nobody is waiting, the correct end
state is not a judgement call, and it only ever runs *because* a device just
spoke to us — it is reacting to a live connection, not holding an instruction
against a dead one. A queue is a promise about the future; this is a response
to the present.

**Why `lockState` still only moves on an ack.** The reconciler does not write
`LOCKED` when it publishes. It publishes, and the device's ack moves the state
exactly as for any other command. A device that reports open and never acks
the `LOCK` stays recorded as open — correctly, because it is — and escalates.

---

## 9. Broker choice

| | AWS IoT Core | HiveMQ Cloud | EMQX Cloud Serverless | Self-hosted Mosquitto |
| --- | --- | --- | --- | --- |
| Per-device credentials | mTLS certs, free, per-thing | Username/password per client | Username/password, or HTTP auth to our API | Password file, or dynamic-security |
| ACL model | Strongest: IAM policy with `${iot:ClientId}` substitution, attached to the cert | Per-credential topic permissions with wildcard substitution | Per-credential rules, or delegated to us | `pattern` ACLs with `%c`/`%u` |
| Cost at pilot scale | ~$1/M messages + $0.08/M min connected; pennies | Free to 100 connections, then ~$0.10/GB | Free tier, then usage | VM only (~$5/mo) |
| Ops burden | None, but AWS-shaped (fleet provisioning, IAM) | None | None | TLS certs, renewal, HA, backups, monitoring — ours |
| ap-south-1 / India | Yes | Yes | Yes | Wherever we put it |
| Lock-in | Real: fleet provisioning and policies are AWS concepts | Low: plain MQTT 5 | Low | None |

**Recommendation: HiveMQ Cloud for the pilot, AWS IoT Core as the scale path.**

HiveMQ gets us real per-device credentials with enforced topic ACLs and nothing
to operate, on plain MQTT 5, within the free tier for the first hundred safes.
AWS IoT Core has the better security model — a policy bound to a certificate,
with client-id substitution, is stronger than any password-based ACL — and it is
where this should end up once fleet provisioning and mTLS are worth the
complexity. Writing `MqttDeviceGateway` against plain MQTT 5 with
`mqtt.js` keeps both open: the difference between them is configuration and a
credential type, not code.

**EMQX's HTTP auth hook is tempting and I am declining it.** Having the broker
call our API to authenticate each device would make our database the credential
authority and give `credentialHash` a real job. It also couples device
connectivity to our API's availability: our API down means devices cannot
*reconnect*, which turns a web outage into a fleet outage. For a product that
physically opens safes, that trade is wrong.

**Self-hosting is rejected for production** and used for local development.
Mosquitto is excellent and the cost is attractive, but TLS certificate renewal,
availability and monitoring for the transport that opens physical safes is not
where a small team's operational attention should go.

**The API connects as a privileged server client** with its own credential
(§1.3), never as a device, and `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD` are
required when `DEVICE_GATEWAY=mqtt` — checked at boot by the env schema's
`superRefine`, with the same placeholder rejection the other secrets get, so a
half-configured deploy fails to start rather than failing at the first unlock.

**Local development is Mosquitto in Docker**, added to the existing
`docker-compose.yml` beside Postgres, with a generated password and ACL file so
the dev broker enforces the same topic rules as production. A protocol tested
only against a permissive broker is a protocol whose ACLs are untested.

---

## 10. Provisioning a new unit

Specification level only; the installer app is not in this task.

1. **Label and register.** Serial etched and QR-printed at manufacture.
   `POST /admin/devices` registers it.
2. **Issue the credential.** `POST /admin/devices/:id/credential` returns the
   MQTT password (or signs a CSR) and `K_d`, **once**. Only the hash or
   fingerprint is stored; no endpoint reads it back. The response is excluded
   from logging.
3. **Provision over BLE.** The ESP-IDF `wifi_prov_mgr` with the BLE transport,
   not a SoftAP captive portal. BLE keeps the installer's phone on the internet
   throughout (so the app can fetch the credential at the moment it is needed),
   avoids the captive-portal detection mess on both mobile OSes, and gives a
   proof-of-possession handshake out of the box. The PoP is derived from the
   printed QR, so physical possession of the unit is required to provision it.
   The session carries: Wi-Fi SSID + passphrase, broker host, MQTT credential,
   `K_d`, `kv`.
4. **Confirm.** The device connects, publishes retained `status: online` and a
   `BOOT` state. The admin row goes online with its firmware version, and only
   then is it genuinely rentable.
5. **Re-provisioning** is the same flow and is how both key rotation and
   credential rotation are performed. A device can be re-provisioned in the
   field without being re-registered, and its `Command` history is preserved.

A SoftAP portal stays the documented fallback for a unit whose BLE radio fails
provisioning, because a unit that cannot be provisioned is a unit that cannot be
sold.

---

## 11. Open questions — physical and safety

To document and decide with the hardware, **not** to solve in software. These go
to CLAUDE.md's open questions.

1. **Mechanical override, and who holds the key.** Every one of these safes
   needs a physical override, or a dead board means a locksmith and an angry
   renter. Who holds it, where it is stored, how its use is recorded, and
   whether a single master key across the fleet is acceptable (it is the obvious
   design and the obvious single point of failure). This is the largest
   unanswered question in the hardware phase.
2. **Power loss with belongings inside.** Mains-powered ESP32 plus what — a
   supercapacitor for the current command, a Li-ion cell for days of standby, or
   nothing? The answer decides whether a power cut is a non-event or a support
   call per safe.
3. **Fail-secure vs fail-safe.** Fire codes and common sense can point opposite
   ways here. A safe holding belongings should stay shut when power dies; a
   container a person could be inside must not. Likely a legal question.
4. **Tamper reporting.** A case-open switch and an accelerometer are both cheap.
   What is reported, to whom, and how fast? A tamper event that reaches an admin
   dashboard nobody is watching at 2am is not a control. The protocol has room:
   a `TAMPER` state reason and a flag, both unimplemented in v1.
5. **What happens to a renter's property if the device dies.** The abandoned-items
   question already open in CLAUDE.md, from the other direction: there the
   renter vanished, here the hardware did. Needs a process, and probably
   insurance.
6. **Multi-location.** The schema has no `location`, and one site is assumed.
   Adding sites touches the booking pick (which site did they book?), pricing
   (per-site rates?), the device list, and the Wi-Fi/broker topology. Worth
   deciding *before* the second site, not after.
7. **Firmware update path.** Not in this protocol. OTA over MQTT is the obvious
   route and it is also the obvious way to brick a fleet; it needs signed images,
   staged rollout and a rollback story of its own.
8. ~~**Door sensor fitted or not.**~~ **Decided (2026-10-19): units ship with a
   door sensor, and a unit without one is not supported for rentals.** The
   completion flow is the reason. Without a sensor "locked" cannot be
   distinguished from "bolt extended into thin air", so the one check that
   matters before handing a safe to the next renter — it is shut, and it is
   shut *with the door closed* — cannot be made at all. Every guarantee in §8
   degrades to an assertion about a motor.

   What stays in the protocol: `doorState` keeps `UNKNOWN`, and the server
   keeps accepting it. That is not a hedge against the decision, it is the
   honest answer for a **sensor that has failed** (`SENSOR_FAULT` is already in
   the ack reason enum) and for firmware mid-boot that has not yet read it.
   `UNKNOWN` therefore means *we do not know*, which is a fault to surface, and
   never *there is no sensor*, which is now an unsupported configuration. The
   admin panel shows a persistent `UNKNOWN` as a device fault, and a unit
   reporting it is flagged (§7) rather than quietly rented.

   **Recorded as unsupported, not as impossible.** The firmware will still run
   on a sensor-less board and the protocol still describes what it reports —
   someone will eventually build one for a demo. It must not enter the rental
   fleet, and it is excluded from the booking pick on the same footing as an
   offline device, for the same reason: renting a safe whose closure we cannot
   verify is selling a product that does not work.
9. **Enclosure Wi-Fi performance.** A metal safe is a Faraday cage. Antenna
   placement needs testing before units are ordered, and `rssi` in the state
   report exists to measure it in the field.

---

## 12. What this protocol deliberately does not do

- **No device-side authorisation.** No bookings, no fees, no OTPs on the device.
- **No free-text field anywhere.** Every reason, result and state is a closed
  enum, so nothing unbounded can reach a database column or a UI.
- **No secrets in logs or rows.** `K_d` is derived and never stored; the MQTT
  password is stored hashed; signatures are verified and discarded, never
  persisted — the same rule the Razorpay signature already follows.
- **No OTA, no provisioning-by-cloud, no device shadow.** All deferred.
- **No command queue on the device.** One command at a time; a second arriving
  while one is in flight is rejected `UNSUPPORTED`. A queue in a device that
  must default to locked is a way to be surprised later.

---

## 13. The simulator, and how its tests avoid passing vacuously

Firmware is out of scope, so a simulator stands in for it: a small MQTT client
that implements §3.4's check order, §4's three report types and §4.3's
signatures, and that can be told to **misbehave on purpose** — drop an ack,
ack late, replay a sequence number, forge a signature, report a state that
disagrees with the command, send a second command's ack first, reboot
mid-command, go silent.

Those misbehaviours are the only way to test the server paths that matter most:
`TIMED_OUT`, `DEVICE_ACK_FOREIGN_COMMAND`,
`DEVICE_MESSAGE_SIGNATURE_INVALID`, late-ack handling, §8.3's reconcile. They
also fail in the most expensive way available — **by passing**.

**The failure mode, concretely.** A test configures the simulator to forge a
signature, waits, and asserts the server recorded nothing. It passes. It also
passes if the simulator never connected, if the topic was misspelled, if the
broker rejected the publish on an ACL, if the misbehaviour flag was read before
it was set, or if the publish went to a device the test is not watching. In
every one of those cases the server recorded nothing *because nothing arrived*,
and the test's green tells us only that silence is silent. The assertion is
satisfied by the absence of the very thing it exists to exercise, which makes
it worse than no test: it is a test that reports the path as covered.

**The rule: every misbehaviour test must first assert the misbehaviour was
actually delivered, and only then assert how the server responded.** Two
assertions, in that order, with the delivery one non-negotiable.

Delivery is proved from the simulator side, which is the only side that knows
what it sent. The simulator records every publish it makes — topic, payload,
QoS, retain, the broker's PUBACK, and which misbehaviour was applied — and
exposes them:

```ts
sim.sent('SAFE-0001')             // every publish, in order
sim.lastAck('SAFE-0001')          // the ack payload as published
sim.appliedMisbehaviours()        // which flags actually fired, with the commandId
```

So the forged-signature test reads:

```ts
// 1. the misbehaviour was delivered
const ack = sim.lastAck(serial);
expect(sim.appliedMisbehaviours()).toEqual([
  { kind: 'FORGE_SIGNATURE', commandId },
]);
expect(ack.puback).toBe(true);        // the broker took it
expect(ack.sig).not.toBe(validSig);   // and it really is forged

// 2. and only now, what the server did with it
expect(await commandStatus(commandId)).toBe('SENT');   // not ACKED
expect(await auditActions()).toContain('DEVICE_MESSAGE_SIGNATURE_INVALID');
```

`appliedMisbehaviours()` is the load-bearing one: it is recorded at the point
the simulator *branches on the flag*, so it cannot be satisfied by a flag that
was set but never reached. A PUBACK alone would not do — it proves a packet
left, not that it left corrupted.

**Dropped acks need the inverse proof**, since there is no publish to point at.
The simulator records the command it received and the decision not to answer,
so the test asserts the command *arrived and was deliberately ignored*:

```ts
expect(sim.received(serial).map((c) => c.commandId)).toEqual([commandId]);
expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'DROP_ACK', commandId }]);
```

Without that first line, "no ack arrived" is indistinguishable from "no command
was ever sent", and the timeout test would pass against a gateway that
publishes nothing at all — which is precisely the regression it is there to
catch.

**This is the same discipline the WhatsApp tests already use.**
`FakeWhatsAppClient` records its sends and the suite asserts against the
recording rather than against an absence, for the same reason: a seam that can
be told to fail must also be able to prove it was asked to.
