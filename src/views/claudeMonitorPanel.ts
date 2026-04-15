import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeSession } from '../models/claudeSession';
import type { CronSchedule } from '../models/cronSchedule';

export class ClaudeMonitorPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudeMonitor.panel';

  private view?: vscode.WebviewView;
  private readonly extensionUri: vscode.Uri;
  private resolveCallbacks: Array<() => void> = [];
  private latestPayload: { type: 'update'; sessions: unknown[]; history: unknown[]; showUsageDashboard: boolean } = {
    type: 'update',
    sessions: [],
    history: [],
    showUsageDashboard: true,
  };
  private isReady = false;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  /**
   * Register a callback to be invoked when the webview is resolved
   */
  onDidResolve(callback: () => void): void {
    this.resolveCallbacks.push(callback);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.isReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'views', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'out'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Clean up when disposed
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.isReady = false;
    });

    // Notify listeners that the webview is now ready
    for (const cb of this.resolveCallbacks) {
      cb();
    }
  }

  /**
   * Called by the extension whenever session data changes
   */
  update(sessions: ClaudeSession[], history: SessionHistoryEntry[] = []): void {
    const showUsageDashboard = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('showUsageDashboard', true);
    const payload = sessions.map(s => ({
      id: s.id,
      pid: s.pid,
      terminalName: s.terminalName,
      workDir: s.workDir,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      outputLog: s.outputLog,
      cpuPercent: s.cpuPercent ?? 0,
      memoryMB: s.memoryMB ?? 0,
      contextWindow: s.contextWindow,
      contextPct: s.contextWindow?.pct ?? s.contextPct,
      conversation: s.conversation ?? [],
      isExternal: s.terminal === undefined,
      tmuxSessionName: s.tmuxSessionName,
    }));

    const historyPayload = history.map(s => ({
      id: s.id,
      pid: s.pid,
      terminalName: s.terminalName,
      workDir: s.workDir,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      stoppedAt: s.stoppedAt.toISOString(),
      outputLog: s.outputLog,
      cpuPercent: s.cpuPercent ?? 0,
      memoryMB: s.memoryMB ?? 0,
      contextWindow: s.contextWindow,
      contextPct: s.contextWindow?.pct ?? s.contextPct,
      conversation: s.conversation ?? [],
      isExternal: s.terminal === undefined,
      isHistorical: true,
    }));

    this.latestPayload = { type: 'update', sessions: payload, history: historyPayload, showUsageDashboard };
    this.flushLatestPayload();
  }

  markReady(): void {
    this.isReady = true;
    this.flushLatestPayload();
  }

  /**
   * Register a message handler from the WebView
   */
  onMessage(handler: (message: WebviewMessage) => void): vscode.Disposable {
    if (!this.view) {
      return { dispose: () => {} };
    }
    return this.view.webview.onDidReceiveMessage(handler);
  }

  /** Tell the webview to open the cron manager overlay. */
  openCronManager(): void {
    if (!this.view || !this.isReady) return;
    this.view.webview.postMessage({ type: 'openCronManager' });
  }

  /** Push the current cron schedule list to the webview. */
  sendCronSchedules(schedules: CronSchedule[]): void {
    if (!this.view || !this.isReady) return;
    this.view.webview.postMessage({ type: 'cronSchedules', schedules });
  }

  /** Notify the webview that a schedule just fired. */
  notifyCronFired(scheduleId: string, label: string, sessionCount: number): void {
    if (!this.view || !this.isReady) return;
    this.view.webview.postMessage({ type: 'cronFired', scheduleId, label, sessionCount });
  }

  private flushLatestPayload(): void {
    if (!this.view || !this.isReady) {
      return;
    }

    this.view.webview.postMessage(this.latestPayload);
  }

  private getHtml(webview: vscode.Webview): string {
    const webviewDir = path.join(this.extensionUri.fsPath, 'src', 'views', 'webview');

    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(webviewDir, 'style.css'))
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(webviewDir, 'main.js'))
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Claude Monitor</title>
</head>
<body>
  <div id="session-list" class="session-list"></div>
  <div id="cron-overlay" class="cron-overlay" style="display:none"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export interface WebviewMessage {
  type:
    | 'sendInstruction' | 'focusTerminal' | 'killSession'
    | 'refresh' | 'approvePermission' | 'ready' | 'reattachTmux'
    | 'getCronSchedules'
    | 'addCronSchedule' | 'updateCronSchedule' | 'deleteCronSchedule';
  sessionId?: string;
  text?: string;
  choice?: 'yes' | 'no';
  /** Cron schedule payload (add / update). */
  schedule?: CronSchedule;
  /** ID of the schedule to delete. */
  scheduleId?: string;
}

export interface SessionHistoryEntry extends ClaudeSession {
  stoppedAt: Date;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
