import type { SimulationScenario } from '@safelock/shared';

/**
 * An ESP32 running `firmware/esp32_safelock`, simulated in process.
 *
 * Exposed as a `fetch` replacement so `HttpDeviceGateway` drives it through
 * exactly the code path it uses for the real board: same endpoints, same
 * token check, same JSON. `DEVICE_GATEWAY=sim` is therefore one line away
 * from `DEVICE_GATEWAY=http`, and anything that works in a demo on the
 * simulator works on the hardware for the same reasons.
 *
 * The DHT22 is simulated as a slow random walk around room conditions, so
 * the dashboard has live-looking readings. The reed switch and vibration
 * sensor are quiet until {@link SimulatedEsp32.trigger} stages a scenario —
 * which is how the admin panel demos a break-in without a crowbar. Demo only;
 * refused in production by the env schema.
 */
export class SimulatedEsp32 {
  private locked = true;

  private temperature = 27;

  private humidity = 58;

  private readonly bootedAt = Date.now();

  /** Polls left on which `/state` reports vibration (a latched knock). */
  private vibrationPolls = 0;

  /** Until when the door reads OPEN regardless of the bolt (a forced door). */
  private doorForcedUntil = 0;

  /** Until when the DHT22 climbs towards overheating. */
  private heatUntil = 0;

  private readonly bootId = `sim${Math.random().toString(36).slice(2, 12)}`;

  constructor(
    private readonly token: string,
    /** Drive the readings past the alert thresholds, for a demo. */
    private readonly options: { heatSpike?: boolean } = {},
  ) {}

  /** A `fetch` that answers as the firmware would. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);

    if (headers.get('X-Device-Token') !== this.token) {
      return this.json(401, { error: 'unauthorised' });
    }

    // A real board takes a moment; so does the relay.
    await new Promise((resolve) => setTimeout(resolve, 80));

    if (method === 'POST' && url.pathname === '/lock') {
      this.locked = true;
      return this.json(200, this.commandBody());
    }

    if (method === 'POST' && url.pathname === '/unlock') {
      this.locked = false;
      return this.json(200, this.commandBody());
    }

    if (method === 'GET' && url.pathname === '/state') {
      this.driftSensor();
      const vibration = this.vibrationPolls > 0;
      if (vibration) this.vibrationPolls -= 1;
      return this.json(200, {
        doorOpen: this.doorOpen(),
        vibration,
        lockState: this.lockState(),
        rssi: -55 - Math.floor(Math.random() * 8),
        uptimeMs: this.uptimeMs(),
        bootId: this.bootId,
        firmware: 'esp32-sim-1.0',
        sensorValid: true,
        temperature: round1(this.temperature),
        humidity: round1(this.humidity),
      });
    }

    return this.json(404, { error: 'not found' });
  };

  private lockState(): 'LOCKED' | 'UNLOCKED' {
    return this.locked ? 'LOCKED' : 'UNLOCKED';
  }

  private uptimeMs(): number {
    return Date.now() - this.bootedAt;
  }

  private commandBody() {
    return {
      lockState: this.lockState(),
      uptimeMs: this.uptimeMs(),
      bootId: this.bootId,
      doorOpen: this.doorOpen(),
    };
  }

  /**
   * A closed door, except while a forced-door scenario runs. A renter opening
   * an unlocked safe is not modelled: the door staying shut is what lets
   * auto-lock run in a demo.
   */
  private doorOpen(): boolean {
    return Date.now() < this.doorForcedUntil;
  }

  /**
   * Stages a demo scenario, read by the next `/state` polls.
   *
   * - `VIBRATION`: three polls of knocking (~9s at the default poll rate).
   * - `FORCED_DOOR`: the door reads open for 15s with the bolt still thrown.
   * - `HEAT`: the DHT22 climbs past both alert thresholds for two minutes.
   */
  trigger(scenario: SimulationScenario): void {
    const now = Date.now();
    if (scenario === 'VIBRATION') this.vibrationPolls = 3;
    if (scenario === 'FORCED_DOOR') {
      this.doorForcedUntil = now + 15_000;
      this.vibrationPolls = 2;
    }
    if (scenario === 'HEAT') {
      this.heatUntil = now + 120_000;
      // Jump straight past the thresholds so the alert lands on the next poll.
      this.temperature = Math.max(this.temperature, 46);
      this.humidity = Math.max(this.humidity, 81);
    }
  }

  private driftSensor(): void {
    if (this.options.heatSpike || Date.now() < this.heatUntil) {
      // Climb about a degree a poll towards an overheating, damp safe.
      this.temperature = clamp(this.temperature + 0.8 + (Math.random() - 0.5) * 0.4, 22, 52);
      this.humidity = clamp(this.humidity + 1.2 + (Math.random() - 0.5) * 1.2, 40, 90);
      return;
    }
    this.temperature = clamp(this.temperature + (Math.random() - 0.5) * 0.4, 22, 34);
    this.humidity = clamp(this.humidity + (Math.random() - 0.5) * 1.2, 40, 75);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
