import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'prisma/**/*.test.ts'],
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
      SAFE_PRICE_PAISE: '99900',
      RAZORPAY_KEY_ID: 'rzp_test_vitest',
      RAZORPAY_KEY_SECRET: 'vitest_key_secret_do_not_use_anywhere',
      RAZORPAY_WEBHOOK_SECRET: 'vitest_webhook_secret_do_not_use_anywhere',
      // The origin the suite sends on state-changing requests, mirroring a
      // real browser. originCheck matches it by exact string equality.
      WEB_ORIGIN: 'http://localhost:3000,http://localhost:3001',
      LOG_LEVEL: 'error',
    },
  },
});
