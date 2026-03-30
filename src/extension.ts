import * as vscode from 'vscode';
import { ClaudeSession, createSession, updateSessionStatus } from './models/claudeSession';
import { ProcessMonitor, ProcessInfo } from './monitors/processMonitor';
import { FileWatcher, ClaudeFileActivity, ConversationEntry } from './monitors/fileWatcher';
import { TerminalManager } from './terminals/terminalManager';
import { ClaudeMonitorPanel } from './views/claudeMonitorPanel';
import { ClaudeStatusBar } from './views/statusBarItem';
import { IpcManager, IpcCommand } from './ipc/ipcManager';
import { pickDirectory, getDefaultStartDir } from './utils/directoryPicker';

// Sessions keyed by PID
const sessions = new Map<number, ClaudeSession & { conversation?: ConversationEntry[] }>();

let panel: ClaudeMonitorPanel;
let statusBar: ClaudeStatusBar;
let processMonitor: ProcessMonitor;
let fileWatcher: FileWatcher;
let terminalManager: TerminalManager;
let ipcManager: IpcManager;
let messageDisposable: vscode.Disposable | undefined;

function getSessions(): ClaudeSession[] {
  return Array.from(sessions.values());
}

function broadcastUpdate(): void {
  const all = getSessions();
  panel.update(all);
  statusBar.update(all);
  // Tell IPC which PIDs we own (have terminals for in this window)
  ipcManager.setOwnedPids(
    all.filter(s => s.terminal !== undefined).map(s => s.pid)
  );
}

function handleProcessUpdate(processes: ProcessInfo[]): void {
  const seenPids = new Set(processes.map(p => p.pid));

  for (const proc of processes) {
    const existing = sessions.get(proc.pid);
    if (existing) {
      sessions.set(proc.pid, {
        ...existing,
        cpuPercent: proc.cpu,
        memoryMB: proc.memMB,
        workDir: proc.workDir || existing.workDir,
        // Preserve file-based status (thinking/waiting); only reset stopped → idle
        status: existing.status === 'stopped' ? 'idle' : existing.status,
      });
    } else {
      // Terminal PID = shell (bash/zsh). Claude's PPID = shell PID, so check both.
      const termInfo = terminalManager.getByPid(proc.pid) ?? terminalManager.getByPid(proc.ppid);
      const session = createSession(proc.pid, proc.workDir, termInfo?.terminal);
      (session as any).conversation = [];
      sessions.set(proc.pid, { ...session, cpuPercent: proc.cpu, memoryMB: proc.memMB });
    }
  }

  // Mark missing as stopped
  for (const [pid, session] of sessions) {
    if (!seenPids.has(pid) && session.status !== 'stopped') {
      sessions.set(pid, updateSessionStatus(session, 'stopped'));
    }
  }

  // Prune stopped sessions older than 30s
  const now = Date.now();
  for (const [pid, session] of sessions) {
    if (session.status === 'stopped' && now - session.lastActivity.getTime() > 30000) {
      sessions.delete(pid);
    }
  }

  broadcastUpdate();
}

function handleFileActivity(activity: ClaudeFileActivity): void {
  for (const [pid, session] of sessions) {
    if (activity.workDir && session.workDir.includes(activity.workDir)) {
      // Derive status from last JSONL entry role
      let newStatus = session.status;
      if (session.status !== 'stopped') {
        if (activity.lastEntryRole === 'user') {
          newStatus = 'thinking';   // Claude received user input → now processing
        } else if (activity.lastEntryRole === 'assistant') {
          newStatus = 'waiting';    // Claude replied → awaiting next instruction
        }
      }
      (session as any).conversation = activity.entries;
      sessions.set(pid, { ...session, status: newStatus, lastActivity: activity.updatedAt });
      break;
    }
  }
  broadcastUpdate();
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.error(`[ClaudeMonitor] kill ${pid} failed:`, e);
  }
}

/**
 * Handle IPC commands sent by other VSCode window's claude-monitor instances.
 * Only called for PIDs that belong to a terminal in THIS window.
 */
