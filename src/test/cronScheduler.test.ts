import * as assert from 'assert';
import { computeNextIntervalFireAt, shouldFireDaily, CronScheduler } from '../utils/cronScheduler';
import type { CronSchedule } from '../models/cronSchedule';

let passed = 0;
let failed = 0;

function testSync(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

// ── computeNextIntervalFireAt ─────────────────────────────────────────────────
console.log('\ncomputeNextIntervalFireAt()');

testSync('schedules first fire in the future when no lastFiredAt', () => {
  const now = 1_000_000;
  const spec = { type: 'interval' as const, minutes: 30 };
  assert.strictEqual(computeNextIntervalFireAt(spec, undefined, now), now + 30 * 60_000);
});

testSync('schedules next fire based on lastFiredAt when still within interval', () => {
  const now = 1_000_000;
  const lastFiredAt = now - 10 * 60_000; // fired 10 min ago, interval is 30 min
  const spec = { type: 'interval' as const, minutes: 30 };
  assert.strictEqual(computeNextIntervalFireAt(spec, lastFiredAt, now), lastFiredAt + 30 * 60_000);
});

testSync('returns now when last fire was far in the past (missed cycles)', () => {
  const now = 1_000_000;
  const lastFiredAt = now - 120 * 60_000; // 2 hours ago, interval is 30 min
  const spec = { type: 'interval' as const, minutes: 30 };
  assert.strictEqual(computeNextIntervalFireAt(spec, lastFiredAt, now), now);
});

testSync('1-minute interval: next fire is exactly 60s later', () => {
  const now = 5_000_000;
  const spec = { type: 'interval' as const, minutes: 1 };
  assert.strictEqual(computeNextIntervalFireAt(spec, undefined, now), now + 60_000);
});

// ── shouldFireDaily ───────────────────────────────────────────────────────────
console.log('\nshouldFireDaily()');

function makeTs(h: number, m: number, year = 2024, month = 1, day = 15): number {
  return new Date(year, month - 1, day, h, m, 0, 0).getTime();
}

testSync('fires when hour/minute match and has never fired', () => {
  const spec = { type: 'daily' as const, hour: 9, minute: 0 };
  assert.strictEqual(shouldFireDaily(spec, undefined, makeTs(9, 0)), true);
});

testSync('fires when hour/minute match and last fired yesterday', () => {
  const spec = { type: 'daily' as const, hour: 9, minute: 0 };
  const lastFiredAt = makeTs(9, 0, 2024, 1, 14);
  assert.strictEqual(shouldFireDaily(spec, lastFiredAt, makeTs(9, 0, 2024, 1, 15)), true);
});

testSync('does not fire when already fired in this clock-minute today', () => {
  const spec = { type: 'daily' as const, hour: 9, minute: 0 };
  const now = makeTs(9, 0, 2024, 1, 15);
  const lastFiredAt = now; // same minute
  assert.strictEqual(shouldFireDaily(spec, lastFiredAt, now), false);
});

testSync('does not fire when 30 seconds later in the same minute (double-tick guard)', () => {
  const spec = { type: 'daily' as const, hour: 9, minute: 0 };
  const firstTick = makeTs(9, 0, 2024, 1, 15);
  const secondTick = firstTick + 30_000; // 30 s later, still minute 0
  assert.strictEqual(shouldFireDaily(spec, firstTick, secondTick), false);
});

testSync('does not fire when hour does not match', () => {
  const spec = { type: 'daily' as const, hour: 9, minute: 0 };
  assert.strictEqual(shouldFireDaily(spec, undefined, makeTs(10, 0)), false);
});

testSync('does not fire when minute does not match', () => {
  const spec = { type: 'daily' as const, hour: 9, minute: 0 };
  assert.strictEqual(shouldFireDaily(spec, undefined, makeTs(9, 1)), false);
});

testSync('fires at midnight (hour=0, minute=0)', () => {
  const spec = { type: 'daily' as const, hour: 0, minute: 0 };
  assert.strictEqual(shouldFireDaily(spec, undefined, makeTs(0, 0)), true);
});

// ── CronScheduler.tick() ─────────────────────────────────────────────────────
console.log('\nCronScheduler.tick()');

function makeSched(overrides: Partial<CronSchedule> & Pick<CronSchedule, 'spec'>): CronSchedule {
  return {
    id: 'test-1',
    label: 'Test',
    instruction: 'Hello',
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

testSync('fires interval schedule when now >= nextFireAt', () => {
  let fired = false;
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ spec: { type: 'interval', minutes: 30 } })]);
  scheduler.on('fire', () => { fired = true; });

  scheduler.tick(Date.now() + 31 * 60_000);
  assert.strictEqual(fired, true);
});

