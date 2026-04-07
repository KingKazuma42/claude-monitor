import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ClaudeSession, createSession, updateSessionStatus } from './models/claudeSession';
import { ProcessMonitor, ProcessInfo } from './monitors/processMonitor';
import { FileWatcher, ClaudeFileActivity } from './monitors/fileWatcher';
import { TerminalManager } from './terminals/terminalManager';
import { ClaudeMonitorPanel } from './views/claudeMonitorPanel';
import { ClaudeStatusBar } from './views/statusBarItem';
import { IpcManager, IpcCommand } from './ipc/ipcManager';
import { pickDirectory, getDefaultStartDir } from './utils/directoryPicker';
import { findActivityOwnerPid } from './utils/sessionRouting';
import { CONTEXT_WINDOW_LIMIT } from './utils/contextPct';
import { getPermissionReplySequence } from './utils/permissionInput';
import { parseLaunchEnvironment } from './utils/launchEnvironment';
import {
  getTranscriptPathForSession,
  isRuntimeSessionMetadataConsistent,
  readRuntimeSessionMetadata,
} from './utils/runtimeSessionMetadata';
import { SessionHistoryEntry } from './views/claudeMonitorPanel';

// Sessions keyed by PID
const sessions = new Map<number, ClaudeSession>();
const sessionHistory: SessionHistoryEntry[] = [];
const MAX_SESSION_HISTORY = 10;

// Maps Claude session identity → PID for direct, collision-free routing.
const sessionIdToPid = new Map<string, number>();
const transcriptPathToPid = new Map<string, number>();
const pendingActivityBySessionId = new Map<string, ClaudeFileActivity>();
const pendingActivityByFilePath = new Map<string, ClaudeFileActivity>();
const PENDING_ACTIVITY_TTL_MS = 60_000;

let panel: ClaudeMonitorPanel;
let statusBar: ClaudeStatusBar;
let processMonitor: ProcessMonitor;
let fileWatcher: FileWatcher;
let terminalManager: TerminalManager;
let ipcManager: IpcManager;
let messageDisposable: vscode.Disposable | undefined;
let hasCleanedUp = false;
let contextWarningThresholdPct = 90;

function getSessions(): ClaudeSession[] {
  return Array.from(sessions.values());
}

function broadcastUpdate(): void {
  const all = getSessions();
  panel.update(disambiguateNames(all), sessionHistory);
  statusBar.update(all);
  // Tell IPC which PIDs we own (have terminals for in this window)
  ipcManager.setOwnedPids(
    all.filter(s => s.terminal !== undefined).map(s => s.pid)
  );
}

