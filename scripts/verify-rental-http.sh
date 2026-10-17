#!/usr/bin/env bash
# End-to-end HTTP verification of the rental flow against a live API.
set -u

# The script reads apps/api/.env relatively, so anchor the cwd to the repo.
cd "${REPO:-/c/Users/hasin/safe-lock}" || exit 2
if [ ! -f apps/api/.env ]; then
  echo "Run this from the safe-lock repo root (apps/api/.env not found)." >&2
  exit 2
fi
API_LOG="${API_LOG:-}"

API=http://localhost:4000/api/v1
ORIGIN=http://localhost:3000
JAR=$(mktemp)
ADMIN_JAR=$(mktemp)
STAMP=$(date +%s)
EMAIL="rent${STAMP}@example.com"
PASS='VerifyRental123!'
PHONE="98${STAMP: -8}"

pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1  ($3)"; pass=$((pass+1))
  else
    echo "  FAIL  $1  expected=$2 actual=$3"; fail=$((fail+1))
  fi
}
note() { echo ""; echo "== $1"; }

post() { # post <jar> <path> <json>
  curl -s -b "$1" -c "$1" -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
    -X POST "$API$2" -d "$3"
}
poststatus() {
  curl -s -o /dev/null -w '%{http_code}' -b "$1" -c "$1" -H 'Content-Type: application/json' \
    -H "Origin: $ORIGIN" -X POST "$API$2" -d "$3"
}
get() { curl -s -b "$1" -c "$1" "$API$2"; }
getstatus() { curl -s -o /dev/null -w '%{http_code}' -b "$1" -c "$1" "$API$2"; }

jqv() {
  python -c 'import sys,json
d=json.load(sys.stdin)
e=sys.argv[1]
print(eval(("d"+e) if e.startswith("[") else e))' "$1" 2>/dev/null
}

psql() { docker exec safelock-postgres psql -U safelock -d safelock -tAc "$1"; }

note "0. Setup: exactly one bookable safe"
# Deterministic on purpose. The device pick is oldest-available-first, so
# leaving earlier runs' safes in the pool makes every later assertion about
# "our" device a coin flip.
DEV_ID="dev_v${STAMP}"
SERIAL_EXPECT="SAFE-V${STAMP: -6}"
psql "DELETE FROM \"Payment\"" > /dev/null
psql "DELETE FROM \"Booking\"" > /dev/null
psql "UPDATE \"Device\" SET status='RETIRED'" > /dev/null
psql "INSERT INTO \"Device\" (id, \"serialNumber\", status, \"lockState\", online, \"createdAt\", \"updatedAt\") VALUES ('$DEV_ID', '$SERIAL_EXPECT', 'AVAILABLE', 'LOCKED', false, now(), now())" > /dev/null
check "exactly one bookable safe" "1" "$(psql "SELECT count(*) FROM \"Device\" WHERE status='AVAILABLE'")"

note "1. Signup"
SIGNUP=$(post "$JAR" /auth/signup "{\"name\":\"Rental Verify\",\"email\":\"$EMAIL\",\"phone\":\"$PHONE\",\"password\":\"$PASS\"}")
check "signup returns a user" "$EMAIL" "$(echo "$SIGNUP" | jqv "['user']['email']")"
check "no hasPaid on the public user" "False" "$(echo "$SIGNUP" | jqv "['user'].__contains__('hasPaid')")"
check "no deviceAllocated either" "False" "$(echo "$SIGNUP" | jqv "['user'].__contains__('deviceAllocated')")"

note "2. GET /bookings/current with no booking"
CUR=$(get "$JAR" /bookings/current)
check "booking is null" "None" "$(echo "$CUR" | jqv "['booking']")"
check "quote carries the hourly rate" "10000" "$(echo "$CUR" | jqv "['quote']['rates']['hourlyRatePaise']")"
check "quote prices every duration" "24" "$(echo "$CUR" | jqv "['quote']['options'].__len__()")"
check "2h is priced by the server" "20000" "$(echo "$CUR" | jqv "['quote']['options'][1]['pricePaise']")"
check "overstay hourly is 1.5x" "15000" "$(echo "$CUR" | jqv "['quote']['overstayHourlyPaise']")"

note "3. GET /devices/mine with no booking — null, not an error"
check "status" "200" "$(getstatus "$JAR" /devices/mine)"
check "device is null" "None" "$(get "$JAR" /devices/mine | jqv "['device']")"

note "4. Lock with no booking is refused"
LOCK=$(post "$JAR" /devices/lock '{}')
check "code" "NO_ACTIVE_BOOKING" "$(echo "$LOCK" | jqv "['error']['code']")"

note "5. Body cannot supply a price or an end time"
check "pricePaise rejected" "400" "$(poststatus "$JAR" /bookings '{"hours":2,"pricePaise":1}')"
check "endsAt rejected" "400" "$(poststatus "$JAR" /bookings '{"hours":2,"endsAt":"2030-01-01T00:00:00Z"}')"
check "0 hours rejected" "400" "$(poststatus "$JAR" /bookings '{"hours":0}')"
check "25 hours rejected" "400" "$(poststatus "$JAR" /bookings '{"hours":25}')"

note "6. POST /bookings — holds a safe, no money"
BOOK=$(post "$JAR" /bookings '{"hours":2}')
BID=$(echo "$BOOK" | jqv "['booking']['id']")
SERIAL=$(echo "$BOOK" | jqv "['booking']['serialNumber']")
check "status" "PENDING_PAYMENT" "$(echo "$BOOK" | jqv "['booking']['status']")"
check "effectiveStatus" "PENDING_PAYMENT" "$(echo "$BOOK" | jqv "['booking']['effectiveStatus']")"
check "price is the server's" "20000" "$(echo "$BOOK" | jqv "['booking']['pricePaise']")"
check "endsAt is null until paid" "None" "$(echo "$BOOK" | jqv "['booking']['endsAt']")"
check "holdExpiresAt is set" "True" "$(echo "$BOOK" | jqv "['booking']['holdExpiresAt'] is not None")"
check "landed on the one bookable safe" "$SERIAL_EXPECT" "$SERIAL"
echo "  booking=$BID safe=$SERIAL"

