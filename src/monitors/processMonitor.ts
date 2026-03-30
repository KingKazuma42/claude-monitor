import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  memMB: number;
  workDir: string;
  command: string;
}

export interface ProcessMonitorEvents {
  update: (processes: ProcessInfo[]) => void;
  error: (err: Error) => void;
}

export class ProcessMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(intervalMs = 5000) {
    super();
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  private async poll(): Promise<void> {
    try {
      const processes = await this.getClaudeProcesses();
      this.emit('update', processes);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async getClaudeProcesses(): Promise<ProcessInfo[]> {
    // ps with: pid, ppid, %cpu, rss(KB), cwd, command
    // -o format without header (-h not available on all platforms, use awk to skip header)
    const { stdout } = await execAsync(
      `ps -eo pid,ppid,%cpu,rss,comm --no-headers 2>/dev/null | awk '$5 ~ /^claude$/ {print}'`
    );

    const results: ProcessInfo[] = [];

    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const memMB = Math.round(parseInt(parts[3], 10) / 1024);
      const command = parts.slice(4).join(' ');

      const workDir = await this.getWorkDir(pid);

      results.push({ pid, ppid, cpu, memMB, workDir, command });
    }

    return results;
  }

  private async getWorkDir(pid: number): Promise<string> {
    try {
      const { stdout } = await execAsync(`readlink -f /proc/${pid}/cwd 2>/dev/null`);
      return stdout.trim() || '';
    } catch {
      return '';
    }
  }
}
