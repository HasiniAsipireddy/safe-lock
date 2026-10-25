import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { SafeSize } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { TEST_ORIGIN, app, createTestUser, seedDevice } from '../../test/helpers';

/**
 * Safe sizes: a renter picks one before a duration, and it decides the price.
 *
 * Its own file rather than more cases in `bookings.routes.test.ts`, which is
 * already 1,000 lines about the booking lifecycle. The claims here are about a
 * different axis — which cabinet, at which rate — and they are the ones that
 * turn into money.
 *
 * Four things are pinned:
 *
 * 1. The correct **rate** is charged per size, and it is snapshotted.
 * 2. The requested size is a **hard filter** on the device pick, never a
 *    preference that can be upgraded away.
 * 3. A refusal **names what is free**, because that is the only remedy the
 *    user can act on immediately.
 * 4. The quote prices every (size, duration) pair, so the client never
 *    multiplies anything.
 */

const BOOKINGS_URL = '/api/v1/bookings';
const CURRENT_URL = '/api/v1/bookings/current';

/** The rates configured for the suite: ₹60 / ₹100 / ₹160 per hour. */
const RATE: Record<SafeSize, number> = { SMALL: 6_000, MEDIUM: 10_000, LARGE: 16_000 };

function post(url: string, cookie: string) {
  return request(app()).post(url).set('Origin', TEST_ORIGIN).set('Cookie', cookie);
}

function get(url: string, cookie: string) {
  return request(app()).get(url).set('Cookie', cookie);
}

describe('choosing a size', () => {
  it('requires a size, and rejects a value that is not one of the three', async () => {
    const user = await createTestUser();
    await seedDevice();

    const missing = await post(BOOKINGS_URL, user.cookie).send({ hours: 2 });
    expect(missing.status).toBe(400);

    const unknown = await post(BOOKINGS_URL, user.cookie).send({
      hours: 2,
      size: 'ENORMOUS',
    });
    expect(unknown.status).toBe(400);

    expect(await prisma.booking.count()).toBe(0);
  });

  it.each(['SMALL', 'MEDIUM', 'LARGE'] as const)(
    'charges the %s rate and snapshots the size onto the booking',
    async (size) => {
      const user = await createTestUser();
      await seedDevice({ size });

      const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 3, size });

      expect(response.status).toBe(201);
      expect(response.body.booking).toMatchObject({
        safeSize: size,
        pricePaise: RATE[size] * 3,
      });
      expect(response.body.booking.rates.hourlyRatePaise).toBe(RATE[size]);
    },
  );

  /**
   * The pick is **filtered**, not merely ordered.
   *
   * A renter who asked for a small safe must not be handed a large one: they
   * would pay the small rate for stock worth more, and a size that is
   * perpetually given away as a free upgrade is stock that never earns its
   * own price.
   */
  it('never hands out a size other than the one requested', async () => {
    const user = await createTestUser();
    await seedDevice({ size: 'LARGE' });

    const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 2, size: 'SMALL' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SIZE_NOT_AVAILABLE');
    // Nothing written: the refusal costs the user nothing to retry.
    expect(await prisma.booking.count()).toBe(0);
  });
});