function handleProcessUpdate(processes: ProcessInfo[]): void {
  const seenPids = new Set(processes.map(p => p.pid));

  for (const proc of processes) {
    const termInfo = terminalManager.getByPid(proc.pid) ?? terminalManager.getByPid(proc.ppid);
    const metadata = readRuntimeSessionMetadata(proc.pid);
    const runtimeSession = metadata && isRuntimeSessionMetadataConsistent(metadata, proc.workDir, proc.startedAt)
      ? metadata
      : undefined;
    const runtimeWorkDir = runtimeSession?.cwd || proc.workDir;
    const runtimeStartedAt = runtimeSession ? new Date(runtimeSession.startedAt) : undefined;
    const transcriptPath = runtimeSession
      ? getTranscriptPathForSession(runtimeSession.sessionId, runtimeWorkDir)
      : undefined;
    const existing = sessions.get(proc.pid);
    let nextSession: ClaudeSession;
    if (existing) {
      const previousSessionId = existing.claudeSessionId;
      const previousTranscriptPath = existing.transcriptPath;
      if (
        previousSessionId !== runtimeSession?.sessionId ||
        previousTranscriptPath !== transcriptPath
      ) {
        clearIdentityMappingsForPid(proc.pid);
      }

      nextSession = {
        ...existing,
        terminal: existing.terminal ?? termInfo?.terminal,
        cpuPercent: proc.cpu,
        memoryMB: proc.memMB,
        workDir: runtimeWorkDir || existing.workDir,
        claudeSessionId: runtimeSession?.sessionId ?? existing.claudeSessionId,
        transcriptPath: transcriptPath ?? existing.transcriptPath,
        startedAt: runtimeStartedAt ?? existing.startedAt,
        // Preserve file-based status (thinking/waiting); only reset stopped → idle
        status: existing.status === 'stopped' ? 'idle' : existing.status,
      };
    } else {
      // Terminal PID = shell (bash/zsh). Claude's PPID = shell PID, so check both.
      const session = createSession(proc.pid, runtimeWorkDir, termInfo?.terminal);
      // If the process was started with `claude --name <name>` / `claude -n <name>`,
      // use that name so the user's chosen label is visible in the panel.
      if (proc.sessionName) {
        session.terminalName = proc.sessionName;
      }
      if (runtimeStartedAt) {
        session.startedAt = runtimeStartedAt;
        session.lastActivity = runtimeStartedAt;
      }
      nextSession = {
        ...session,
        conversation: [],
        cpuPercent: proc.cpu,
        memoryMB: proc.memMB,
        claudeSessionId: runtimeSession?.sessionId,
        transcriptPath,
      };
    }

    if (runtimeWorkDir) {
      fileWatcher.registerWorkDir(runtimeWorkDir);
    }

    if (nextSession.transcriptPath) {
      const pending = nextSession.claudeSessionId ? pendingActivityBySessionId.get(nextSession.claudeSessionId) : undefined;
      const pendingByPath = pendingActivityByFilePath.get(nextSession.transcriptPath);
      if (pending) {
        nextSession = buildSessionFromActivity(nextSession, pending);
        pendingActivityBySessionId.delete(nextSession.claudeSessionId!);
        pendingActivityByFilePath.delete(pending.filePath);
      } else if (pendingByPath) {
        nextSession = buildSessionFromActivity(nextSession, pendingByPath);
        pendingActivityByFilePath.delete(nextSession.transcriptPath!);
      } else if ((nextSession.conversation?.length ?? 0) === 0) {
        const hydrated = fileWatcher.readActivity(nextSession.transcriptPath);
        if (hydrated) {
          nextSession = buildSessionFromActivity(nextSession, hydrated);
        }
      }
    }

    if (nextSession.claudeSessionId) {
      sessionIdToPid.set(nextSession.claudeSessionId, proc.pid);
    }
    if (nextSession.transcriptPath) {
      transcriptPathToPid.set(nextSession.transcriptPath, proc.pid);
    }

    sessions.set(proc.pid, nextSession);
    if (existing) {
      notifySessionTransitions(existing, nextSession);
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
  prunePendingActivities(now);
  for (const [pid, session] of sessions) {
    if (session.status === 'stopped' && now - session.lastActivity.getTime() > 30000) {
      pushSessionHistory(session);
      clearPendingActivitiesForSession(session);
      sessions.delete(pid);
      clearIdentityMappingsForPid(pid);
    }
  }

  broadcastUpdate();
}

function handleFileActivity(activity: ClaudeFileActivity): void {
  const targetPid = findActivityOwnerPid(
    activity,
    getSessions().map(session => ({
      pid: session.pid,
      claudeSessionId: session.claudeSessionId,
      transcriptPath: session.transcriptPath,
      workDir: session.workDir,
      status: session.status,
    })),
    sessionIdToPid,
    transcriptPathToPid,
  );

  if (targetPid === undefined) {
    if (activity.sessionId) {
      pendingActivityBySessionId.set(activity.sessionId, activity);
    }
    pendingActivityByFilePath.set(activity.filePath, activity);
    return;
  }

  const session = sessions.get(targetPid);
  if (!session) {
    if (activity.sessionId) {
      pendingActivityBySessionId.set(activity.sessionId, activity);
    }
    pendingActivityByFilePath.set(activity.filePath, activity);
    return;
  }

  if (activity.sessionId) {
    sessionIdToPid.set(activity.sessionId, targetPid);
    pendingActivityBySessionId.delete(activity.sessionId);
  }
  transcriptPathToPid.set(activity.filePath, targetPid);
  pendingActivityByFilePath.delete(activity.filePath);
  const nextSession = buildSessionFromActivity(session, activity);
  sessions.set(targetPid, nextSession);
  notifySessionTransitions(session, nextSession);

  broadcastUpdate();
}

function buildSessionFromActivity(
  session: ClaudeSession,
  activity: ClaudeFileActivity
): ClaudeSession {
  let newStatus: import('./models/claudeSession').SessionStatus = session.status;
  if (session.status !== 'stopped' && activity.derivedStatus !== null) {
    newStatus = activity.derivedStatus;
  }
  return {
    ...session,
    conversation: activity.entries,
    status: newStatus,
    lastActivity: activity.updatedAt,
    claudeSessionId: activity.sessionId ?? session.claudeSessionId,
    transcriptPath: activity.filePath,
    contextPct: activity.contextPct,
  };
}

/**
 * Add `#1`, `#2` ... suffixes to sessions that share the same terminalName.
 * Ordering is by PID ascending so the suffix is stable across re-renders.
 * Sessions with a unique name are returned unchanged.
 * This is applied only to the webview payload — the underlying session objects
 * are not mutated.
 */
function disambiguateNames(sessions: ClaudeSession[]): ClaudeSession[] {
  // Group by raw terminalName
  const groups = new Map<string, ClaudeSession[]>();
  for (const s of sessions) {
    const list = groups.get(s.terminalName) ?? [];
    list.push(s);
    groups.set(s.terminalName, list);
  }

  return sessions.map(s => {
    const group = groups.get(s.terminalName)!;
    if (group.length <= 1) { return s; }
    // Stable ordering: lowest PID first → #1
    const sorted = [...group].sort((a, b) => a.pid - b.pid);
    const rank = sorted.indexOf(s) + 1;
    return { ...s, terminalName: `${s.terminalName} #${rank}` };
  });
}

function clearIdentityMappingsForPid(pid: number): void {
  for (const [sessionId, mappedPid] of sessionIdToPid) {
    if (mappedPid === pid) {
      sessionIdToPid.delete(sessionId);
    }
  }
  for (const [transcriptPath, mappedPid] of transcriptPathToPid) {
    if (mappedPid === pid) {
      transcriptPathToPid.delete(transcriptPath);
    }
  }
}

function clearPendingActivitiesForSession(session: ClaudeSession): void {
  if (session.claudeSessionId) {
    pendingActivityBySessionId.delete(session.claudeSessionId);
  }
  if (session.transcriptPath) {
    pendingActivityByFilePath.delete(session.transcriptPath);
  }
}

function pushSessionHistory(session: ClaudeSession): void {
  sessionHistory.unshift({
    ...session,
    conversation: session.conversation ?? [],
    stoppedAt: new Date(),
  });

  if (sessionHistory.length > MAX_SESSION_HISTORY) {
    sessionHistory.length = MAX_SESSION_HISTORY;
  }
}

function notifySessionTransitions(previous: ClaudeSession, next: ClaudeSession): void {
  const config = vscode.workspace.getConfiguration('claudeMonitor');
  const permissionNotificationsEnabled = config.get<boolean>('notifications.permission', true);
  const contextNotificationsEnabled = config.get<boolean>('notifications.contextWarning', true);

  if (permissionNotificationsEnabled && previous.status !== 'permission' && next.status === 'permission') {
    void vscode.window.showWarningMessage(`${next.terminalName}: 承認待ちです`, 'パネルを開く')
      .then(choice => {
        if (choice === 'パネルを開く') {
          void vscode.commands.executeCommand('claudeMonitor.focusPanel');
        }
      });
  }

  const previousPct = previous.contextPct ?? 0;
  const nextPct = next.contextPct ?? 0;
  if (contextNotificationsEnabled && previousPct < contextWarningThresholdPct && nextPct >= contextWarningThresholdPct) {
    void vscode.window.showWarningMessage(
      `${next.terminalName}: コンテキスト使用率が${contextWarningThresholdPct}%を超えました`
    );
  }
}

function applyConfiguration(config = vscode.workspace.getConfiguration('claudeMonitor')): void {
  processMonitor?.setInterval(config.get<number>('pollIntervalMs', 5000));
  fileWatcher?.setContextWindowLimit(config.get<number>('contextWindowTokens', CONTEXT_WINDOW_LIMIT));
  contextWarningThresholdPct = Math.min(100, Math.max(1, config.get<number>('notifications.contextWarningThresholdPct', 90)));
}

function getConfiguredLaunchEnvironment(): Record<string, string> | null | undefined {
  const rawValue = vscode.workspace.getConfiguration('claudeMonitor').get<string>('launchEnvironment', '').trim();
  if (!rawValue) {
    return undefined;
  }

  try {
    return parseLaunchEnvironment(rawValue);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `claudeMonitor.launchEnvironment の書式が不正です: ${(error as Error).message}`
    );
    return null;
  }
}

async function editLaunchEnvironmentSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeMonitor');
  const currentValue = config.get<string>('launchEnvironment', '');
  const nextValue = await vscode.window.showInputBox({
    title: '起動時の環境変数',
    prompt: 'KEY=value 形式で複数指定できます。空欄でクリアします。',
    placeHolder: '例: CLAUDE_CODE_NO_FLICKER=1 LABEL="my value"',
    value: currentValue,
  });
  if (nextValue === undefined) {
    return;
  }

  await config.update('launchEnvironment', nextValue.trim(), vscode.ConfigurationTarget.Workspace);
  broadcastUpdate();
}