function handleIpcCommand(cmd: IpcCommand): void {
  const session = getSessions().find(s => s.pid === cmd.targetPid);
  if (!session?.terminal) {
    // Shouldn't happen (IPC only dispatches for owned PIDs), but guard anyway
    return;
  }

  switch (cmd.type) {
    case 'sendText':
      terminalManager.sendText(session.terminal, cmd.text ?? '');
      break;
    case 'focus':
      terminalManager.focusTerminal(session.terminal);
      vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      break;
    case 'kill':
      killProcess(session.pid);
      break;
  }

  ipcManager.markDone(cmd.id);
}

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('claudeMonitor');
  const pollInterval = cfg.get<number>('pollIntervalMs', 5000);

  // ── Components ──
  panel = new ClaudeMonitorPanel(context.extensionUri);
  statusBar = new ClaudeStatusBar();
  processMonitor = new ProcessMonitor(pollInterval);
  fileWatcher = new FileWatcher();
  terminalManager = new TerminalManager();
  ipcManager = new IpcManager();

  // ── WebView provider ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ClaudeMonitorPanel.viewId, panel)
  );

  // ── Wire events ──
  processMonitor.on('update', handleProcessUpdate);
  processMonitor.on('error', (err: Error) => {
    console.error('[ClaudeMonitor] process monitor error:', err.message);
  });

  fileWatcher.on('activity', handleFileActivity);

  terminalManager.on('open', () => broadcastUpdate());
  terminalManager.on('close', () => broadcastUpdate());

  ipcManager.on('command', handleIpcCommand);

  // ── Panel message handler ──
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      registerPanelMessages();
    })
  );
  setTimeout(() => registerPanelMessages(), 500);

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMonitor.refresh', () => {
      broadcastUpdate();
    }),

    vscode.commands.registerCommand('claudeMonitor.focusPanel', () => {
      vscode.commands.executeCommand('claudeMonitor.panel.focus');
    }),

    vscode.commands.registerCommand('claudeMonitor.newSession', async () => {
      // When multiple workspace folders exist, let the user pick the root first
      let startDir = getDefaultStartDir();

      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 1) {
        const picked = await vscode.window.showQuickPick(
          [
            ...folders.map(f => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
            { label: '$(home) ホームディレクトリから選ぶ', description: require('os').homedir(), fsPath: require('os').homedir() },
          ],
          { title: 'ルートディレクトリを選択', placeHolder: 'サブディレクトリはこの後選べます' }
        );
        if (!picked) return;
        startDir = picked.fsPath;
      }

      const workDir = await pickDirectory(startDir);
      if (!workDir) return;

      // model: undefined = default, null = cancelled
      const model = await pickModel();
      if (model === null) return;

      terminalManager.createClaudeTerminal(workDir, model ?? undefined);
    })
  );

  // ── Start everything ──
  processMonitor.start();
  fileWatcher.start();
  terminalManager.start();
  ipcManager.start();

  context.subscriptions.push(
    new vscode.Disposable(() => {
      processMonitor.stop();
      fileWatcher.stop();
      terminalManager.stop();
      ipcManager.stop();
      statusBar.dispose();
      messageDisposable?.dispose();
    })
  );
}

function registerPanelMessages(): void {
  messageDisposable?.dispose();
  messageDisposable = panel.onMessage(async msg => {
    switch (msg.type) {
      case 'sendInstruction': {
        if (!msg.sessionId || !msg.text) break;
        const session = getSessions().find(s => s.id === msg.sessionId);
        if (!session) break;

        if (session.terminal) {
          // Local session — direct send
          terminalManager.sendText(session.terminal, msg.text);
        } else {
          // External session — try IPC to the window that owns this PID
          const ok = await ipcManager.dispatch('sendText', session.pid, msg.text);
          if (!ok) {
            vscode.window.showWarningMessage(
              `PID ${session.pid} のセッションに接続できませんでした。` +
              '別ウィンドウでも claude-monitor が起動しているか確認してください。'
            );
          }
        }
        break;
      }

      case 'focusTerminal': {
        if (!msg.sessionId) break;
        const session = getSessions().find(s => s.id === msg.sessionId);
        if (!session) break;

        if (session.terminal) {
          // Local session — focus directly
          terminalManager.focusTerminal(session.terminal);
        } else {
          // External session — try IPC first
          const ok = await ipcManager.dispatch('focus', session.pid);
          if (!ok) {
            // Fallback: open a new terminal at the same workDir
            const answer = await vscode.window.showWarningMessage(
              `PID ${session.pid} は別ウィンドウで実行中です。` +
              'このウィンドウで同じディレクトリに新しいセッションを開きますか？',
              '開く', 'キャンセル'
            );
            if (answer === '開く') {
              terminalManager.createClaudeTerminal(session.workDir);
            }
          }
        }
        break;
      }

      case 'killSession': {
        if (!msg.sessionId) break;
        const session = getSessions().find(s => s.id === msg.sessionId);
        if (!session) break;

        const answer = await vscode.window.showWarningMessage(
          `PID ${session.pid} のClaudeセッションを終了しますか？`,
          { modal: true },
          '終了する'
        );
        if (answer !== '終了する') break;

        if (session.terminal) {
          killProcess(session.pid);
        } else {
          const ok = await ipcManager.dispatch('kill', session.pid);
          if (!ok) {
            // Fallback: try to kill directly even if not "owned" by us
            killProcess(session.pid);
          }
        }
        break;
      }

      case 'refresh':
        broadcastUpdate();
        break;
    }
  });
}

/**
 * Show a model/agent selection QuickPick.
 * Returns the model ID string, undefined (default), or null (cancelled).
 */
async function pickModel(): Promise<string | undefined | null> {
  const MODELS = [
    { label: '$(sparkle) デフォルト',           description: 'Claudeのデフォルトモデル',        model: undefined },
    { label: '$(rocket) Opus 4',               description: '最高性能・複雑なタスク向け',        model: 'claude-opus-4-5-20251001' },
    { label: '$(zap) Sonnet 4',                description: 'バランス型・汎用途',               model: 'claude-sonnet-4-5-20251001' },
    { label: '$(dash) Haiku 4',                description: '高速・軽量タスク向け',             model: 'claude-haiku-4-5-20251001' },
    { label: '$(edit) カスタム...',              description: 'モデルIDを直接入力',              model: '__custom__' },
  ];

  const picked = await vscode.window.showQuickPick(MODELS, {
    title: '使用するモデル / エージェントを選択',
    placeHolder: 'デフォルトは Claude のデフォルトモデルが使用されます',
  });

  if (!picked) return null; // cancelled

  if (picked.model === '__custom__') {
    const input = await vscode.window.showInputBox({
      title: 'モデルIDを入力',
      prompt: '例: claude-opus-4-5-20251001',
      placeHolder: 'claude-...',
    });
    if (!input) return null; // cancelled
    return input.trim();
  }

  return picked.model; // undefined = default
}

export function deactivate(): void {
  processMonitor?.stop();
  fileWatcher?.stop();
  terminalManager?.stop();
  ipcManager?.stop();
  statusBar?.dispose();
  messageDisposable?.dispose();
}
