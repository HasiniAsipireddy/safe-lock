import { describe, expect, it } from 'vitest';
import { SimulatedEsp32 } from './simulatedEsp32';

const TOKEN = 'sim-token-0123456789';

async function call(board: SimulatedEsp32, method: string, path: string, token = TOKEN) {
  const response = await board.fetch(`http://simulated-esp32.local${path}`, {
    method,
    headers: { 'X-Device-Token': token },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('SimulatedEsp32', () => {
  it('refuses a request without the right token, like the firmware', async () => {
    const board = new SimulatedEsp32(TOKEN);
    expect((await call(board, 'POST', '/unlock', 'wrong')).status).toBe(401);
    // ...and the refused unlock did not move the bolt.
    expect((await call(board, 'GET', '/state')).body.lockState).toBe('LOCKED');
  });

  it('boots locked, unlocks and locks on command, and reports it in /state', async () => {
    const board = new SimulatedEsp32(TOKEN);
    expect((await call(board, 'GET', '/state')).body.lockState).toBe('LOCKED');

    expect((await call(board, 'POST', '/unlock')).body.lockState).toBe('UNLOCKED');
    expect((await call(board, 'GET', '/state')).body.lockState).toBe('UNLOCKED');

    expect((await call(board, 'POST', '/lock')).body.lockState).toBe('LOCKED');
  });

  it('reports a plausible, valid sensor reading', async () => {
    const { body } = await call(new SimulatedEsp32(TOKEN), 'GET', '/state');
    expect(body.sensorValid).toBe(true);
    expect(body.temperature).toBeGreaterThanOrEqual(22);
    expect(body.temperature).toBeLessThanOrEqual(34);
    expect(body.humidity).toBeGreaterThanOrEqual(40);
    expect(body.humidity).toBeLessThanOrEqual(75);
  });

  it('only accepts lock and unlock as POST', async () => {
    expect((await call(new SimulatedEsp32(TOKEN), 'GET', '/unlock')).status).toBe(404);
  });
});