note "7. A held safe is not yet operable"
check "/devices/mine still null" "None" "$(get "$JAR" /devices/mine | jqv "['device']")"
check "lock refused" "NO_ACTIVE_BOOKING" "$(post "$JAR" /devices/lock '{}' | jqv "['error']['code']")"
check "collect refused" "409" "$(poststatus "$JAR" /bookings/$BID/collect '{}')"

note "8. One live booking per user"
check "second booking refused" "409" "$(poststatus "$JAR" /bookings '{"hours":1}')"
check "with the right code" "BOOKING_ALREADY_EXISTS" "$(post "$JAR" /bookings '{"hours":1}' | jqv "['error']['code']")"

note "9. The safe is held against everyone else"
OTHER_JAR=$(mktemp)
post "$OTHER_JAR" /auth/signup "{\"name\":\"Other Renter\",\"email\":\"other${STAMP}@example.com\",\"phone\":\"97${STAMP: -8}\",\"password\":\"$PASS\"}" > /dev/null
OTHER=$(post "$OTHER_JAR" /bookings '{"hours":1}')
check "other renter refused" "NO_DEVICES_AVAILABLE" "$(echo "$OTHER" | jqv "['error']['code']")"

note "10. The exclusion constraint, direct insert"
RAW=$(docker exec safelock-postgres psql -U safelock -d safelock -c \
  "INSERT INTO \"Booking\" (id,\"userId\",\"deviceId\",status,hours,\"startsAt\",\"endsAt\",\"reservedUntil\",\"pricePaise\",currency,\"hourlyRatePaise\",\"overstayMultiplierBps\",\"graceMinutes\",\"capHours\",\"collectionWindowMinutes\",\"overstayPaidPaise\",\"createdAt\",\"updatedAt\") SELECT 'bkg_clash_${STAMP}', \"userId\", \"deviceId\", 'ACTIVE', 1, \"startsAt\" + interval '10 minutes', \"startsAt\" + interval '70 minutes', \"reservedUntil\", 10000,'INR',10000,15000,15,24,30,0,now(),now() FROM \"Booking\" WHERE id='$BID'" 2>&1)
echo "$RAW" | grep -q "Booking_device_no_overlap" \
  && { echo "  PASS  overlapping insert rejected by the constraint"; pass=$((pass+1)); } \
  || { echo "  FAIL  overlapping insert was NOT rejected: $RAW"; fail=$((fail+1)); }

note "11. Order — the route works; the gateway call cannot be exercised"
#
# This machine's apps/api/.env has placeholder Razorpay keys
# (rzp_test_replace_me), so `razorpay.orders.create` fails upstream. That is
# itself worth asserting: it proves the route exists, the session and ownership
# checks passed, the amount was computed, and the failure is a clean 502 rather
# than a 500 or a half-written Payment row.
#
# With real test keys this step returns 200 with the amount, purpose, keyId and
# (for an overstay) quoteExpiresAt. The order-creation response shape is
# covered by the API suite against a mocked SDK; what cannot be covered without
# keys is the network call itself.
ORDER=$(post "$JAR" /bookings/$BID/order '{}')
check "placeholder keys give a clean 502" "PAYMENT_GATEWAY_ERROR" "$(echo "$ORDER" | jqv "['error']['code']")"
check "no Payment row was left behind" "0" "$(psql "SELECT count(*) FROM \"Payment\" WHERE \"bookingId\"='$BID'")"
check "the booking is untouched" "PENDING_PAYMENT" "$(psql "SELECT status FROM \"Booking\" WHERE id='$BID'")"
check "ordering someone else's booking is a 404" "404" "$(poststatus "$OTHER_JAR" /bookings/$BID/order '{}')"

# Stand in for the row the order endpoint would have written, so everything
# downstream — signature verification, settlement, activation — runs for real.
ORDER_ID="order_v${STAMP}"
psql "INSERT INTO \"Payment\" (id,\"userId\",\"bookingId\",purpose,\"razorpayOrderId\",amount,currency,status,\"createdAt\",\"updatedAt\") SELECT 'pm_v${STAMP}', \"userId\", id, 'BOOKING', '$ORDER_ID', \"pricePaise\", currency, 'CREATED', now(), now() FROM \"Booking\" WHERE id='$BID'" > /dev/null
check "seeded CREATED payment" "20000" "$(psql "SELECT amount FROM \"Payment\" WHERE \"razorpayOrderId\"='$ORDER_ID'")"
echo "  order=$ORDER_ID (seeded; see the note above)"

