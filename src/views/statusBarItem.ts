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
    const thinking = sessions.filter(s => s.status === 'thinking').length;
    const waiting  = sessions.filter(s => s.status === 'waiting').length;
    const idle     = sessions.filter(s => s.status === 'idle').length;
    const active   = sessions.filter(s => s.status !== 'stopped').length;

    if (active === 0) {
      this.item.text = '$(robot) Claude: なし';
      this.item.color = undefined;
    } else if (thinking > 0) {
      this.item.text = `$(robot) Claude: ${thinking} 考え中`;
      if (waiting > 0) this.item.text += ` / ${waiting} 待機`;
      this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
    } else if (waiting > 0) {
      this.item.text = `$(robot) Claude: ${waiting} 入力待ち`;
      this.item.color = undefined;
    } else {
      this.item.text = `$(robot) Claude: ${idle} アイドル`;
      this.item.color = undefined;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
