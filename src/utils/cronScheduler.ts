import { EventEmitter } from 'events';
import type { CronSchedule } from '../models/cronSchedule';

/** Poll every 30 seconds to keep daily schedules within 1-minute accuracy. */
const POLL_INTERVAL_MS = 30_000;

// ── Pure helper functions (exported for testing) ──────────────────────────────

/**
 * Compute the timestamp at which an interval schedule should next fire.
 *
 * Rules:
 * - If it has never fired, schedule the first fire `minutes` from now.
 * - If the next fire time is already in the past (e.g. VS Code was closed),
 *   return `now` so the schedule fires on the next tick instead of silently
 *   missing every overdue cycle.
 */
export function computeNextIntervalFireAt(
  spec: { type: 'interval'; minutes: number },
  lastFiredAt: number | undefined,
  now: number,
): number {
  const interval = spec.minutes * 60_000;
  if (lastFiredAt === undefined) {
    return now + interval;
  }
  const next = lastFiredAt + interval;
  // If past-due, fire immediately rather than skipping
  return next <= now ? now : next;
}

/**
 * Return true if a daily schedule should fire at `now`.
 *
 * A daily schedule fires at most once per calendar minute.  The guard compares
 * the full date + hour + minute of `lastFiredAt` against `now` so the schedule
 * fires exactly once even when the 30-second poller ticks twice in the same
 * clock minute.
 */
export function shouldFireDaily(
  spec: { type: 'daily'; hour: number; minute: number },
  lastFiredAt: number | undefined,
  now: number,
): boolean {
  const d = new Date(now);
  if (d.getHours() !== spec.hour || d.getMinutes() !== spec.minute) {
    return false;
  }
  if (lastFiredAt === undefined) {
    return true;
  }
  const last = new Date(lastFiredAt);
  // Already fired in this same clock-minute today?
  return !(
    last.getFullYear() === d.getFullYear() &&
    last.getMonth()    === d.getMonth()    &&
    last.getDate()     === d.getDate()     &&
    last.getHours()    === d.getHours()    &&
    last.getMinutes()  === d.getMinutes()
  );
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export interface ScheduleFiredEvent {
  schedule: CronSchedule;
}

export class CronScheduler extends EventEmitter {
  private schedules: CronSchedule[] = [];
  /** Next fire timestamp for each interval-based schedule (keyed by ID). */
  private nextIntervalFireAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly onSave: (schedules: CronSchedule[]) => Promise<void>;

  constructor(onSave: (schedules: CronSchedule[]) => Promise<void>) {
    super();
    this.onSave = onSave;
  }

  /** Load persisted schedules.  Call before start(). */
  load(schedules: CronSchedule[]): void {
    this.schedules = schedules.map(s => ({ ...s }));
    const now = Date.now();
    for (const sched of this.schedules) {
      if (sched.spec.type === 'interval') {
        const lastFiredMs = sched.lastFiredAt
          ? new Date(sched.lastFiredAt).getTime()
          : undefined;
        this.nextIntervalFireAt.set(
          sched.id,
          computeNextIntervalFireAt(sched.spec, lastFiredMs, now),
        );
      }
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getSchedules(): CronSchedule[] {
    return this.schedules.map(s => ({ ...s }));
  }

  async addSchedule(schedule: CronSchedule): Promise<void> {
    this.schedules.push({ ...schedule });
    if (schedule.spec.type === 'interval') {
      this.nextIntervalFireAt.set(
        schedule.id,
        Date.now() + schedule.spec.minutes * 60_000,
      );
    }
    await this.save();
  }

  async updateSchedule(schedule: CronSchedule): Promise<void> {
    const idx = this.schedules.findIndex(s => s.id === schedule.id);
    if (idx === -1) return;
    this.schedules[idx] = { ...schedule };
    // Reset the fire timer whenever the spec changes
    if (schedule.spec.type === 'interval') {
      this.nextIntervalFireAt.set(
        schedule.id,
        Date.now() + schedule.spec.minutes * 60_000,
      );
    } else {
      this.nextIntervalFireAt.delete(schedule.id);
    }
    await this.save();
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules = this.schedules.filter(s => s.id !== id);
    this.nextIntervalFireAt.delete(id);
    await this.save();
  }

  /**
   * Evaluate all enabled schedules against `now`.
   * Exposed as public so tests can drive the clock without a real timer.
   */
  tick(now = Date.now()): void {
    for (const sched of this.schedules) {
      if (!sched.enabled) continue;

      if (sched.spec.type === 'interval') {
        const next = this.nextIntervalFireAt.get(sched.id)
          ?? (now + sched.spec.minutes * 60_000);
        if (now >= next) {
          this.fireSched(sched, now);
          this.nextIntervalFireAt.set(sched.id, now + sched.spec.minutes * 60_000);
        }
      } else if (sched.spec.type === 'daily') {
        const lastFiredMs = sched.lastFiredAt
          ? new Date(sched.lastFiredAt).getTime()
          : undefined;
        if (shouldFireDaily(sched.spec, lastFiredMs, now)) {
          this.fireSched(sched, now);
        }
      }
    }
  }

  private fireSched(sched: CronSchedule, now: number): void {
    const isoNow = new Date(now).toISOString();
    const idx = this.schedules.findIndex(s => s.id === sched.id);
    if (idx !== -1) {
      this.schedules[idx] = { ...this.schedules[idx], lastFiredAt: isoNow };
    }
    void this.save();
    this.emit('fire', {
      schedule: { ...sched, lastFiredAt: isoNow },
    } satisfies ScheduleFiredEvent);
  }

  private async save(): Promise<void> {
    await this.onSave(this.schedules.map(s => ({ ...s })));
  }
}