note "12. Webhook activates the booking (clock starts now)"
# Back-date creation by 50 minutes so 'the clock starts at payment' is visible.
psql "UPDATE \"Booking\" SET \"startsAt\" = now() - interval '50 minutes' WHERE id='$BID'" > /dev/null
SECRET=$(grep '^RAZORPAY_WEBHOOK_SECRET=' apps/api/.env | cut -d= -f2-)
PAYID="pay_v${STAMP}"
BODY="{\"entity\":\"event\",\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"$PAYID\",\"order_id\":\"$ORDER_ID\",\"amount\":20000,\"currency\":\"INR\",\"status\":\"captured\"}}}}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
WH=$(curl -s -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $SIG" \
  -H "X-Razorpay-Event-Id: evt_v${STAMP}" -X POST "$API/payments/webhook" -d "$BODY")
check "webhook accepted" "True" "$(echo "$WH" | jqv "['received']")"
check "not a duplicate" "False" "$(echo "$WH" | jqv "['duplicate']")"

CUR=$(get "$JAR" /bookings/current)
check "booking is ACTIVE" "ACTIVE" "$(echo "$CUR" | jqv "['booking']['status']")"
check "endsAt is now set" "True" "$(echo "$CUR" | jqv "['booking']['endsAt'] is not None")"
MINS_LEFT=$(psql "SELECT round(extract(epoch from (\"endsAt\" - now()))/60) FROM \"Booking\" WHERE id='$BID'")
echo "  minutes left: $MINS_LEFT (should be ~120, not ~70 — the clock started at payment)"
[ "${MINS_LEFT:-0}" -gt 115 ] && { echo "  PASS  full 2h granted despite a 50-minute-old booking"; pass=$((pass+1)); } \
                         || { echo "  FAIL  only $MINS_LEFT minutes granted"; fail=$((fail+1)); }

note "13. Duplicate webhook is idempotent"
WH2=$(curl -s -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $SIG" \
  -H "X-Razorpay-Event-Id: evt_v${STAMP}" -X POST "$API/payments/webhook" -d "$BODY")
check "flagged duplicate" "True" "$(echo "$WH2" | jqv "['duplicate']")"
check "payment count still 1" "1" "$(psql "SELECT count(*) FROM \"Payment\" WHERE \"razorpayOrderId\"='$ORDER_ID'")"

note "14. The safe is now operable"
MINE=$(get "$JAR" /devices/mine)
check "serial matches" "$SERIAL" "$(echo "$MINE" | jqv "['device']['serialNumber']")"
check "no allocatedAt field" "False" "$(echo "$MINE" | jqv "['device'].__contains__('allocatedAt')")"
LOCK=$(post "$JAR" /devices/lock '{}')
check "lock succeeds" "True" "$(echo "$LOCK" | jqv "['alreadyLocked']")"

note "15. Unlock needs a verified phone"
# Asserted on /unlock/confirm rather than /unlock/request: the per-user request
# limiter allows 3 per 10 minutes and this script has exactly 3 to spend.
CONFIRM=$(post "$JAR" /devices/unlock/confirm '{"otp":"123456"}')
check "confirm refused" "PHONE_NOT_VERIFIED" "$(echo "$CONFIRM" | jqv "['error']['code']")"
psql "UPDATE \"User\" SET \"phoneVerifiedAt\"=now(), \"whatsappConsentAt\"=now(), \"whatsappConsentVersion\"=1 WHERE email='$EMAIL'" > /dev/null
UNLOCK=$(post "$JAR" /devices/unlock/request '{}')
check "now allowed, and no code in the response" "True" \
  "$(echo "$UNLOCK" | jqv "['expiresAt'] is not None and not any(k for k in d if 'code' in k.lower() or 'otp' in k.lower())")"

note "16. Overstay — fee accrues, derived from the clock before any sweep"
# endsAt 75 minutes ago: past the 15-minute grace, so one chargeable hour.
psql "UPDATE \"Booking\" SET \"startsAt\"=now() - interval '190 minutes', \"endsAt\"=now() - interval '70 minutes' WHERE id='$BID'" > /dev/null
CUR=$(get "$JAR" /bookings/current)
check "stored status still ACTIVE" "ACTIVE" "$(echo "$CUR" | jqv "['booking']['status']")"
check "effectiveStatus is OVERSTAY" "OVERSTAY" "$(echo "$CUR" | jqv "['booking']['effectiveStatus']")"
check "one chargeable hour" "1" "$(echo "$CUR" | jqv "['booking']['overstayHours']")"
check "fee is 1 x 15000" "15000" "$(echo "$CUR" | jqv "['booking']['overstayFeePaise']")"

note "17. Unlock refused, lock still allowed, collect refused"
# One request only: the per-user limiter allows 3 per 10 minutes and this
# script has a budget to keep. The confirm limiter is separate and roomier.
UNLOCK=$(post "$JAR" /devices/unlock/request '{}')
check "unlock request refused with the fee code" "OVERSTAY_PAYMENT_REQUIRED" "$(echo "$UNLOCK" | jqv "['error']['code']")"
check "unlock confirm 402" "402" "$(poststatus "$JAR" /devices/unlock/confirm '{"otp":"123456"}')"
check "confirm refused with the same code" "OVERSTAY_PAYMENT_REQUIRED" \
  "$(post "$JAR" /devices/unlock/confirm '{"otp":"123456"}' | jqv "['error']['code']")"
check "LOCK still works" "200" "$(poststatus "$JAR" /devices/lock '{}')"
COLLECT=$(post "$JAR" /bookings/$BID/collect '{}')
check "collect refused" "OVERSTAY_PAYMENT_REQUIRED" "$(echo "$COLLECT" | jqv "['error']['code']")"
check "booking not completed" "" "$(psql "SELECT coalesce(\"completedAt\"::text,'') FROM \"Booking\" WHERE id='$BID'")"
check "safe still AVAILABLE (reserved, not released)" "AVAILABLE" "$(psql "SELECT status FROM \"Device\" WHERE id='$DEV_ID'")"

note "18. Extension refused while a fee is owed"
EXT=$(post "$JAR" /bookings/$BID/extend/order '{"hours":1}')
# EXTENSION_NOT_AVAILABLE, not PAYMENT_GATEWAY_ERROR: the refusal happens
# before any order is created, which is the ordering that matters.
check "code" "EXTENSION_NOT_AVAILABLE" "$(echo "$EXT" | jqv "['error']['code']")"

note "19. Overstay quote — amount computed, then seeded past the gateway"
FEE_ORDER=$(post "$JAR" /bookings/$BID/overstay/order '{}')
check "gateway unreachable, cleanly" "PAYMENT_GATEWAY_ERROR" "$(echo "$FEE_ORDER" | jqv "['error']['code']")"
# The amount it was about to charge is visible in the log line the failure
# wrote, and in the booking's own fee. Seed the row with that amount.
FEE_ORDER_ID="order_fee${STAMP}"
psql "INSERT INTO \"Payment\" (id,\"userId\",\"bookingId\",purpose,\"razorpayOrderId\",amount,currency,status,\"quoteExpiresAt\",\"createdAt\",\"updatedAt\") SELECT 'pm_fee${STAMP}', \"userId\", id, 'OVERSTAY', '$FEE_ORDER_ID', 15000, currency, 'CREATED', now() + interval '15 minutes', now(), now() FROM \"Booking\" WHERE id='$BID'" > /dev/null
check "seeded OVERSTAY payment at the quoted fee" "15000" "$(psql "SELECT amount FROM \"Payment\" WHERE \"razorpayOrderId\"='$FEE_ORDER_ID'")"
check "with a quote TTL" "True" "$(psql "SELECT (\"quoteExpiresAt\" IS NOT NULL)::text FROM \"Payment\" WHERE \"razorpayOrderId\"='$FEE_ORDER_ID'" | sed 's/true/True/;s/false/False/')"

