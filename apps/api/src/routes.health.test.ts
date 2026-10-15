import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from './test/helpers';
import * as prismaLib from './lib/prisma';

const HEALTH_URL = '/api/v1/health';

describe('GET /api/v1/health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 ok when the database answers', async () => {
    const response = await request(app()).get(HEALTH_URL);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns 503 degraded when the database is unreachable', async () => {
    vi.spyOn(prismaLib, 'checkDatabase').mockResolvedValue(false);

    const response = await request(app()).get(HEALTH_URL);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'degraded' });
  });

  it('leaks no internal detail in either state', async () => {
    const healthy = await request(app()).get(HEALTH_URL);
    expect(Object.keys(healthy.body)).toEqual(['status']);

    vi.spyOn(prismaLib, 'checkDatabase').mockResolvedValue(false);
    const degraded = await request(app()).get(HEALTH_URL);

    // No error message, no connection string, no stack, no timings.
    expect(Object.keys(degraded.body)).toEqual(['status']);
    const serialised = JSON.stringify(degraded.body);
    expect(serialised).not.toMatch(/postgres|password|5433|timed out|select/i);
  });

  it('does not throw when the query itself rejects', async () => {
    // checkDatabase must swallow its own errors so the route cannot 500.
    vi.spyOn(prismaLib.prisma, '$queryRaw').mockRejectedValue(new Error('connection refused'));

    const response = await request(app()).get(HEALTH_URL);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'degraded' });
  });
});
