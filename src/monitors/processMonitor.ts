import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  startedAt: Date;
  cpu: number;
  memMB: number;
  workDir: string;
  command: string;
  /** Value of --name / -n passed to claude, if any. */
  sessionName?: string;
}

export interface ProcessMonitorEvents {
  update: (processes: ProcessInfo[]) => void;
  error: (err: Error) => void;
}

export class ProcessMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private isPolling = false;
  private readonly platform = process.platform;

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
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    try {
      const processes = await this.getClaudeProcesses();
      this.emit('update', processes);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isPolling = false;
    }
  }

  private async getClaudeProcesses(): Promise<ProcessInfo[]> {
    const rawProcesses = await this.listClaudeProcesses();

    return Promise.all(
      rawProcesses.map(async proc => {
        const [workDir, sessionName] = await Promise.all([
          this.getWorkDir(proc.pid),
          this.getSessionName(proc.pid),
        ]);

        return { ...proc, workDir, sessionName };
      })
    );
  }

  private async listClaudeProcesses(): Promise<Array<Omit<ProcessInfo, 'workDir' | 'sessionName'>>> {
    if (this.platform === 'darwin') {
      return this.listDarwinProcesses();
    }
    return this.listLinuxProcesses();
  }

  private async listLinuxProcesses(): Promise<Array<Omit<ProcessInfo, 'workDir' | 'sessionName'>>> {
    const { stdout } = await execAsync(
      `ps -eo pid,ppid,etimes,%cpu,rss,comm --no-headers 2>/dev/null | awk '$6 ~ /^claude$/ {print}'`
    );

    const rawProcesses: Array<Omit<ProcessInfo, 'workDir' | 'sessionName'>> = [];

    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;

      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const elapsedSeconds = parseInt(parts[2], 10);
      const cpu = parseFloat(parts[3]);
      const memMB = Math.round(parseInt(parts[4], 10) / 1024);
      const command = parts.slice(5).join(' ');
      const startedAt = new Date(Date.now() - (Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0) * 1000);

      rawProcesses.push({ pid, ppid, startedAt, cpu, memMB, command });
    }

    return rawProcesses;
  }

  private async listDarwinProcesses(): Promise<Array<Omit<ProcessInfo, 'workDir' | 'sessionName'>>> {
    const { stdout } = await execAsync(
      `ps -axo pid=,ppid=,etime=,pcpu=,rss=,comm= 2>/dev/null`
    );

    const rawProcesses: Array<Omit<ProcessInfo, 'workDir' | 'sessionName'>> = [];

    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;

      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;

      const [, pidRaw, ppidRaw, elapsedRaw, cpuRaw, rssRaw, command] = match;
      if (!/(^|\/)claude$/.test(command.trim())) continue;

      const pid = parseInt(pidRaw, 10);
      const ppid = parseInt(ppidRaw, 10);
      const elapsedSeconds = parseDarwinElapsedTime(elapsedRaw);
      const cpu = parseFloat(cpuRaw);
      const memMB = Math.round(parseInt(rssRaw, 10) / 1024);
      const startedAt = new Date(Date.now() - elapsedSeconds * 1000);

      rawProcesses.push({ pid, ppid, startedAt, cpu, memMB, command: command.trim() });
    }

    return rawProcesses;
  }

  private async getWorkDir(pid: number): Promise<string> {
    if (this.platform === 'darwin') {
      return this.getDarwinWorkDir(pid);
    }

    try {
      const { stdout } = await execAsync(`readlink -f /proc/${pid}/cwd 2>/dev/null`);
      return stdout.trim() || '';
    } catch {
      return '';
    }
  }

  private async getDarwinWorkDir(pid: number): Promise<string> {
    try {
      const { stdout } = await execAsync(`lsof -a -p ${pid} -d cwd -Fn -nP 2>/dev/null`);
      const cwdLine = stdout.split('\n').find(line => line.startsWith('n'));
      return cwdLine ? cwdLine.slice(1).trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * Read /proc/<pid>/cmdline and extract the value of --name / -n.
   * Returns undefined when the flag is absent or the file is unreadable.
   */
  private async getSessionName(pid: number): Promise<string | undefined> {
    if (this.platform === 'darwin') {
      return this.getDarwinSessionName(pid);
    }

    try {
      // cmdline is NUL-separated; read as binary then split on \0
      const { stdout } = await execAsync(
        `cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' '\\n'`
      );
      const args = stdout.split('\n').filter(Boolean);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // --name value  or  -n value
        if ((arg === '--name' || arg === '-n') && i + 1 < args.length) {
          return args[i + 1];
        }
        // --name=value
        if (arg.startsWith('--name=')) {
          return arg.slice('--name='.length);
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async getDarwinSessionName(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o args= 2>/dev/null`);
      return parseSessionNameFromCommandLine(stdout.trim());
    } catch {
      return undefined;
    }
  }
}

function parseDarwinElapsedTime(value: string): number {
  const [daysPart, timePart] = value.includes('-') ? value.split('-', 2) : [undefined, value];
  const days = daysPart ? parseInt(daysPart, 10) : 0;
  const timeSegments = (timePart ?? '').split(':').map(segment => parseInt(segment, 10));

  if (timeSegments.some(segment => Number.isNaN(segment))) {
    return 0;
  }

  if (timeSegments.length === 3) {
    const [hours, minutes, seconds] = timeSegments;
    return days * 86_400 + hours * 3600 + minutes * 60 + seconds;
  }

  if (timeSegments.length === 2) {
    const [minutes, seconds] = timeSegments;
    return days * 86_400 + minutes * 60 + seconds;
  }

  return days * 86_400;
}

function parseSessionNameFromCommandLine(commandLine: string): string | undefined {
  const equalsMatch = commandLine.match(/(?:^|\s)--name=(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (equalsMatch) {
    return equalsMatch[1] ?? equalsMatch[2] ?? equalsMatch[3];
  }

  const separateMatch = commandLine.match(/(?:^|\s)(?:--name|-n)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (separateMatch) {
    return separateMatch[1] ?? separateMatch[2] ?? separateMatch[3];
  }

  return undefined;
}