note "20. An expired quote whose fee outgrew it is flagged, not settled"
psql "UPDATE \"Payment\" SET \"quoteExpiresAt\" = now() - interval '20 minutes' WHERE \"razorpayOrderId\"='$FEE_ORDER_ID'" > /dev/null
# Four chargeable hours now, well past the 15000 paid.
psql "UPDATE \"Booking\" SET \"endsAt\"=now() - interval '250 minutes' WHERE id='$BID'" > /dev/null
BODY2="{\"entity\":\"event\",\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_fee${STAMP}\",\"order_id\":\"$FEE_ORDER_ID\",\"amount\":15000,\"currency\":\"INR\",\"status\":\"captured\"}}}}"
SIG2=$(printf '%s' "$BODY2" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -o /dev/null -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $SIG2" \
  -H "X-Razorpay-Event-Id: evt_fee${STAMP}" -X POST "$API/payments/webhook" -d "$BODY2"
check "payment stays PAID" "PAID" "$(psql "SELECT status FROM \"Payment\" WHERE \"razorpayOrderId\"='$FEE_ORDER_ID'")"
check "flagged for refund" "OVERSTAY_QUOTE_EXPIRED" "$(psql "SELECT \"reviewReason\" FROM \"Payment\" WHERE \"razorpayOrderId\"='$FEE_ORDER_ID'")"
check "overstay NOT settled" "" "$(psql "SELECT coalesce(\"overstaySettledAt\"::text,'') FROM \"Booking\" WHERE id='$BID'")"
check "fee still outstanding" "60000" "$(get "$JAR" /bookings/current | jqv "['booking']['overstayFeePaise']")"
check "collect still refused" "402" "$(poststatus "$JAR" /bookings/$BID/collect '{}')"

note "21. A fresh quote at the current fee settles"
FEE2_ID="order_fee2${STAMP}"
# The current fee, read from the API rather than recomputed here.
FEE_NOW=$(get "$JAR" /bookings/current | jqv "['booking']['overstayFeePaise']")
check "current fee is 4 hours" "60000" "$FEE_NOW"
psql "INSERT INTO \"Payment\" (id,\"userId\",\"bookingId\",purpose,\"razorpayOrderId\",amount,currency,status,\"quoteExpiresAt\",\"createdAt\",\"updatedAt\") SELECT 'pm_fee2${STAMP}', \"userId\", id, 'OVERSTAY', '$FEE2_ID', $FEE_NOW, currency, 'CREATED', now() + interval '15 minutes', now(), now() FROM \"Booking\" WHERE id='$BID'" > /dev/null
BODY3="{\"entity\":\"event\",\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_fee2${STAMP}\",\"order_id\":\"$FEE2_ID\",\"amount\":$FEE_NOW,\"currency\":\"INR\",\"status\":\"captured\"}}}}"
SIG3=$(printf '%s' "$BODY3" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -o /dev/null -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $SIG3" \
  -H "X-Razorpay-Event-Id: evt_fee2${STAMP}" -X POST "$API/payments/webhook" -d "$BODY3"
CUR=$(get "$JAR" /bookings/current)
check "fee cleared" "0" "$(echo "$CUR" | jqv "['booking']['overstayFeePaise']")"
check "collection window opened" "True" "$(echo "$CUR" | jqv "['booking']['collectBy'] is not None")"
check "paid recorded" "60000" "$(psql "SELECT \"overstayPaidPaise\" FROM \"Booking\" WHERE id='$BID'")"
check "unlock allowed again" "200" "$(poststatus "$JAR" /devices/unlock/request '{}')"

note "22. Collect now succeeds and returns the safe"
COLLECT=$(post "$JAR" /bookings/$BID/collect '{}')
check "status" "COMPLETED" "$(echo "$COLLECT" | jqv "['booking']['status']")"
check "reason" "COLLECTED" "$(echo "$COLLECT" | jqv "['booking']['completionReason']")"
check "safe back in the pool" "AVAILABLE" "$(psql "SELECT status FROM \"Device\" WHERE id='$DEV_ID'")"
check "safe commanded locked" "LOCKED" "$(psql "SELECT \"lockState\" FROM \"Device\" WHERE id='$DEV_ID'")"
check "open codes consumed" "0" "$(psql "SELECT count(*) FROM \"UnlockChallenge\" c JOIN \"User\" u ON u.id=c.\"userId\" WHERE u.email='$EMAIL' AND c.\"consumedAt\" IS NULL")"
check "/devices/mine null again" "None" "$(get "$JAR" /devices/mine | jqv "['device']")"
check "current booking null" "None" "$(get "$JAR" /bookings/current | jqv "['booking']")"
check "history still readable" "200" "$(getstatus "$JAR" /devices/history)"

note "23. The safe can be re-booked immediately"
REBOOK=$(post "$OTHER_JAR" /bookings '{"hours":1}')
check "other renter now succeeds" "PENDING_PAYMENT" "$(echo "$REBOOK" | jqv "['booking']['status']")"
check "on the same safe" "$SERIAL" "$(echo "$REBOOK" | jqv "['booking']['serialNumber']")"
REBOOK_ID=$(echo "$REBOOK" | jqv "['booking']['id']")

note "24. Lapsed hold: the clock says expired before the sweeper runs"
psql "UPDATE \"Booking\" SET \"holdExpiresAt\"=now() - interval '1 minute' WHERE id='$REBOOK_ID'" > /dev/null
check "current booking reads null" "None" "$(get "$OTHER_JAR" /bookings/current | jqv "['booking']")"
check "stored status still pending" "PENDING_PAYMENT" "$(psql "SELECT status FROM \"Booking\" WHERE id='$REBOOK_ID'")"
check "ordering refused" "409" "$(poststatus "$OTHER_JAR" /bookings/$REBOOK_ID/order '{}')"

