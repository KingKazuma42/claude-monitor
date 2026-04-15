import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { buildClaudeCliArgs } from '../utils/claudeCliArgs';

export interface TerminalInfo {
  terminal: vscode.Terminal;
  pid: number | undefined;
  name: string;
  isClaudeSession: boolean;
}

export class TerminalManager extends EventEmitter {
  private terminals: Map<vscode.Terminal, TerminalInfo> = new Map();
  private disposables: vscode.Disposable[] = [];
  /** tmux session name → VSCode Terminal (for sessions created or reattached here) */
  private tmuxSessionToTerminal: Map<string, vscode.Terminal> = new Map();
  /** VSCode Terminal → tmux session name (reverse lookup for cleanup) */
  private tmuxTerminalToSession: Map<vscode.Terminal, string> = new Map();

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
    // Clean up tmux mappings if this was a tmux-attached terminal
    const tmuxName = this.tmuxTerminalToSession.get(terminal);
    if (tmuxName) {
      this.tmuxSessionToTerminal.delete(tmuxName);
      this.tmuxTerminalToSession.delete(terminal);
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
   * Send a raw VT input sequence to the active terminal.
   * This works better for interactive pickers than sendText(), which behaves like paste.
   */
  async sendSequence(terminal: vscode.Terminal, text: string): Promise<void> {
    terminal.show(false);

    try {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text });
    } catch {
      const normalized = text.replace(/\r$/, '');
      terminal.sendText(normalized, true);
    }
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
   * Return the VSCode Terminal associated with a tmux session name, if any.
   * Used by the process monitor to link a tmux-managed Claude PID to its attach terminal.
   */
  getTmuxTerminal(sessionName: string): vscode.Terminal | undefined {
    return this.tmuxSessionToTerminal.get(sessionName);
  }

  /**
   * Returns true if the given terminal is still open and tracked.
   * Use this to validate cached terminal references before interacting with them.
   */
  isTerminalTracked(terminal: vscode.Terminal): boolean {
    return this.terminals.has(terminal);
  }

  /**
   * Create a new terminal that launches Claude inside a new tmux session.
   * The terminal attaches to the session immediately; when the terminal closes
   * (e.g. SSH disconnect) the tmux session continues running on the server.
   *
   * @param tmuxSessionName Name for the tmux session (must be unique)
   * @param workDir Working directory passed to both tmux and Claude
   * @param model Optional --model flag
   * @param agent Optional --agent flag
   * @param sessionName Optional --name flag shown in the monitor panel
   * @param environment Optional environment overrides
   */
  createTmuxClaudeTerminal(
    tmuxSessionName: string,
    workDir?: string,
    model?: string,
    agent?: string,
    sessionName?: string,
    environment?: Record<string, string>,
  ): vscode.Terminal {
    const args = buildClaudeCliArgs({ model, agent, sessionName });
    const name = sessionName ?? tmuxSessionName;

    // Run: tmux new-session -s <name> claude [args...]
    // tmux starts attached (no -d flag), so the terminal shows Claude directly.
    // When the VSCode terminal closes, tmux detaches and the session survives.
    const terminal = vscode.window.createTerminal({
      name,
      cwd: workDir,
      shellPath: 'tmux',
      shellArgs: ['new-session', '-s', tmuxSessionName, 'claude', ...args],
      env: environment,
    });

    this.tmuxSessionToTerminal.set(tmuxSessionName, terminal);
    this.tmuxTerminalToSession.set(terminal, tmuxSessionName);

    terminal.show();
    return terminal;
  }

  /**
   * Create a new terminal that reattaches to an existing tmux session.
   * Used when a session was detached (e.g. after SSH reconnect).
   *
   * @param tmuxSessionName Name of the existing tmux session
   * @param workDir Optional working directory hint for the terminal
   * @param terminalName Display name for the VSCode terminal tab
   */
  createReattachTerminal(
    tmuxSessionName: string,
    workDir?: string,
    terminalName?: string,
  ): vscode.Terminal {
    const terminal = vscode.window.createTerminal({
      name: terminalName ?? tmuxSessionName,
      cwd: workDir,
      shellPath: 'tmux',
      shellArgs: ['attach-session', '-t', tmuxSessionName],
    });

    this.tmuxSessionToTerminal.set(tmuxSessionName, terminal);
    this.tmuxTerminalToSession.set(terminal, tmuxSessionName);

    terminal.show();
    return terminal;
  }

  /**
   * Create a new terminal running Claude Code.
   * @param workDir Working directory
   * @param model Optional --model flag value (e.g. "claude-opus-4-5-20251001")
   * @param agent Optional --agent flag value (e.g. "reviewer")
   * @param sessionName Optional --name flag value shown in the monitor panel
   * @param environment Optional environment overrides applied to the launched terminal
   */
  createClaudeTerminal(
    workDir?: string,
    model?: string,
    agent?: string,
    sessionName?: string,
    environment?: Record<string, string>,
  ): vscode.Terminal {
    const args = buildClaudeCliArgs({ model, agent, sessionName });

    // Terminal title: prefer user-supplied name, then fall back to model/agent hints
    let name = 'claude';
    if (sessionName) {
      name = sessionName;
    } else if (agent) {
      name = `claude (${agent})`;
    } else if (model) {
      name = `claude (${model.split('-').slice(1, 3).join('-')})`;
    }

    const terminal = vscode.window.createTerminal({
      name,
      cwd: workDir,
      shellPath: 'claude',
      shellArgs: args,
      env: environment,
    });
    terminal.show();
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
    this.tmuxSessionToTerminal.clear();
    this.tmuxTerminalToSession.clear();
  }
}
