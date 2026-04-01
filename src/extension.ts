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

// Maps JSONL file path → PID for direct session lookup (avoids workDir ambiguity)
const fileToSession = new Map<string, number>();

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
        // Associate the most recently created unclaimed JSONL file with this session
        associateJsonlFile(proc.pid, proc.workDir);
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
      // Remove file associations for this pid
      for (const [filePath, mappedPid] of fileToSession) {
        if (mappedPid === pid) fileToSession.delete(filePath);
      }
    }
  }

  broadcastUpdate();
}

function handleFileActivity(activity: ClaudeFileActivity): void {
  // 1. Direct lookup: JSONL file already associated with a specific session
  const directPid = fileToSession.get(activity.filePath);
  if (directPid !== undefined) {
    const session = sessions.get(directPid);
    if (session) {
      updateSessionFromActivity(directPid, session, activity);
      broadcastUpdate();
      return;
    }
  }

  // 2. Exact workDir match (using cwd from JSONL entries)
  const exactMatches: number[] = [];
  if (activity.workDir) {
    for (const [pid, session] of sessions) {
      if (isWorkDirMatch(activity.workDir, session.workDir)) {
        exactMatches.push(pid);
      }
    }
  }

  if (exactMatches.length === 1) {
    // Unambiguous — associate and update
    const pid = exactMatches[0];
    fileToSession.set(activity.filePath, pid);
    updateSessionFromActivity(pid, sessions.get(pid)!, activity);
  } else if (exactMatches.length > 1) {
    // Multiple sessions in same workDir — associate with the one not yet mapped to any file
    const unclaimed = exactMatches.filter(
      pid => !Array.from(fileToSession.values()).includes(pid)
    );
    const targetPid = unclaimed[0] ?? exactMatches[exactMatches.length - 1];
    fileToSession.set(activity.filePath, targetPid);
    updateSessionFromActivity(targetPid, sessions.get(targetPid)!, activity);
  } else {
    // 3. Fallback: loose heuristic match
    for (const [pid, session] of sessions) {
      if (looseWorkDirMatch(activity.filePath, session.workDir)) {
        fileToSession.set(activity.filePath, pid);
        updateSessionFromActivity(pid, session, activity);
        break;
      }
    }
  }

  broadcastUpdate();
}

function updateSessionFromActivity(
  pid: number,
  session: ClaudeSession & { conversation?: ConversationEntry[] },
  activity: ClaudeFileActivity
): void {
  let newStatus: import('./models/claudeSession').SessionStatus = session.status;
  if (session.status !== 'stopped' && activity.derivedStatus !== null) {
    newStatus = activity.derivedStatus;
  }
  (session as any).conversation = activity.entries;
  sessions.set(pid, { ...session, status: newStatus, lastActivity: activity.updatedAt });
}

/**
 * Find the most recently modified JSONL file in the session's project dir
 * that is not yet claimed by another session, and associate it with this PID.
 * Uses Claude's simple path encoding: /home/user/foo → -home-user-foo
 */
function associateJsonlFile(pid: number, workDir: string): void {
  const homeDir = process.env['HOME'] ?? '/root';
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  const encoded = '-' + workDir.slice(1).replace(/[/_]/g, '-');
  const projectDir = path.join(projectsDir, encoded);

  if (!fs.existsSync(projectDir)) return;

  try {
    const claimedFiles = new Set(fileToSession.keys());
    const unclaimed = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(projectDir, f);
        return { filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .find(f => !claimedFiles.has(f.filePath));

    if (unclaimed) {
      fileToSession.set(unclaimed.filePath, pid);
    }
  } catch { /* ignore */ }
}

/** Exact workDir comparison (preferred when cwd is extracted from JSONL). */
function isWorkDirMatch(activityWorkDir: string, sessionWorkDir: string): boolean {
  if (!activityWorkDir || !sessionWorkDir) return false;
  return path.resolve(activityWorkDir) === path.resolve(sessionWorkDir);
}

/** Loose heuristic match using encoded path segments (fallback only). */
function looseWorkDirMatch(filePath: string, sessionWorkDir: string): boolean {
  if (!sessionWorkDir) return false;
  const workDirParts = sessionWorkDir.split(path.sep).filter(Boolean).slice(-3); // last 3 segments
  if (workDirParts.length === 0) return false;
  const pattern = workDirParts.join('').toLowerCase().replace(/[_-]/g, '');
  const filePathLower = filePath.toLowerCase();
  const encodedPart = filePathLower.split('.claude/projects/')[1];
  if (!encodedPart) return false;
  const encoded = encodedPart.split('/')[0].replace(/[_-]/g, '');
  // Only match if pattern is contained in encoded (not the other way around to avoid short-path false positives)
  return encoded.includes(pattern);
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