note "25. Admin: force-complete flags the safe for inspection"
ADMIN_EMAIL=$(grep '^SEED_ADMIN_EMAIL=' apps/api/.env | cut -d= -f2-)
ADMIN_PASS=$(grep '^SEED_ADMIN_PASSWORD=' apps/api/.env | cut -d= -f2-)
LOGIN=$(post "$ADMIN_JAR" /auth/login "{\"identifier\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin signed in" "ADMIN" "$(echo "$LOGIN" | jqv "['user']['role']")"

psql "UPDATE \"Booking\" SET \"holdExpiresAt\"=now() + interval '10 minutes' WHERE id='$REBOOK_ID'" > /dev/null
check "reason is required" "400" "$(poststatus "$ADMIN_JAR" /admin/bookings/$REBOOK_ID/force-complete '{"reason":"x"}')"
FC=$(post "$ADMIN_JAR" /admin/bookings/$REBOOK_ID/force-complete '{"reason":"Renter unreachable for two days"}')
check "needsInspection defaults true" "True" "$(echo "$FC" | jqv "['needsInspection']")"
check "safe held for inspection" "NEEDS_INSPECTION" "$(psql "SELECT status FROM \"Device\" WHERE id='$DEV_ID'")"

note "25b. Retire is refused while a safe has a live booking"
# Re-open a live booking on the safe just long enough to assert the refusal.
psql "UPDATE \"Device\" SET status='AVAILABLE' WHERE id='$DEV_ID'" > /dev/null
psql "UPDATE \"Booking\" SET status='ACTIVE', \"completedAt\"=NULL, \"completionReason\"=NULL, \"endsAt\"=now() + interval '1 hour', \"reservedUntil\"=now() + interval '2 hours' WHERE id='$REBOOK_ID'" > /dev/null
RETIRE=$(post "$ADMIN_JAR" /admin/devices/$DEV_ID/retire '{}')
check "refused" "DEVICE_HAS_LIVE_BOOKING" "$(echo "$RETIRE" | jqv "['error']['code']")"
check "safe not retired" "AVAILABLE" "$(psql "SELECT status FROM \"Device\" WHERE id='$DEV_ID'")"
# Put it back the way step 25 left it.
psql "UPDATE \"Booking\" SET status='COMPLETED', \"completedAt\"=now(), \"completionReason\"='ADMIN_FORCE_COMPLETED', \"reservedUntil\"=now() WHERE id='$REBOOK_ID'" > /dev/null
psql "UPDATE \"Device\" SET status='NEEDS_INSPECTION' WHERE id='$DEV_ID'" > /dev/null

note "26. A flagged safe is out of the pool"
THIRD_JAR=$(mktemp)
post "$THIRD_JAR" /auth/signup "{\"name\":\"Third Renter\",\"email\":\"third${STAMP}@example.com\",\"phone\":\"96${STAMP: -8}\",\"password\":\"$PASS\"}" > /dev/null
check "the safe is flagged" "NEEDS_INSPECTION" "$(psql "SELECT status FROM \"Device\" WHERE id='$DEV_ID'")"
check "so nobody can book it" "NO_DEVICES_AVAILABLE" "$(post "$THIRD_JAR" /bookings '{"hours":1}' | jqv "['error']['code']")"

note "27. Clear inspection needs a note, then returns it to the pool"
check "note required" "400" "$(poststatus "$ADMIN_JAR" /admin/devices/$DEV_ID/clear-inspection '{}')"
CI=$(post "$ADMIN_JAR" /admin/devices/$DEV_ID/clear-inspection '{"note":"Opened at the desk, empty"}')
check "back in the pool" "AVAILABLE" "$(echo "$CI" | jqv "['device']['status']")"
check "bookable again" "PENDING_PAYMENT" "$(post "$THIRD_JAR" /bookings '{"hours":1}' | jqv "['booking']['status']")"

note "28. Admin lists"
FLAGGED=$(get "$ADMIN_JAR" '/admin/bookings?flagged=true')
check "flagged list loads" "200" "$(getstatus "$ADMIN_JAR" '/admin/bookings?flagged=true')"
REFUNDQ=$(get "$ADMIN_JAR" '/admin/payments?needsReview=true')
check "refund queue has our flagged payment" "True" "$(echo "$REFUNDQ" | jqv "any(i['reviewReason'] == 'OVERSTAY_QUOTE_EXPIRED' for i in d['items'])")"
USERS=$(get "$ADMIN_JAR" '/admin/users?booked=true')
check "users tab has a current booking column" "True" "$(echo "$USERS" | jqv "all('currentBooking' in i for i in d['items'])")"
check "no purchase flags on user rows" "False" "$(echo "$USERS" | jqv "any('hasPaid' in i for i in d['items'])")"
DEVS=$(get "$ADMIN_JAR" '/admin/devices')
check "device rows carry currentBooking" "True" "$(echo "$DEVS" | jqv "all('currentBooking' in i for i in d['items'])")"
check "no owner field on device rows" "False" "$(echo "$DEVS" | jqv "any('owner' in i for i in d['items'])")"
check "no credentialHash anywhere" "False" "$(echo "$DEVS" | python -c "import sys;print('credentialHash' in sys.stdin.read())")"

note "29. Admin clears a flagged payment with a note"
PID=$(psql "SELECT id FROM \"Payment\" WHERE \"reviewReason\"='OVERSTAY_QUOTE_EXPIRED' AND \"reviewClearedAt\" IS NULL LIMIT 1")
check "note required" "400" "$(poststatus "$ADMIN_JAR" /admin/payments/$PID/clear-review '{}')"
check "cleared" "200" "$(poststatus "$ADMIN_JAR" /admin/payments/$PID/clear-review '{"note":"Refunded in the dashboard, rfnd_test"}')"
check "status untouched" "PAID" "$(psql "SELECT status FROM \"Payment\" WHERE id='$PID'")"
check "second clear refused" "409" "$(poststatus "$ADMIN_JAR" /admin/payments/$PID/clear-review '{"note":"again"}')"

note "30. Removed endpoints are gone"
check "/payments/me" "404" "$(getstatus "$JAR" /payments/me)"
check "/payments/order" "404" "$(poststatus "$JAR" /payments/order '{}')"
check "/admin/allocate-next" "404" "$(poststatus "$ADMIN_JAR" /admin/allocate-next '{"userId":"x"}')"
check "/admin/devices/:id/unassign" "404" "$(poststatus "$ADMIN_JAR" /admin/devices/$DEV_ID/unassign '{}')"

