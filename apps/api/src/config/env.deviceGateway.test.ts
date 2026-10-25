import { describe, expect, it } from 'vitest';
import { envSchema } from './env';

/**
 * What the env schema will and will not accept for `DEVICE_GATEWAY`.
 *
 * The MQTT transport is **parked** (2026-10-24): the website is being finished
 * first and real hardware comes after, so `mqtt` is refused at boot in every
 * environment and `mock` is the only reachable gateway. None of the MQTT code
 * was deleted, which is exactly why this needs a test — a parked transport
 * that is still wired up and still has passing tests of its own could
 * otherwise be switched on by an `.env` line nobody reviewed, and the first
 * symptom would be a reconnect loop and an inventory full of safes flagged for
 * inspection.
 *
 * Parsed against synthetic objects rather than the real `process.env`, which
 * is read once at module load — asking "does production refuse this?" any
 * other way means reloading the module registry and hoping.
 *
 * Every secret below is a throwaway string. They are not, and must never be,
 * real values.
 */

/** A development environment that parses on its own. */
const baseDev: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://safelock@localhost:5433/safelock',
  JWT_ACCESS_SECRET: 'a_development_access_secret_of_at_least_32c',
  OTP_HMAC_SECRET: 'a_development_otp_hmac_secret_of_at_least_32c',
  RAZORPAY_KEY_ID: 'rzp_test_placeholder',
  RAZORPAY_KEY_SECRET: 'a_razorpay_key_secret_value_for_this_test',
  RAZORPAY_WEBHOOK_SECRET: 'a_razorpay_webhook_secret_value_for_this_test',
};

/** A minimally valid production environment, with no gateway chosen. */
function productionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...baseDev,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user@db.internal.test:5432/safelock',
    JWT_ACCESS_SECRET: 'a_production_access_secret_of_at_least_32_chars',
    OTP_HMAC_SECRET: 'a_production_otp_hmac_secret_of_at_least_32_chars',
    WEB_ORIGIN: 'https://app.example.test',
    PUBLIC_WEB_URL: 'https://app.example.test',
    WHATSAPP_PROVIDER: 'cloud',
    WHATSAPP_ACCESS_TOKEN: 'a_whatsapp_token_value_for_this_test',
    WHATSAPP_PHONE_NUMBER_ID: '100000000000000',
    WHATSAPP_APP_SECRET: 'a_whatsapp_app_secret_value_for_this_test',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'a_whatsapp_verify_token_for_this_test',
    ...overrides,
  };
}

/** The issue messages for one path, or an empty array. */
function issuesFor(env: Record<string, string>, path: string): string[] {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) return [];

  return parsed.error.issues
    .filter((issue) => issue.path.join('.') === path)
    .map((issue) => issue.message);
}

describe('DEVICE_GATEWAY', () => {
  it('defaults to mock, so an existing .env needs no change', () => {
    const parsed = envSchema.safeParse(baseDev);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.DEVICE_GATEWAY).toBe('mock');
  });

  it('accepts mock in development with nothing else configured', () => {
    expect(envSchema.safeParse({ ...baseDev, DEVICE_GATEWAY: 'mock' }).success).toBe(true);
  });

  it('rejects a value that is neither mock nor mqtt', () => {
    expect(issuesFor({ ...baseDev, DEVICE_GATEWAY: 'disabled' }, 'DEVICE_GATEWAY')).not.toEqual(
      [],
    );
    expect(issuesFor({ ...baseDev, DEVICE_GATEWAY: 'esp32' }, 'DEVICE_GATEWAY')).not.toEqual([]);
  });
});

describe('the parked MQTT transport', () => {
  /**
   * The refusal that parks it, and the reason this file exists.
   *
   * In **development** too, not only production — the failure being prevented
   * is a local one. With no broker listening, mqtt.js retries every two
   * seconds forever, and every completion lock marches through three failed
   * attempts into `NEEDS_INSPECTION`, which makes the device inventory
   * unbookable until an admin clears each row by hand.
   */
  it.each(['development', 'test', 'production'])('is refused when NODE_ENV=%s', (nodeEnv) => {
    const env =
      nodeEnv === 'production'
        ? productionEnv({ DEVICE_GATEWAY: 'mqtt' })
        : { ...baseDev, NODE_ENV: nodeEnv, DEVICE_GATEWAY: 'mqtt' };

    expect(issuesFor(env, 'DEVICE_GATEWAY')).toContainEqual(
      expect.stringMatching(/parked pending hardware integration/),
    );
  });

  /** A refusal nobody can act on is a refusal somebody will work around. */
  it('names both the immediate fix and how to un-park it', () => {
    const [message] = issuesFor({ ...baseDev, DEVICE_GATEWAY: 'mqtt' }, 'DEVICE_GATEWAY');

    expect(message).toMatch(/DEVICE_GATEWAY=mock/);
    expect(message).toMatch(/MQTT_PARKED=false/);
    expect(message).toMatch(/env\.ts/);
  });

  /**
   * And the parked refusal is the **only** complaint.
   *
   * The broker, credential and command-secret requirements are skipped while
   * parked, because telling someone to set `MQTT_URL` in the same breath as
   * refusing them permission to use MQTT is a contradiction they would
   * reasonably try to satisfy.
   */
  it('does not also demand a broker, credential or command secret', () => {
    const env = { ...baseDev, DEVICE_GATEWAY: 'mqtt' };

    for (const path of [
      'MQTT_URL',
      'MQTT_USERNAME',
      'MQTT_PASSWORD',
      'DEVICE_COMMAND_HMAC_SECRET',
    ]) {
      expect(issuesFor(env, path)).toEqual([]);
    }
  });
});

describe('production', () => {
  /** The pre-existing guard, unchanged and pinned. */
  it('still refuses mock', () => {
    expect(issuesFor(productionEnv({ DEVICE_GATEWAY: 'mock' }), 'DEVICE_GATEWAY')).toEqual([
      expect.stringMatching(/not allowed in production/),
    ]);
  });

  /**
   * The honest consequence of parking the only real transport: **no value of
   * `DEVICE_GATEWAY` boots in production.**
   *
   * Asserted rather than merely commented, because it is a surprising state to
   * walk into and the surprise should be a failing test if anyone "fixes" it
   * by letting `mock` through. A rental product whose safes cannot be
   * physically opened has nothing to sell; the remedy is the hardware phase,
   * not a third mode.
   */
  it('has no bootable gateway at all while MQTT is parked', () => {
    for (const gateway of ['mock', 'mqtt']) {
      expect(envSchema.safeParse(productionEnv({ DEVICE_GATEWAY: gateway })).success).toBe(
        false,
      );
    }

    // Including the default, which is `mock`.
    expect(envSchema.safeParse(productionEnv()).success).toBe(false);
  });
});
