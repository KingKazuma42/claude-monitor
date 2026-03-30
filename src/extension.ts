import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

      // Register workDir mapping for FileWatcher
      if (proc.workDir) {
        fileWatcher.registerWorkDir(proc.workDir);
      }
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
  // Match by file path pattern: look for session whose workDir matches the JSONL location
  // Claude stores projects in ~/.claude/projects/<encoded-workdir>/*.jsonl
  // We match by checking if the file path contains the session's workDir

  for (const [pid, session] of sessions) {
    // Check if this JSONL file could belong to this session
    // Simple heuristic: file path contains key parts of session workDir
    const workDirParts = session.workDir.split(path.sep).filter(Boolean).slice(-2);  // last 2 segments
    const filePathLower = activity.filePath.toLowerCase();

    let isMatch = false;
    if (workDirParts.length > 0) {
      const pattern = workDirParts.join('').toLowerCase().replace(/[_-]/g, '');
      const encodedPart = filePathLower.split('.claude/projects/')[1];
      if (encodedPart) {
        const encoded = encodedPart.split('/')[0].replace(/[_-]/g, '');
        isMatch = encoded.includes(pattern) || pattern.includes(encoded);
      }
    }

    // Fallback: use inferWorkDir result if available
    if (!isMatch && activity.workDir) {
      const activityPath = path.resolve(activity.workDir);
      const sessionPath = path.resolve(session.workDir);
      isMatch = sessionPath === activityPath || sessionPath.startsWith(activityPath + path.sep);
    }

    if (isMatch) {
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
  // Register messages and send initial state when webview resolves
  panel.onDidResolve(() => {
    registerPanelMessages();
    broadcastUpdate();
  });

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

      const config = await pickModelAndAgent(workDir);
      if (config === null) return;

      terminalManager.createClaudeTerminal(workDir, config.model, config.agent);
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

interface AgentDefinition {
  name: string;
  description?: string;
  filePath: string;
}

/**
 * Scan .claude/agents directory for agent definitions
 */
function scanAgents(workDir: string): AgentDefinition[] {
  const agentsDir = path.join(workDir, '.claude', 'agents');
  const agents: AgentDefinition[] = [];

  try {
    if (!fs.existsSync(agentsDir)) {
      return agents;
    }

    const files = fs.readdirSync(agentsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(agentsDir, file);
      const agentName = file.replace(/\.md$/, '');

      // Try to extract description from frontmatter
      let description: string | undefined;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (match) {
          const frontmatter = match[1];
          const descMatch = frontmatter.match(/description:\s*(.+)/);
          if (descMatch) {
            description = descMatch[1].trim();
          }
        }
      } catch {
        // Ignore read errors
      }

      agents.push({ name: agentName, description, filePath });
    }
  } catch {
    // Directory doesn't exist or read error
  }

  return agents;
}

/**
 * Show a model/agent selection QuickPick.
 * Returns the configuration object or null if cancelled.
 */
async function pickModelAndAgent(workDir: string): Promise<{ model?: string; agent?: string } | null> {
  interface PickItem extends vscode.QuickPickItem {
    model?: string | '__custom__';
    agent?: string | '__prompt__';
  }

  const ITEMS: PickItem[] = [
    { label: '$(sparkle) デフォルト',           description: 'Claudeのデフォルトモデル',        model: undefined },
    { label: '$(rocket) Opus 4',               description: '最高性能・複雑なタスク向け',        model: 'claude-opus-4-5-20251001' },
    { label: '$(zap) Sonnet 4',                description: 'バランス型・汎用途',               model: 'claude-sonnet-4-5-20251001' },
    { label: '$(dash) Haiku 4',                description: '高速・軽量タスク向け',             model: 'claude-haiku-4-5-20251001' },
    { label: '$(edit) カスタムモデル...',        description: 'モデルIDを直接入力',              model: '__custom__' },
  ];

  // Scan for project-specific agents
  const projectAgents = scanAgents(workDir);
  if (projectAgents.length > 0) {
    ITEMS.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    ITEMS.push({ label: 'プロジェクト定義エージェント', kind: vscode.QuickPickItemKind.Separator });
    for (const agent of projectAgents) {
      ITEMS.push({
        label: `$(beaker) ${agent.name}`,
        description: agent.description || 'プロジェクト定義エージェント',
        agent: agent.name,
      });
    }
  }

  // Add generic agent option
  ITEMS.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  ITEMS.push({ label: '$(beaker) エージェントを手動入力...',   description: 'エージェント名を直接入力',            agent: '__prompt__' });

  const picked = await vscode.window.showQuickPick(ITEMS, {
    title: '使用するモデル / エージェントを選択',
    placeHolder: 'デフォルトは Claude のデフォルトモデルが使用されます',
  });

  if (!picked) return null; // cancelled

  // Handle custom model input
  if (picked.model === '__custom__') {
    const input = await vscode.window.showInputBox({
      title: 'モデルIDを入力',
      prompt: '例: claude-opus-4-5-20251001',
      placeHolder: 'claude-...',
    });
    if (!input) return null; // cancelled
    return { model: input.trim() };
  }

  // Handle agent prompt
  if (picked.agent === '__prompt__') {
    const input = await vscode.window.showInputBox({
      title: 'エージェント名を入力',
      prompt: '例: reviewer, planner, など',
      placeHolder: 'エージェント名',
    });
    if (!input) return null; // cancelled
    return { agent: input.trim() };
  }

  // Return agent if selected
  if (picked.agent) {
    return { agent: picked.agent };
  }

  return { model: picked.model }; // undefined = default
}

export function deactivate(): void {
  processMonitor?.stop();
  fileWatcher?.stop();
  terminalManager?.stop();
  ipcManager?.stop();
  statusBar?.dispose();
  messageDisposable?.dispose();
}
