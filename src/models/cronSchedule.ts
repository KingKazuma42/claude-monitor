/** Specification for when a schedule fires. */
export type ScheduleSpec =
  | { type: 'interval'; minutes: number }      // every N minutes
  | { type: 'daily'; hour: number; minute: number }; // every day at HH:MM

export interface CronSchedule {
  id: string;
  label: string;
  spec: ScheduleSpec;
  instruction: string; // text sent to Claude sessions when fired
  enabled: boolean;
  createdAt: string;    // ISO 8601
  lastFiredAt?: string; // ISO 8601
  /**
   * If set, only sessions whose workDir equals this value receive the instruction.
   * undefined means "broadcast to all active sessions".
   * workDir is used because it is stable across session restarts (unlike PID).
   */
  targetWorkDir?: string;
  /**
   * If set, the instruction is delivered only to the session whose id matches
   * this value (e.g. "claude-12345").  When the targeted session is no longer
   * active (e.g. after a restart), the fire handler falls back to targetWorkDir
   * so the schedule continues to work across session restarts.
   * Takes priority over targetWorkDir when both are present.
   */
  targetSessionId?: string;
}

/** Human-readable description of a ScheduleSpec. */
export function formatScheduleSpec(spec: ScheduleSpec): string {
  if (spec.type === 'interval') {
    const { minutes } = spec;
    if (minutes < 60) return `毎 ${minutes} 分`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `毎 ${h} 時間` : `毎 ${h} 時間 ${m} 分`;
  }
  const hh = String(spec.hour).padStart(2, '0');
  const mm = String(spec.minute).padStart(2, '0');
  return `毎日 ${hh}:${mm}`;
}

/** Generate a unique schedule ID. */
export function generateScheduleId(): string {
  return `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
