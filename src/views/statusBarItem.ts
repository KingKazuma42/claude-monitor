import * as vscode from 'vscode';
import { ClaudeSession } from '../models/claudeSession';

export class ClaudeStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'claudeMonitor.focusPanel';
    this.item.tooltip = 'Claude Monitor - クリックでパネルを開く';
    this.update([]);
    this.item.show();
  }

  update(sessions: ClaudeSession[]): void {
    const running = sessions.filter(s => s.status === 'running').length;
    const idle = sessions.filter(s => s.status === 'idle').length;
    const total = sessions.length;

    if (total === 0) {
      this.item.text = '$(robot) Claude: なし';
      this.item.color = undefined;
    } else if (running > 0) {
      this.item.text = `$(robot) Claude: ${running} 実行中`;
      if (idle > 0) {
        this.item.text += ` / ${idle} 待機`;
      }
      this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
    } else {
      this.item.text = `$(robot) Claude: ${idle} 待機`;
      this.item.color = undefined;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