note "31. CSRF and auth still hold on the new routes"
check "booking write with no Origin" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Content-Type: application/json' -X POST "$API/bookings" -d '{"hours":1}')"
check "booking write with a bad Origin" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Content-Type: application/json' -H 'Origin: https://evil.example.com' -X POST "$API/bookings" -d '{"hours":1}')"
check "admin route as a normal user" "403" "$(getstatus "$JAR" /admin/bookings)"
check "booking route unauthenticated" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$API/bookings/current")"
check "someone else's booking is a 404" "404" "$(getstatus "$THIRD_JAR" /bookings/$BID)"

note "32. The sweeper reconciles without deciding"
psql "UPDATE \"Booking\" SET status='ACTIVE', \"completedAt\"=NULL, \"completionReason\"=NULL, \"endsAt\"=now() - interval '90 minutes', \"reservedUntil\"=now() - interval '30 minutes', \"overstaySettledAt\"=NULL, \"overstayPaidPaise\"=0 WHERE id='$BID'" > /dev/null
echo "  waiting up to 150s for a sweep (interval is 60s)..."
for i in $(seq 1 30); do
  ST=$(psql "SELECT status FROM \"Booking\" WHERE id='$BID'")
  [ "$ST" = "OVERSTAY" ] && break
  sleep 5
done
check "sweeper moved it to OVERSTAY" "OVERSTAY" "$(psql "SELECT status FROM \"Booking\" WHERE id='$BID'")"
# The reservation is pushed out *unless* another booking already holds this
# safe next, in which case it is clamped at that booking's start — the
# exclusion constraint is right to refuse an overlap, and forcing it was the
# bug this run found. Which case applies depends on whether step 27 left a
# live booking on the safe, so assert the right one.
NEXT_START=$(psql "SELECT coalesce(min(\"startsAt\")::text,'') FROM \"Booking\" WHERE \"deviceId\"='$DEV_ID' AND id <> '$BID' AND status IN ('PENDING_PAYMENT','ACTIVE','OVERSTAY')")
if [ -n "$NEXT_START" ]; then
  CLAMPED=$(psql "SELECT (\"reservedUntil\" <= '$NEXT_START'::timestamp)::text FROM \"Booking\" WHERE id='$BID'")
  check "reservation clamped at the next booking, not forced past it" "true" "$CLAMPED"
else
  RES=$(psql "SELECT CASE WHEN \"reservedUntil\" > now() THEN 'future' ELSE 'past' END FROM \"Booking\" WHERE id='$BID'")
  check "reservation pushed into the future" "future" "$RES"
fi
check "still not completed" "" "$(psql "SELECT coalesce(\"completedAt\"::text,'') FROM \"Booking\" WHERE id='$BID'")"
# And the sweep itself stayed healthy: a clamped row must not abort it.
if [ -n "$API_LOG" ] && [ -f "$API_LOG" ]; then
  SWEEP_FAILS=$(grep -c 'Booking sweep finished with failures' "$API_LOG" || true)
  check "no sweep aborted on the clamped row" "0" "${SWEEP_FAILS:-0}"
else
  echo "  SKIP  sweep-failure log check (set API_LOG to the API's log file)"
fi


note "30. Scheduled reminders: what activation queued"
# Deliberately reuses the sessions already established. Signup and login share
# a per-IP limiter (10 per 15 minutes) and this script is already close to it —
# two more accounts here would 429, and every assertion below would then fail
# for a reason that has nothing to do with reminders.
#
# So the main user books again, which first needs their overstayed booking from
# step 29 ended. An admin force-complete is the realistic way out of an unpaid
# overstay, and it exercises the cancellation path on the way.
post "$ADMIN_JAR" /admin/bookings/$BID/force-complete '{"reason":"Verification run: clearing an unpaid overstay"}' > /dev/null
check "the overstayed booking is force-completed" "COMPLETED" "$(psql "SELECT status FROM \"Booking\" WHERE id='$BID'")"

RPHONE=$(psql "SELECT phone FROM \"User\" WHERE email='$EMAIL'")

# A fresh safe, since force-completing sent the last one for inspection.
RDEV="dev_r${STAMP}"
psql "INSERT INTO \"Device\" (id, \"serialNumber\", status, \"lockState\", online, \"createdAt\", \"updatedAt\") VALUES ('$RDEV', 'SAFE-R${STAMP: -6}', 'AVAILABLE', 'LOCKED', false, now(), now())" > /dev/null

RBOOK=$(post "$JAR" /bookings '{"hours":3}')
RBID=$(echo "$RBOOK" | jqv "['booking']['id']")
check "a booking to remind about" "True" "$([ -n "$RBID" ] && echo True || echo False)"

# Nothing is scheduled before the money lands: the schedule starts at
# activation, because endsAt does not exist until then.
check "nothing scheduled while pending" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID'")"

# Activate it the way a webhook does. The order endpoint needs live Razorpay
# keys, so seed the Payment row it would have written — the same approach the
# earlier steps take — then let the real settlement path run.
RORDER="order_rem_${STAMP}"
psql "INSERT INTO \"Payment\" (id,\"userId\",\"bookingId\",purpose,\"razorpayOrderId\",amount,currency,status,\"createdAt\",\"updatedAt\") SELECT 'pm_rem${STAMP}', \"userId\", id, 'BOOKING', '$RORDER', \"pricePaise\", currency, 'CREATED', now(), now() FROM \"Booking\" WHERE id='$RBID'" > /dev/null

WSECRET=$(grep -E '^RAZORPAY_WEBHOOK_SECRET=' apps/api/.env | cut -d= -f2-)
settle() { # settle <orderId> <amountPaise> <eventSuffix>
  local body sig
  body="{\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_rzp_$3\",\"order_id\":\"$1\",\"amount\":$2,\"currency\":\"INR\",\"status\":\"captured\"}}}}"
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WSECRET" -hex | sed 's/^.*= //')
  curl -s -o /dev/null -X POST "$API/payments/webhook" \
    -H 'Content-Type: application/json' \
    -H "X-Razorpay-Signature: $sig" \
    -H "X-Razorpay-Event-Id: evt_$3" \
    -d "$body"
}

settle "$RORDER" 30000 "rem${STAMP}"

check "booking is ACTIVE" "ACTIVE" "$(psql "SELECT status FROM \"Booking\" WHERE id='$RBID'")"
check "four messages scheduled" "4" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID'")"
check "one confirmation" "1" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_CONFIRMED'")"
check "two reminders" "2" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_ENDING_SOON'")"
check "one overstay notice" "1" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='OVERSTAY_STARTED'")"

