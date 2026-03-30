import * as vscode from 'vscode';
import { ClaudeSession, createSession, updateSessionStatus, appendLog } from './models/claudeSession';
import { ProcessMonitor, ProcessInfo } from './monitors/processMonitor';
import { FileWatcher, ClaudeFileActivity, ConversationEntry } from './monitors/fileWatcher';
import { TerminalManager } from './terminals/terminalManager';
import { ClaudeMonitorPanel } from './views/claudeMonitorPanel';
import { ClaudeStatusBar } from './views/statusBarItem';

// Sessions keyed by PID
const sessions = new Map<number, ClaudeSession & { conversation?: ConversationEntry[] }>();

let panel: ClaudeMonitorPanel;
let statusBar: ClaudeStatusBar;
let processMonitor: ProcessMonitor;
let fileWatcher: FileWatcher;
let terminalManager: TerminalManager;
let messageDisposable: vscode.Disposable | undefined;

function getSessions(): ClaudeSession[] {
  return Array.from(sessions.values());
}

function broadcastUpdate(): void {
  const all = getSessions();
  panel.update(all);
  statusBar.update(all);
}

function handleProcessUpdate(processes: ProcessInfo[]): void {
  const seenPids = new Set(processes.map(p => p.pid));

  // Add / update sessions from process list
  for (const proc of processes) {
    const existing = sessions.get(proc.pid);
    if (existing) {
      sessions.set(proc.pid, {
        ...existing,
        cpuPercent: proc.cpu,
        memoryMB: proc.memMB,
        workDir: proc.workDir || existing.workDir,
        status: 'running',
      });
    } else {
      // New process — try to find matching terminal
      const termInfo = terminalManager.getByPid(proc.pid);
      const session = createSession(proc.pid, proc.workDir, termInfo?.terminal);
      (session as any).conversation = [];
      sessions.set(proc.pid, { ...session, cpuPercent: proc.cpu, memoryMB: proc.memMB });
    }
  }

  // Mark missing processes as stopped and remove them after a grace period
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
  // Find the session whose workDir matches the activity
  for (const [pid, session] of sessions) {
    if (activity.workDir && session.workDir.includes(activity.workDir)) {
      (session as any).conversation = activity.entries;
      sessions.set(pid, { ...session, lastActivity: activity.updatedAt });
      break;
    }
  }
  broadcastUpdate();
}

function handleTerminalData(terminal: vscode.Terminal, data: string): void {
  const lines = data.split(/\r?\n/).filter(l => l.trim());
  for (const [pid, session] of sessions) {
    if (session.terminal === terminal) {
      const cfg = vscode.workspace.getConfiguration('claudeMonitor');
      const maxLines = cfg.get<number>('maxLogLines', 100);
      let updated = session;
      for (const line of lines) {
        updated = appendLog(updated, line, maxLines);
      }
      sessions.set(pid, updated as any);
      break;
    }
  }
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

  terminalManager.on('data', handleTerminalData);
  terminalManager.on('open', () => broadcastUpdate());
  terminalManager.on('close', () => broadcastUpdate());

  // ── Panel message handler (attached after first resolveWebviewView) ──
  // We use a deferred approach: re-register each time the panel resolves
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Re-register panel message listener when context changes
      registerPanelMessages();
    })
  );

  // Initial registration attempt
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
      const workspaceFolders = vscode.workspace.workspaceFolders;
      let workDir: string | undefined;

      if (workspaceFolders && workspaceFolders.length > 1) {
        const picked = await vscode.window.showQuickPick(
          workspaceFolders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
          { placeHolder: '作業ディレクトリを選択' }
        );
        workDir = picked?.folder.uri.fsPath;
      } else if (workspaceFolders?.length === 1) {
        workDir = workspaceFolders[0].uri.fsPath;
      }

      terminalManager.createClaudeTerminal(workDir);
    })
  );

  // ── Start monitors ──
  processMonitor.start();
  fileWatcher.start();
  terminalManager.start();

  context.subscriptions.push(
    new vscode.Disposable(() => {
      processMonitor.stop();
      fileWatcher.stop();
      terminalManager.stop();
      statusBar.dispose();
      messageDisposable?.dispose();
    })
  );
}

function registerPanelMessages(): void {
  messageDisposable?.dispose();
  messageDisposable = panel.onMessage(msg => {
    switch (msg.type) {
      case 'sendInstruction': {
        if (!msg.sessionId) break;
        const session = getSessions().find(s => s.id === msg.sessionId);
        if (!session?.terminal) {
          vscode.window.showWarningMessage('ターミナルが見つかりません。');
          break;
        }
        terminalManager.sendText(session.terminal, msg.text ?? '');
        break;
      }
      case 'focusTerminal': {
        if (!msg.sessionId) break;
        const session = getSessions().find(s => s.id === msg.sessionId);
        if (!session?.terminal) {
          vscode.window.showWarningMessage('ターミナルが見つかりません。');
          break;
        }
        terminalManager.focusTerminal(session.terminal);
        break;
      }
      case 'refresh':
        broadcastUpdate();
        break;
    }
  });
}

export function deactivate(): void {
  processMonitor?.stop();
  fileWatcher?.stop();
  terminalManager?.stop();
  statusBar?.dispose();
  messageDisposable?.dispose();
}
