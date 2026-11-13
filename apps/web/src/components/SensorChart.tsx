'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SensorHistoryResponse, SensorSample } from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { cn } from '@/lib/cn';

/**
 * Temperature and humidity inside the renter's safe over time.
 *
 * Two small charts rather than one with two axes: the units differ, and a
 * dual-axis chart invites reading a crossing of the two lines as meaningful.
 * Each draws the server's alert threshold as a dashed line, from the same
 * shared constant the server alerts on, so "the line crossed it" and "you got
 * an alert" agree.
 *
 * Plain SVG, no chart library: two polylines do not justify a dependency.
 * Refreshes every minute while the tab is visible — samples are stored at
 * most once a minute, so polling faster would fetch the same points.
 */

const RANGES = [1, 6, 24] as const;
type Range = (typeof RANGES)[number];

const REFRESH_MS = 60_000;

export function SensorChart() {
  const [hours, setHours] = useState<Range>(6);
  const [data, setData] = useState<SensorHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get<SensorHistoryResponse>(
        `/devices/sensor-history?hours=${hours}`,
      );
      setData(response);
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }, [hours]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);

    return () => clearInterval(timer);
  }, [load]);

  return (
    <section aria-labelledby="sensor-chart-heading" className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="sensor-chart-heading" className="text-sm font-semibold text-slate-900">
          Conditions inside your safe
        </h3>
        <div role="group" aria-label="Time range" className="flex gap-1">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={hours === range}
              onClick={() => setHours(range)}
              className={cn(
                'min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                hours === range
                  ? 'bg-brand-600 text-white'
                  : 'bg-brand-50 text-brand-800 hover:bg-brand-100',
              )}
            >
              {range}h
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : !data ? (
        <p className="mt-3 text-sm text-slate-500">Loading readings…</p>
      ) : data.samples.length < 2 ? (
        <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          Not enough readings yet. The chart fills in as your safe reports, about once a
          minute.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <MiniChart
            title="Temperature"
            unit="°C"
            samples={data.samples}
            pick={(sample) => sample.temperatureC}
            threshold={data.thresholds.temperatureC}
            stroke="#dc2626"
          />
          <MiniChart
            title="Humidity"
            unit="%"
            samples={data.samples}
            pick={(sample) => sample.humidityPct}
            threshold={data.thresholds.humidityPct}
            stroke="#0284c7"
          />
        </div>
      )}
    </section>
  );
}

const WIDTH = 300;
const HEIGHT = 110;
const PAD_X = 6;
const PAD_Y = 10;

function MiniChart({
  title,
  unit,
  samples,
  pick,
  threshold,
  stroke,
}: {
  title: string;
  unit: string;
  samples: SensorSample[];
  pick: (sample: SensorSample) => number;
  threshold: number;
  stroke: string;
}) {
  const values = samples.map(pick);
  const times = samples.map((sample) => new Date(sample.at).getTime());

  const min = Math.min(...values);
  const max = Math.max(...values);
  const latest = values[values.length - 1] ?? 0;

  // Keep the threshold on the chart only when it is near the data, so a
  // comfortable 27°C does not get squashed into a sliver to show a 45°C line.
  const showThreshold = max >= threshold - 5;
  const low = Math.floor(Math.min(min, showThreshold ? threshold : min) - 1);
  const high = Math.ceil(Math.max(max, showThreshold ? threshold : max) + 1);

  const t0 = times[0] ?? 0;
  const t1 = times[times.length - 1] ?? 1;
  const x = (t: number) => PAD_X + ((t - t0) / Math.max(1, t1 - t0)) * (WIDTH - 2 * PAD_X);
  const y = (v: number) => PAD_Y + (1 - (v - low) / Math.max(1, high - low)) * (HEIGHT - 2 * PAD_Y);

  const points = samples.map((_, i) => `${x(times[i]!).toFixed(1)},${y(values[i]!).toFixed(1)}`);
  const over = latest >= threshold;

  const summary =
    `${title} from ${formatTime(t0)} to ${formatTime(t1)}: ` +
    `lowest ${min.toFixed(1)}${unit}, highest ${max.toFixed(1)}${unit}, ` +
    `latest ${latest.toFixed(1)}${unit}. Alert level ${threshold}${unit}.`;

  return (
    <figure className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-slate-500">{title}</span>
        <span
          className={cn(
            'text-sm font-bold tabular-nums',
            over ? 'text-red-700' : 'text-slate-900',
          )}
        >
          {latest.toFixed(1)}
          {unit}
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-1 h-24 w-full"
        role="img"
        aria-label={summary}
        preserveAspectRatio="none"
      >
        {showThreshold ? (
          <line
            x1={PAD_X}
            x2={WIDTH - PAD_X}
            y1={y(threshold)}
            y2={y(threshold)}
            stroke="#f87171"
            strokeDasharray="4 4"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="mt-1 flex justify-between text-[11px] text-slate-500 tabular-nums">
        <span>{formatTime(t0)}</span>
        <span>
          {min.toFixed(1)}–{max.toFixed(1)}
          {unit}
          {showThreshold ? ` · alert ${threshold}${unit}` : ''}
        </span>
        <span>{formatTime(t1)}</span>
      </div>
    </figure>
  );
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms),
  );
}
