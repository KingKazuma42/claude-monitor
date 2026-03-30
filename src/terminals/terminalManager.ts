import * as vscode from 'vscode';
import { EventEmitter } from 'events';

export interface TerminalInfo {
  terminal: vscode.Terminal;
  pid: number | undefined;
  name: string;
  isClaudeSession: boolean;
}

export class TerminalManager extends EventEmitter {
  private terminals: Map<vscode.Terminal, TerminalInfo> = new Map();
  private disposables: vscode.Disposable[] = [];

  start(): void {
    // Track existing terminals
    for (const terminal of vscode.window.terminals) {
      this.trackTerminal(terminal);
    }

    this.disposables.push(
      vscode.window.onDidOpenTerminal(t => this.trackTerminal(t)),
      vscode.window.onDidCloseTerminal(t => this.removeTerminal(t))
    );

    // Note: onDidWriteTerminalData is a proposed API (terminalDataWriteEvent)
    // and cannot be used in published extensions. Terminal output capture
    // is skipped; logs are populated via file watcher instead.
  }

  private async trackTerminal(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    const info: TerminalInfo = {
      terminal,
      pid,
      name: terminal.name,
      isClaudeSession: this.looksLikeClaudeSession(terminal.name),
    };
    this.terminals.set(terminal, info);
    this.emit('open', info);
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    const info = this.terminals.get(terminal);
    if (info) {
      this.emit('close', info);
      this.terminals.delete(terminal);
    }
  }

  private looksLikeClaudeSession(name: string): boolean {
    return /claude/i.test(name);
  }

  getAll(): TerminalInfo[] {
    return Array.from(this.terminals.values());
  }

  getByPid(pid: number): TerminalInfo | undefined {
    for (const info of this.terminals.values()) {
      if (info.pid === pid) return info;
    }
    return undefined;
  }

  /**
   * Send text to a terminal (simulates typing Enter)
   */
  sendText(terminal: vscode.Terminal, text: string, addNewLine = true): void {
    terminal.sendText(text, addNewLine);
  }

  /**
   * Send text to terminal by PID
   */
  sendTextToPid(pid: number, text: string): boolean {
    const info = this.getByPid(pid);
    if (!info) return false;
    this.sendText(info.terminal, text);
    return true;
  }

  /**
   * Create a new terminal running Claude Code.
   * @param workDir Working directory
   * @param model Optional --model flag value (e.g. "claude-opus-4-5-20251001")
   * @param agent Optional --agent flag value (e.g. "reviewer")
   */
  createClaudeTerminal(workDir?: string, model?: string, agent?: string): vscode.Terminal {
    const args: string[] = [];
    if (model) {
      args.push(`--model ${model}`);
    }
    if (agent) {
      args.push(`--agent ${agent}`);
    }

    const cmd = args.length > 0 ? `claude ${args.join(' ')}` : 'claude';

    let name = 'claude';
    if (agent) {
      name = `claude (${agent})`;
    } else if (model) {
      name = `claude (${model.split('-').slice(1, 3).join('-')})`;
    }

    const terminal = vscode.window.createTerminal({ name, cwd: workDir });
    terminal.show();
    terminal.sendText(cmd, true);
    return terminal;
  }

  /**
   * Focus a terminal
   */
  focusTerminal(terminal: vscode.Terminal): void {
    terminal.show(false);
  }

  stop(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.terminals.clear();
  }
}
