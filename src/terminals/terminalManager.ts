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

    // Shell integration output capture (VSCode 1.74+)
    if ('onDidWriteTerminalData' in vscode.window) {
      const onWrite = (vscode.window as unknown as {
        onDidWriteTerminalData: (handler: (e: { terminal: vscode.Terminal; data: string }) => void) => vscode.Disposable
      }).onDidWriteTerminalData;

      this.disposables.push(
        onWrite((e: { terminal: vscode.Terminal; data: string }) => {
          this.emit('data', e.terminal, e.data);
        })
      );
    }
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
   * Create a new terminal running Claude Code
   */
  createClaudeTerminal(workDir?: string): vscode.Terminal {
    const terminal = vscode.window.createTerminal({
      name: 'claude',
      cwd: workDir,
    });
    terminal.show();
    terminal.sendText('claude', true);
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
