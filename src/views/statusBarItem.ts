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
    const thinking   = sessions.filter(s => s.status === 'thinking').length;
    const running    = sessions.filter(s => s.status === 'running').length;
    const permission = sessions.filter(s => s.status === 'permission').length;
    const waiting    = sessions.filter(s => s.status === 'waiting').length;
    const idle       = sessions.filter(s => s.status === 'idle').length;
    const active     = sessions.filter(s => s.status !== 'stopped').length;

    if (active === 0) {
      this.item.text = '$(robot) Claude: なし';
      this.item.color = undefined;
    } else if (permission > 0) {
      this.item.text = `$(robot) Claude: ${permission} 承認待ち`;
      if (thinking + running > 0) this.item.text += ` / ${thinking + running} 処理中`;
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else if (thinking > 0 || running > 0) {
      const parts: string[] = [];
      if (thinking > 0) parts.push(`${thinking} 考え中`);
      if (running > 0) parts.push(`${running} 実行中`);
      this.item.text = `$(robot) Claude: ${parts.join(' / ')}`;
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
