// Regression test for issue #13973 (remaining scope after PR #14005):
// the cleanup scheduler and the model-sync scheduler are both anchored to
// process-start with an *identical* 6h period and *zero* jitter/offset
// between them. Since both are started within milliseconds of each other
// during server bootstrap (src/instrumentation-node.ts calls
// startCleanupScheduler() in the same Promise.all-driven boot sequence that
// calls ensureCloudSyncInitialized() -> startModelSyncScheduler()), they
// would otherwise keep firing in the same second every 6 hours for the
// lifetime of the process.
//
// This test does NOT touch the DB or execute the scheduled work: it spies on
// the global timer constructors to capture the *delay* argument each
// scheduler registers, proving the two periodic intervals are scheduled
// with a relative offset (stagger). It must run as its own file, not as
// part of a suite.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "1";

let startCleanupScheduler: () => void;
let stopCleanupScheduler: () => void;
let startModelSyncScheduler: (apiBaseUrl?: string, intervalMs?: number) => void;
let stopModelSyncScheduler: () => void;

before(async () => {
  ({ startCleanupScheduler, stopCleanupScheduler } = await import("../../src/lib/db/cleanup.ts"));
  ({ startModelSyncScheduler, stopModelSyncScheduler } =
    await import("../../src/shared/services/modelSyncScheduler.ts"));
});

after(() => {
  try {
    stopCleanupScheduler();
  } catch {}
  try {
    stopModelSyncScheduler();
  } catch {}
});

test("cleanup scheduler and model-sync scheduler register their periodic 6h timer with a non-zero relative offset (stagger) — issue #13973 remaining scope", () => {
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;

  const intervalDelays: number[] = [];

  type TimerFn = (...a: unknown[]) => void;
  type TimerSetter = (fn: TimerFn, delay?: number, ...rest: unknown[]) => unknown;

  (global as unknown as { setInterval: TimerSetter }).setInterval = (
    fn: TimerFn,
    delay?: number,
    ...rest: unknown[]
  ) => {
    intervalDelays.push(delay ?? -1);
    return originalSetInterval(fn, delay, ...rest);
  };
  (global as unknown as { setTimeout: TimerSetter }).setTimeout = (
    fn: TimerFn,
    delay?: number,
    ...rest: unknown[]
  ) => {
    return originalSetTimeout(fn, delay, ...rest);
  };

  try {
    startCleanupScheduler();
    startModelSyncScheduler("http://127.0.0.1:0");
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
  }

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  assert.equal(intervalDelays.length, 2, "expected exactly one setInterval per scheduler");

  assert.notEqual(
    intervalDelays[0],
    intervalDelays[1],
    "cleanup scheduler and model-sync scheduler must register a staggered " +
      "6h setInterval with a non-zero relative offset — otherwise they " +
      "collide in the same second every 6 hours for the process lifetime " +
      "(issue #13973's remaining scope: 'stagger the three 6h timers')"
  );

  // The cleanup scheduler's cadence is unchanged at exactly 6h; the
  // model-sync scheduler is phase-shifted by a fixed offset on top of it.
  assert.ok(
    intervalDelays.includes(SIX_HOURS_MS),
    `expected the cleanup scheduler to keep its unstaggered 6h cadence, got ${JSON.stringify(intervalDelays)}`
  );
  assert.ok(
    intervalDelays.some((d) => d > SIX_HOURS_MS),
    `expected the model-sync scheduler to register a delay greater than 6h (staggered), got ${JSON.stringify(intervalDelays)}`
  );
});
