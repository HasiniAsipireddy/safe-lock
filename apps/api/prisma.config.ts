import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the Migrate connection URL out of schema.prisma and into this
 * file. The runtime client gets its connection separately, through the pg
 * driver adapter in `src/lib/prisma.ts`.
 *
 * `PRISMA_DATABASE_URL` is an escape hatch so the test setup can run
 * `prisma migrate deploy` against TEST_DATABASE_URL without touching the dev
 * database.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` runs this. The same script is also exposed directly as
    // `npm --workspace apps/api run db:seed`.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.PRISMA_DATABASE_URL ?? env('DATABASE_URL'),
  },
});