# The reminders sit exactly 30 and 10 minutes before the end.
check "reminder leads are 30 and 10 minutes" "30|10" "$(psql "SELECT string_agg(round(extract(epoch from (b.\"endsAt\" - m.\"sendAt\"))/60)::int::text, '|' ORDER BY m.\"sendAt\") FROM \"OutboundMessage\" m JOIN \"Booking\" b ON b.id = m.\"bookingId\" WHERE m.\"bookingId\"='$RBID' AND m.kind='BOOKING_ENDING_SOON'")"

# The overstay notice is a minute past the grace boundary, never on it: the fee
# is exactly zero at the boundary, and re-validation requires a fee to name.
check "overstay notice is grace + 60s" "60" "$(psql "SELECT round(extract(epoch from (m.\"sendAt\" - (b.\"endsAt\" + make_interval(mins => b.\"graceMinutes\")))))::int FROM \"OutboundMessage\" m JOIN \"Booking\" b ON b.id = m.\"bookingId\" WHERE m.\"bookingId\"='$RBID' AND m.kind='OVERSTAY_STARTED'")"

# The confirmation was due immediately, so the worker picks it up within a poll
# or two (5s by default).
for _ in 1 2 3 4 5; do
  [ "$(psql "SELECT status FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_CONFIRMED'")" != "PENDING" ] && break
  sleep 3
done
check "the confirmation was sent" "SENT" "$(psql "SELECT status FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_CONFIRMED'")"
check "the outbox has no column that could hold message text" "" "$(psql "SELECT coalesce(string_agg(column_name, ','), '') FROM information_schema.columns WHERE table_name='OutboundMessage' AND column_name IN ('params','body','text','message')")"

note "31. The extension block on GET /bookings/:id"
RDETAIL=$(get "$JAR" "/bookings/$RBID")
check "extension is offered" "True" "$(echo "$RDETAIL" | jqv "['extension']['allowed']")"
check "options are priced by the server" "10000" "$(echo "$RDETAIL" | jqv "['extension']['options'][0]['pricePaise']")"
check "and the client is told the maximum" "True" "$(echo "$RDETAIL" | jqv "['extension']['maxHours'] > 0")"
check "/bookings/current carries it too" "True" "$(get "$JAR" /bookings/current | jqv "['extension']['allowed']")"

note "32. Someone else's booking is a plain not-found"
# The admin's own session, used here as "another signed-in user".
# /bookings/:id is not an admin route, so this is exactly the forwarded-link
# case: the reply must not distinguish "not yours" from "does not exist".
check "status" "404" "$(getstatus "$ADMIN_JAR" "/bookings/$RBID")"
check "code" "BOOKING_NOT_FOUND" "$(get "$ADMIN_JAR" "/bookings/$RBID" | jqv "['error']['code']")"
check "same code for an id that does not exist" "BOOKING_NOT_FOUND" "$(get "$ADMIN_JAR" "/bookings/clx_nope_$STAMP" | jqv "['error']['code']")"
MSG_MINE=$(get "$ADMIN_JAR" "/bookings/$RBID" | jqv "['error']['message']")
MSG_NONE=$(get "$ADMIN_JAR" "/bookings/clx_nope_$STAMP" | jqv "['error']['message']")
check "same message, too" "True" "$([ "$MSG_MINE" = "$MSG_NONE" ] && echo True || echo False)"

note "33. An extension cancels the deadline messages and re-creates them"
OLD_KEYS=$(psql "SELECT coalesce(string_agg(\"dedupeKey\", '|' ORDER BY \"dedupeKey\"), '') FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind <> 'BOOKING_CONFIRMED'")
REXT="order_remext_${STAMP}"
psql "INSERT INTO \"Payment\" (id,\"userId\",\"bookingId\",purpose,\"razorpayOrderId\",amount,currency,status,\"createdAt\",\"updatedAt\") SELECT 'pm_remext${STAMP}', \"userId\", id, 'EXTENSION', '$REXT', 20000, currency, 'CREATED', now(), now() FROM \"Booking\" WHERE id='$RBID'" > /dev/null
settle "$REXT" 20000 "remext${STAMP}"

check "the booking gained hours" "5" "$(psql "SELECT hours FROM \"Booking\" WHERE id='$RBID'")"
check "old deadline rows are CANCELLED" "3" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND status='SKIPPED' AND \"failureCategory\"='CANCELLED'")"
check "deadline rows were re-created" "3" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind <> 'BOOKING_CONFIRMED' AND status='PENDING'")"
# The assumption the dedupe keys rest on: a re-created key never equals a
# cancelled one, or skipDuplicates would drop the new row silently.
NEW_KEYS=$(psql "SELECT coalesce(string_agg(\"dedupeKey\", '|' ORDER BY \"dedupeKey\"), '') FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind <> 'BOOKING_CONFIRMED' AND status='PENDING'")
check "no re-created key collides with a cancelled one" "False" "$([ "$OLD_KEYS" = "$NEW_KEYS" ] && echo True || echo False)"
check "every dedupeKey is still unique" "0" "$(psql "SELECT count(*) FROM (SELECT \"dedupeKey\" FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' GROUP BY \"dedupeKey\" HAVING count(*) > 1) d")"
check "a second confirmation was queued" "2" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_CONFIRMED'")"

note "34. Re-validation refuses a message whose booking moved on"
# Make one reminder due now, then end the booking with a direct row edit so no
# cancellation runs — which is what a forgotten cancellation path would look
# like. The reminder must still not be sent.
TARGET=$(psql "SELECT id FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_ENDING_SOON' AND status='PENDING' ORDER BY \"sendAt\" DESC LIMIT 1")
# The booking is ended FIRST, and the message made due second. The other order
# leaves a window — up to one poll interval — in which the row is due and the
# booking is still perfectly valid, so the worker sends it and is right to.
# That ordering cost two failures on the first run of this section.
psql "UPDATE \"Booking\" SET \"endsAt\"=now() - interval '1 minute' WHERE id='$RBID'" > /dev/null
psql "UPDATE \"OutboundMessage\" SET \"sendAt\"=now(), \"nextAttemptAt\"=now() WHERE id='$TARGET'" > /dev/null

for _ in 1 2 3 4 5; do
  [ "$(psql "SELECT status FROM \"OutboundMessage\" WHERE id='$TARGET'")" != "PENDING" ] && break
  sleep 3
done
check "the reminder was not sent" "SKIPPED" "$(psql "SELECT status FROM \"OutboundMessage\" WHERE id='$TARGET'")"
check "and re-validation is recorded as the reason" "NOT_APPLICABLE" "$(psql "SELECT \"failureCategory\" FROM \"OutboundMessage\" WHERE id='$TARGET'")"

note "35. A message claimed too late is dropped as STALE"
LATE=$(psql "SELECT id FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='BOOKING_ENDING_SOON' AND status='PENDING' LIMIT 1")
if [ -n "$LATE" ]; then
  # Due well beyond REMINDER_MAX_LATENESS_MINUTES (5 by default).
  psql "UPDATE \"OutboundMessage\" SET \"sendAt\"=now() - interval '45 minutes', \"nextAttemptAt\"=now() - interval '45 minutes' WHERE id='$LATE'" > /dev/null

  for _ in 1 2 3 4 5; do
    [ "$(psql "SELECT status FROM \"OutboundMessage\" WHERE id='$LATE'")" != "PENDING" ] && break
    sleep 3
  done
  check "status" "SKIPPED" "$(psql "SELECT status FROM \"OutboundMessage\" WHERE id='$LATE'")"
  check "dropped as stale, not sent late" "STALE" "$(psql "SELECT \"failureCategory\" FROM \"OutboundMessage\" WHERE id='$LATE'")"
