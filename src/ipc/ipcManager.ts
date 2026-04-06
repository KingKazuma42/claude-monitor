import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

export interface IpcCommand {
  id: string;
  type: 'sendText' | 'sendSequence' | 'focus' | 'kill';
  targetPid: number;
  text?: string;
  status: 'pending' | 'done' | 'error';
  createdAt: number;
}

const IPC_FILE = path.join(os.homedir(), '.claude', 'monitor-ipc.json');
const CMD_TTL_MS = 30_000;
const POLL_MS = 500;

/**
 * File-based IPC so one VSCode window's claude-monitor can send commands
 * to a session owned by a different VSCode window.
 *
 * Each Extension instance:
 *  - calls setOwnedPids() after every process update
 *  - polls the shared file and emits 'command' for any pending command
 *    whose targetPid it owns
 *  - calls markDone() after executing the command
 */
export class IpcManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private ownedPids: Set<number> = new Set();
  private lastMtime = 0;
  private pendingChecks: Set<NodeJS.Timeout> = new Set();

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const check of this.pendingChecks) {
      clearInterval(check);
    }
    this.pendingChecks.clear();
  }

  setOwnedPids(pids: number[]): void {
    this.ownedPids = new Set(pids);
  }

  /**
   * Write a command and wait up to timeoutMs for another instance to execute it.
   * Returns true if acknowledged, false if timed out.
   */
  async dispatch(
    type: IpcCommand['type'],
    targetPid: number,
    text?: string,
    timeoutMs = 3000
  ): Promise<boolean> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const state = this.read();
    state.push({ id, type, targetPid, text, status: 'pending', createdAt: Date.now() });
    this.write(state);

    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const check = setInterval(() => {
        const current = this.read();
        const cmd = current.find(c => c.id === id);

        if (!cmd || cmd.status === 'done') {
          clearInterval(check);
          this.pendingChecks.delete(check);
          this.write(current.filter(c => c.id !== id));
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(check);
          this.pendingChecks.delete(check);
          this.write(current.filter(c => c.id !== id));
          resolve(false);
        }
      }, 100);
      this.pendingChecks.add(check);
    });
  }

  markDone(id: string): void {
    const state = this.read();
    const cmd = state.find(c => c.id === id);
    if (cmd) {
      cmd.status = 'done';
      this.write(state);
    }
  }

  private poll(): void {
    try {
      const mtime = fs.statSync(IPC_FILE).mtimeMs;
      if (mtime === this.lastMtime) return;
      this.lastMtime = mtime;
    } catch {
      return;
    }

    const state = this.read();
    for (const cmd of state) {
      if (cmd.status === 'pending' && this.ownedPids.has(cmd.targetPid)) {
        this.emit('command', cmd);
      }
    }
  }

  private read(): IpcCommand[] {
    try {
      const data = JSON.parse(fs.readFileSync(IPC_FILE, 'utf-8')) as unknown;
      if (!Array.isArray(data)) return [];
      const now = Date.now();
      return (data as IpcCommand[]).filter(c => now - c.createdAt < CMD_TTL_MS);
    } catch {
      return [];
    }
  }

  private write(commands: IpcCommand[]): void {
    const dir = path.dirname(IPC_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${IPC_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(commands), 'utf-8');
    fs.renameSync(tempPath, IPC_FILE);
  }
}