describe('when the requested size is not free', () => {
  /** The refusal names what *is* free, so the page can offer it in one click. */
  it('lists the available sizes, smallest first, in fields and in the message', async () => {
    const user = await createTestUser();
    await seedDevice({ size: 'SMALL' });
    await seedDevice({ size: 'LARGE' });

    const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 2, size: 'MEDIUM' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SIZE_NOT_AVAILABLE');
    // Canonical order, not whatever the query planner happened to return.
    expect(response.body.error.fields).toEqual({ size: 'SMALL,LARGE' });
    expect(response.body.error.message).toMatch(/small and large/i);
  });

  /**
   * "We hold none of these" is worded differently from "they are all booked",
   * because waiting fixes the second and never fixes the first.
   */
  it('says we do not have that size when none is stocked at all', async () => {
    const user = await createTestUser();
    await seedDevice({ size: 'MEDIUM' });

    const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 2, size: 'LARGE' });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/do not have a large safe/i);
  });

  it('says the size is booked out when it is stocked but occupied', async () => {
    const holder = await createTestUser();
    const user = await createTestUser();
    await seedDevice({ size: 'MEDIUM' });
    await seedDevice({ size: 'LARGE' });

    expect(
      (await post(BOOKINGS_URL, holder.cookie).send({ hours: 3, size: 'MEDIUM' })).status,
    ).toBe(201);

    const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 3, size: 'MEDIUM' });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/every medium safe is booked/i);
    expect(response.body.error.message).toMatch(/large is available/i);
  });

  /**
   * Falls back to the pre-existing refusal when **nothing** is free at any
   * size. `NO_DEVICES_AVAILABLE` is still the honest answer, and its advice
   * about trying a shorter booking is still the useful one.
   */
  it('still reports NO_DEVICES_AVAILABLE when no size has anything free', async () => {
    const holder = await createTestUser();
    const user = await createTestUser();
    await seedDevice({ size: 'MEDIUM' });

    expect(
      (await post(BOOKINGS_URL, holder.cookie).send({ hours: 3, size: 'MEDIUM' })).status,
    ).toBe(201);

    const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 3, size: 'MEDIUM' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  /** An empty fleet is still the fleet-level outage, not a size problem. */
  it('still reports NO_DEVICES_IN_SERVICE when there is no fleet at all', async () => {
    const user = await createTestUser();

    const response = await post(BOOKINGS_URL, user.cookie).send({ hours: 2, size: 'SMALL' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('NO_DEVICES_IN_SERVICE');
  });
});

describe('the size snapshot', () => {
  /**
   * The snapshot's whole point: an admin fixing a mislabelled cabinet must not
   * retroactively change what a running rental says it was — or what it cost.
   */
  it('survives the device being reclassified mid-rental', async () => {
    const user = await createTestUser();
    const device = await seedDevice({ size: 'SMALL' });

    const created = await post(BOOKINGS_URL, user.cookie).send({ hours: 2, size: 'SMALL' });
    expect(created.status).toBe(201);

    await prisma.device.update({ where: { id: device.id }, data: { size: 'LARGE' } });

    const mine = await get(CURRENT_URL, user.cookie);

    expect(mine.body.booking).toMatchObject({
      safeSize: 'SMALL',
      pricePaise: RATE.SMALL * 2,
    });
    expect(mine.body.booking.rates.hourlyRatePaise).toBe(RATE.SMALL);
  });

  /**
   * And an **extension** is priced from that snapshot too, so a reclassified
   * cabinet cannot change the cost of more hours in the safe someone's
   * belongings are already in.
   */
  it('prices an extension from the booking, not from the device', async () => {
    const user = await createTestUser();
    const device = await seedDevice({ size: 'SMALL' });

    const created = await post(BOOKINGS_URL, user.cookie).send({ hours: 2, size: 'SMALL' });
    const bookingId = created.body.booking.id as string;

    // Pay for it, so it is ACTIVE and therefore extendable.
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'ACTIVE',
        endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        holdExpiresAt: null,
      },
    });

    await prisma.device.update({ where: { id: device.id }, data: { size: 'LARGE' } });

    const mine = await get(CURRENT_URL, user.cookie);
    const options: Array<{ hours: number; pricePaise: number }> = mine.body.extension.options;

    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toEqual({ hours: 1, pricePaise: RATE.SMALL });
  });
});

describe('the quote', () => {
  it('prices every size and every duration, smallest size first', async () => {
    const user = await createTestUser();
    await seedDevice({ size: 'MEDIUM' });

    const response = await get(CURRENT_URL, user.cookie);
    const { quote } = response.body;

    expect(quote.sizes.map((offer: { size: SafeSize }) => offer.size)).toEqual([
      'SMALL',
      'MEDIUM',
      'LARGE',
    ]);

    const durations = env.RENTAL_MAX_HOURS - env.RENTAL_MIN_HOURS + 1;

    for (const offer of quote.sizes) {
      expect(offer.hourlyRatePaise).toBe(RATE[offer.size as SafeSize]);
      expect(offer.options).toHaveLength(durations);
      // The server does the arithmetic; the client reads a price off this list.
      expect(offer.options[0]).toEqual({
        hours: env.RENTAL_MIN_HOURS,
        pricePaise: offer.hourlyRatePaise * env.RENTAL_MIN_HOURS,
      });
      // 1.5× the size's own rate, not a shared one.
      expect(offer.overstayHourlyPaise).toBe(offer.hourlyRatePaise * 1.5);
    }
  });

  /**
   * Availability is per size, and it is what lets the page disable a card
   * before anybody picks a duration for it.
   */
  it('marks only the sizes with a free safe as available', async () => {
    const user = await createTestUser();
    await seedDevice({ size: 'LARGE' });

    const response = await get(CURRENT_URL, user.cookie);

    expect(
      Object.fromEntries(
        response.body.quote.sizes.map((offer: { size: SafeSize; available: boolean }) => [
          offer.size,
          offer.available,
        ]),
      ),
    ).toEqual({ SMALL: false, MEDIUM: false, LARGE: true });
  });

  it('marks a size unavailable once its only safe is taken', async () => {
    const holder = await createTestUser();
    const looker = await createTestUser();
    await seedDevice({ size: 'SMALL' });
    await seedDevice({ size: 'LARGE' });

    expect(
      (await post(BOOKINGS_URL, holder.cookie).send({ hours: 2, size: 'SMALL' })).status,
    ).toBe(201);

    const offers: Array<{ size: SafeSize; available: boolean }> = (
      await get(CURRENT_URL, looker.cookie)
    ).body.quote.sizes;

    expect(offers.find((offer) => offer.size === 'SMALL')?.available).toBe(false);
    expect(offers.find((offer) => offer.size === 'LARGE')?.available).toBe(true);
  });

  /**
   * A safe we cannot reach is not availability, at any size — the same rule
   * the pick applies, so the page cannot offer something the pick would then
   * refuse.
   */
  it('does not count an unreachable safe as available', async () => {
    const user = await createTestUser();
    await seedDevice({ size: 'MEDIUM', online: false });
    await seedDevice({ size: 'LARGE', doorState: 'UNKNOWN' });

    const response = await get(CURRENT_URL, user.cookie);

    for (const offer of response.body.quote.sizes) {
      expect(offer.available, offer.size).toBe(false);
    }
  });
});