else
  echo "  SKIP  staleness (no pending reminder left on this booking)"
fi

note "36. Settling an overstay fee: receipt queued, fee notices withdrawn"
# Push the booking into a real overstay, then settle through the webhook so the
# whole settlement path runs.
psql "UPDATE \"Booking\" SET status='OVERSTAY', \"endsAt\"=now() - make_interval(mins => \"graceMinutes\" + 61) WHERE id='$RBID'" > /dev/null
FEE=$(psql "SELECT (\"hourlyRatePaise\" * \"overstayMultiplierBps\" / 10000)::int FROM \"Booking\" WHERE id='$RBID'")
check "a fee is outstanding" "True" "$([ -n "$FEE" ] && [ "$FEE" -gt 0 ] && echo True || echo False)"
ROVER="order_remover_${STAMP}"
psql "INSERT INTO \"Payment\" (id,\"userId\",\"bookingId\",purpose,\"razorpayOrderId\",amount,currency,status,\"quoteExpiresAt\",\"createdAt\",\"updatedAt\") SELECT 'pm_remover${STAMP}', \"userId\", id, 'OVERSTAY', '$ROVER', $FEE, currency, 'CREATED', now() + interval '15 minutes', now(), now() FROM \"Booking\" WHERE id='$RBID'" > /dev/null
settle "$ROVER" "$FEE" "remover${STAMP}"

check "the fee is settled" "t" "$(psql "SELECT (\"overstaySettledAt\" IS NOT NULL) FROM \"Booking\" WHERE id='$RBID'")"
check "a receipt was queued" "1" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='OVERSTAY_SETTLED'")"
check "the collection reminder was scheduled" "1" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='COLLECTION_CLOSING'")"
check "no overstay notice is still pending" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='OVERSTAY_STARTED' AND status='PENDING'")"
check "the collection reminder is 10 minutes before the deadline" "10" "$(psql "SELECT round(extract(epoch from ((b.\"overstaySettledAt\" + make_interval(mins => b.\"collectionWindowMinutes\")) - m.\"sendAt\"))/60)::int FROM \"OutboundMessage\" m JOIN \"Booking\" b ON b.id = m.\"bookingId\" WHERE m.\"bookingId\"='$RBID' AND m.kind='COLLECTION_CLOSING'")"

# Settling the same payment twice must not produce a second receipt. A verified
# Checkout callback and a webhook are two deliveries of one payment, which is
# why the receipt is keyed on the payment rather than on the time.
settle "$ROVER" "$FEE" "remover2_${STAMP}"
check "a replayed capture queues no second receipt" "1" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND kind='OVERSTAY_SETTLED'")"

note "37. Collecting cancels everything still outstanding"
check "collect succeeds once the fee is paid" "200" "$(poststatus "$JAR" "/bookings/$RBID/collect" '{}')"
check "nothing is left pending" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND status='PENDING'")"

note "38. Booking messages are scoped out of the user budget"
# Carrying a bookingId is what moves a row onto the booking budget, so these
# two assertions are the structural half of the two-budget rule.
check "every lifecycle row belongs to a booking" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE kind IN ('BOOKING_CONFIRMED','BOOKING_ENDING_SOON','OVERSTAY_STARTED','OVERSTAY_SETTLED','COLLECTION_CLOSING') AND \"bookingId\" IS NULL")"
check "and no booking row claims a device event" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\" IS NOT NULL AND \"deviceEventId\" IS NOT NULL")"

note "39. A dropped message is visible to an admin"
DROPPED=$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"bookingId\"='$RBID' AND status='SKIPPED' AND \"failureCategory\" IN ('CAP_REACHED','STALE')")
ADMIN_ROW=$(get "$ADMIN_JAR" "/admin/bookings?pageSize=100" | python -c "
import sys, json
rows = json.load(sys.stdin)['items']
row = next((r for r in rows if r['id'] == '$RBID'), None)
print(row['undeliveredMessages'] if row else 'missing')
" 2>/dev/null)
check "the admin row counts the dropped ones" "$DROPPED" "$ADMIN_ROW"
check "and that is more than none" "True" "$([ "${DROPPED:-0}" -gt 0 ] && echo True || echo False)"

note "40. No one-time code can reach the outbox, scheduled or not"
check "no six-digit run in any dedupeKey" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"dedupeKey\" ~ ':[0-9]{6}$'")"
check "no phone number in any row" "0" "$(psql "SELECT count(*) FROM \"OutboundMessage\" WHERE \"dedupeKey\" LIKE '%${RPHONE}%'")"

echo ""
echo "================================="
echo "  PASS: $pass    FAIL: $fail"
echo "================================="
[ "$fail" -eq 0 ]