function prunePendingActivities(now: number): void {
  for (const [sessionId, activity] of pendingActivityBySessionId) {
    if (now - activity.updatedAt.getTime() > PENDING_ACTIVITY_TTL_MS) {
      pendingActivityBySessionId.delete(sessionId);
    }
  }

  for (const [filePath, activity] of pendingActivityByFilePath) {
    if (now - activity.updatedAt.getTime() > PENDING_ACTIVITY_TTL_MS) {
      pendingActivityByFilePath.delete(filePath);
    }
  }
}

function cleanupResources(): void {
  if (hasCleanedUp) {
    return;
  }

  hasCleanedUp = true;
  processMonitor?.stop();
  fileWatcher?.stop();
  terminalManager?.stop();
  ipcManager?.stop();
  statusBar?.dispose();
  messageDisposable?.dispose();
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
async function handleIpcCommand(cmd: IpcCommand): Promise<void> {
  const session = getSessions().find(s => s.pid === cmd.targetPid);
  if (!session?.terminal) {
    // Shouldn't happen (IPC only dispatches for owned PIDs), but guard anyway
    return;
  }

  switch (cmd.type) {
    case 'sendText':
      terminalManager.sendText(session.terminal, cmd.text ?? '');
      break;
    case 'sendSequence':
      await terminalManager.sendSequence(session.terminal, cmd.text ?? '');
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
  hasCleanedUp = false;
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
    vscode.window.registerWebviewViewProvider(
      ClaudeMonitorPanel.viewId,
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Wire events ──
  processMonitor.on('update', handleProcessUpdate);
  processMonitor.on('error', (err: Error) => {
    console.error('[ClaudeMonitor] process monitor error:', err.message);
  });

  fileWatcher.on('activity', handleFileActivity);

  terminalManager.on('open', () => broadcastUpdate());
  terminalManager.on('close', () => broadcastUpdate());

  ipcManager.on('command', cmd => {
    void handleIpcCommand(cmd);
  });

  // ── Panel message handler ──
  // Register messages and send initial state when webview resolves
  panel.onDidResolve(() => {
    registerPanelMessages();
  });

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMonitor.refresh', () => {
      broadcastUpdate();
    }),

    vscode.commands.registerCommand('claudeMonitor.focusPanel', () => {
      vscode.commands.executeCommand('claudeMonitor.panel.focus');
    }),

    vscode.commands.registerCommand('claudeMonitor.editLaunchEnvironment', async () => {
      await editLaunchEnvironmentSetting();
    }),

    vscode.commands.registerCommand('claudeMonitor.newSession', async () => {
      // When multiple workspace folders exist, let the user pick the root first
      let startDir = getDefaultStartDir();

      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 1) {
        const picked = await vscode.window.showQuickPick(
          [
            ...folders.map(f => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
            { label: '$(home) ホームディレクトリから選ぶ', description: os.homedir(), fsPath: os.homedir() },
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

      const sessionName = await vscode.window.showInputBox({
        title: 'セッション名（任意）',
        prompt: '識別しやすい名前を入力してください。空欄でスキップ。',
        placeHolder: '例: backend, frontend, review など',
      });
      // null means the user cancelled the entire flow (Escape); '' means skipped
      if (sessionName === undefined) return;

      const launchEnvironment = getConfiguredLaunchEnvironment();
      if (launchEnvironment === null) return;

      terminalManager.createClaudeTerminal(
        workDir,
        config.model,
        config.agent,
        sessionName || undefined,
        launchEnvironment,
      );
    })
  );

  // ── Start everything ──
  processMonitor.start();
  fileWatcher.start();
  terminalManager.start();
  ipcManager.start();
  applyConfiguration(cfg);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('claudeMonitor.pollIntervalMs') ||
        event.affectsConfiguration('claudeMonitor.contextWindowTokens') ||
        event.affectsConfiguration('claudeMonitor.notifications.contextWarningThresholdPct')
      ) {
        applyConfiguration();
      }
    }),
    new vscode.Disposable(() => cleanupResources())
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
              const launchEnvironment = getConfiguredLaunchEnvironment();
              if (launchEnvironment === null) break;
              terminalManager.createClaudeTerminal(session.workDir, undefined, undefined, undefined, launchEnvironment);
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

      case 'ready':
        panel.markReady();
        broadcastUpdate();
        break;

      case 'approvePermission': {
        if (!msg.sessionId || (msg.choice !== 'yes' && msg.choice !== 'no')) break;
        const session = getSessions().find(s => s.id === msg.sessionId);
        if (!session) break;

        const sequence = getPermissionReplySequence(msg.choice);
        if (session.terminal) {
          await terminalManager.sendSequence(session.terminal, sequence);
        } else {
          const ok = await ipcManager.dispatch('sendSequence', session.pid, sequence);
          if (!ok) {
            vscode.window.showWarningMessage(
              `PID ${session.pid} のセッションに接続できませんでした。` +
              '別ウィンドウでも claude-monitor が起動しているか確認してください。'
            );
          }
        }
        break;
      }
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
  cleanupResources();
}
