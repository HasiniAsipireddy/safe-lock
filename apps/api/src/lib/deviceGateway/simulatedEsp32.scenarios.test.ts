import { describe, expect, it } from 'vitest';
import { SimulatedEsp32 } from './simulatedEsp32';

const TOKEN = 'simulated-token-0123';

interface SimState {
  lockState: string;
  doorOpen: boolean;
  vibration: boolean;
  temperature: number;
}

async function state(board: SimulatedEsp32): Promise<SimState> {
  const res = await board.fetch('http://sim/state', { headers: { 'X-Device-Token': TOKEN } });
  return (await res.json()) as SimState;
}

describe('SimulatedEsp32 scenarios', () => {
  it('is quiet until a scenario is triggered', async () => {
    const board = new SimulatedEsp32(TOKEN);
    expect(await state(board)).toMatchObject({ doorOpen: false, vibration: false });
  });

  it('latches knocking for a few polls, then goes quiet', async () => {
    const board = new SimulatedEsp32(TOKEN);
    board.trigger('VIBRATION');
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i += 1) seen.push((await state(board)).vibration);
    expect(seen).toEqual([true, true, true, false]);
  });

  it('reports a forced door while the bolt is still locked', async () => {
    const board = new SimulatedEsp32(TOKEN);
    board.trigger('FORCED_DOOR');
    expect(await state(board)).toMatchObject({ lockState: 'LOCKED', doorOpen: true });
  });

  it('jumps past the temperature alert threshold on HEAT', async () => {
    const board = new SimulatedEsp32(TOKEN);
    board.trigger('HEAT');
    expect((await state(board)).temperature).toBeGreaterThanOrEqual(45);
  });
});
