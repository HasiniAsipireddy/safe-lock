import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    /**
     * `@safelock/shared` is included here on purpose.
     *
     * It has no runner of its own, and neither does the web app, so a pure
     * function living in shared — `safeInternalPath`, the money and status
     * helpers — would otherwise be the least tested code in the repo while
     * being the most depended on. This is the one suite in the monorepo, and
     * the shared tests need no database, so they cost a few milliseconds.
     */
    include: [
      'src/**/*.test.ts',
      'prisma/**/*.test.ts',
      '../../packages/shared/src/**/*.test.ts',
    ],
    // Tests share one Postgres database and truncate between cases, so they
    // must not run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ['src/test/globalSetup.ts'],
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,

    /**
     * Fixed configuration for the suite.
     *
     * Set here (not in .env) so the HMAC expectations in the tests are
     * reproducible on any machine, and so NODE_ENV=test is in place before
     * `config/env.ts` reads it — dotenv does not override an existing value.
     *
     * These are throwaway strings. They are not, and must never be, real keys.
     */
    env: {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test_access_secret_for_vitest_only_32+chars',
      // Fixed so an OTP's HMAC is reproducible inside a test.
      OTP_HMAC_SECRET: 'test_otp_hmac_secret_for_vitest_only_32+chars',
      SAFE_PRICE_PAISE: '99900',

      /**
       * Device command signing. Fixed so a derived `K_d`, and therefore every
       * signature over it, is reproducible inside a test — and **distinct from
       * `OTP_HMAC_SECRET`**, which the env schema requires and which the
       * domain-separation tests depend on.
       *
       * The suite runs on `DEVICE_GATEWAY=mock`, so the secret is not strictly
       * required at boot. It is set anyway: the protocol tests derive real keys
       * and sign real messages, and a simulator standing in for firmware needs
       * the same key the server uses.
       */
      DEVICE_COMMAND_HMAC_SECRET: 'test_device_command_secret_for_vitest_32+chars',
      DEVICE_COMMAND_KEY_VERSION: '1',
      RAZORPAY_KEY_ID: 'rzp_test_vitest',
      RAZORPAY_KEY_SECRET: 'vitest_key_secret_do_not_use_anywhere',
      RAZORPAY_WEBHOOK_SECRET: 'vitest_webhook_secret_do_not_use_anywhere',
      // The origin the suite sends on state-changing requests, mirroring a
      // real browser. originCheck matches it by exact string equality.
      WEB_ORIGIN: 'http://localhost:3000,http://localhost:3001',
      LOG_LEVEL: 'error',

      /**
       * WhatsApp: the suite runs on the **fake** client, which has no network
       * at all. `test/setup.ts` additionally blocks `fetch` for the whole
       * suite, so a client written without a fake fails loudly rather than
       * messaging a real phone number.
       *
       * The cloud credentials below exist only so the Cloud API client can be
       * *constructed* in its unit test, which drives it against a stubbed
       * fetch. They are throwaway strings and reach nothing.
       */
      WHATSAPP_PROVIDER: 'fake',
      WHATSAPP_ACCESS_TOKEN: 'vitest_whatsapp_access_token_do_not_use',
      WHATSAPP_PHONE_NUMBER_ID: '100000000000000',
      // Fixed so a webhook signature is reproducible inside a test.
      WHATSAPP_APP_SECRET: 'vitest_whatsapp_app_secret_do_not_use',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'vitest_whatsapp_verify_token',
    },
  },
});