testSync('does not fire interval schedule before nextFireAt', () => {
  let fired = false;
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ spec: { type: 'interval', minutes: 30 } })]);
  scheduler.on('fire', () => { fired = true; });

  scheduler.tick(Date.now() + 1_000); // only 1 second from now
  assert.strictEqual(fired, false);
});

testSync('does not fire a disabled schedule', () => {
  let fired = false;
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ spec: { type: 'interval', minutes: 1 }, enabled: false })]);
  scheduler.on('fire', () => { fired = true; });

  scheduler.tick(Date.now() + 2 * 60_000);
  assert.strictEqual(fired, false);
});

testSync('fires daily schedule at matching time', () => {
  let fired = false;
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ spec: { type: 'daily', hour: 9, minute: 0 } })]);
  scheduler.on('fire', () => { fired = true; });

  scheduler.tick(makeTs(9, 0));
  assert.strictEqual(fired, true);
});

testSync('does not re-fire daily schedule in the same clock-minute', () => {
  let count = 0;
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ spec: { type: 'daily', hour: 9, minute: 0 } })]);
  scheduler.on('fire', () => { count++; });

  const t = makeTs(9, 0);
  scheduler.tick(t);
  scheduler.tick(t + 15_000); // 15 s later, same minute
  assert.strictEqual(count, 1);
});

testSync('fired event carries updated lastFiredAt', () => {
  let firedSchedule: CronSchedule | undefined;
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ spec: { type: 'interval', minutes: 30 } })]);
  scheduler.on('fire', (evt: { schedule: CronSchedule }) => { firedSchedule = evt.schedule; });

  const t = Date.now() + 31 * 60_000;
  scheduler.tick(t);
  assert.ok(firedSchedule?.lastFiredAt, 'lastFiredAt should be set after fire');
  assert.strictEqual(firedSchedule?.lastFiredAt, new Date(t).toISOString());
});

testSync('addSchedule: schedule is retrievable', async () => {
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([]);
  const sched = makeSched({ id: 'new-1', spec: { type: 'interval', minutes: 15 } });
  await scheduler.addSchedule(sched);
  const list = scheduler.getSchedules();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'new-1');
});

testSync('deleteSchedule: schedule is removed', async () => {
  const scheduler = new CronScheduler(async () => {});
  scheduler.load([makeSched({ id: 'del-1', spec: { type: 'interval', minutes: 30 } })]);
  await scheduler.deleteSchedule('del-1');
  assert.strictEqual(scheduler.getSchedules().length, 0);
});

testSync('updateSchedule: changes are persisted in the scheduler', async () => {
  const scheduler = new CronScheduler(async () => {});
  const sched = makeSched({ id: 'upd-1', spec: { type: 'interval', minutes: 30 }, enabled: true });
  scheduler.load([sched]);
  await scheduler.updateSchedule({ ...sched, enabled: false });
  const updated = scheduler.getSchedules().find(s => s.id === 'upd-1');
  assert.strictEqual(updated?.enabled, false);
});

testSync('onSave callback receives a copy of schedules', async () => {
  let savedCount = 0;
  let savedSchedules: CronSchedule[] = [];
  const scheduler = new CronScheduler(async (schedules) => {
    savedCount++;
    savedSchedules = schedules;
  });
  scheduler.load([]);
  const sched = makeSched({ id: 's1', spec: { type: 'interval', minutes: 5 } });
  await scheduler.addSchedule(sched);
  assert.strictEqual(savedCount, 1);
  assert.strictEqual(savedSchedules.length, 1);
  assert.strictEqual(savedSchedules[0].id, 's1');
});

// ── Summary ───────────────────────────────────────────────────────────────────
process.nextTick(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
