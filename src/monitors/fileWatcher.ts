import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

export interface ClaudeFileActivity {
  workDir: string;
  filePath: string;
  entries: ConversationEntry[];
  updatedAt: Date;
}

export class FileWatcher extends EventEmitter {
  private watchers: vscode.FileSystemWatcher[] = [];

  start(): void {
    // Watch all .claude directories in workspace folders
    const pattern = new vscode.RelativePattern('/', '**/.claude/projects/**/*.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(uri => this.handleChange(uri));
    watcher.onDidCreate(uri => this.handleChange(uri));

    this.watchers.push(watcher);

    // Also watch home directory .claude
    const homeClaude = path.join(process.env['HOME'] ?? '/root', '.claude', 'projects');
    this.watchDirectory(homeClaude);
  }

  private watchDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;

    const pattern = new vscode.RelativePattern(dirPath, '**/*.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(uri => this.handleChange(uri));
    watcher.onDidCreate(uri => this.handleChange(uri));
    this.watchers.push(watcher);
  }

  private handleChange(uri: vscode.Uri): void {
    try {
      const entries = this.readJsonlFile(uri.fsPath);
      const workDir = this.inferWorkDir(uri.fsPath);

      const activity: ClaudeFileActivity = {
        workDir,
        filePath: uri.fsPath,
        entries,
        updatedAt: new Date(),
      };

      this.emit('activity', activity);
    } catch {
      // Ignore read errors (file may be locked during write)
    }
  }

  readJsonlFile(filePath: string): ConversationEntry[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries: ConversationEntry[] = [];

    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' || obj.role === 'user') {
          entries.push({
            role: 'user',
            content: this.extractText(obj.message ?? obj.content ?? obj),
            timestamp: obj.timestamp ? new Date(obj.timestamp) : undefined,
          });
        } else if (obj.type === 'assistant' || obj.role === 'assistant') {
          entries.push({
            role: 'assistant',
            content: this.extractText(obj.message ?? obj.content ?? obj),
            timestamp: obj.timestamp ? new Date(obj.timestamp) : undefined,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map(item => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'text' in item) return String(item.text);
          return '';
        })
        .join('');
    }
    if (value && typeof value === 'object' && 'text' in value) {
      return String((value as { text: unknown }).text);
    }
    return JSON.stringify(value);
  }

  private inferWorkDir(filePath: string): string {
    // ~/.claude/projects/<encoded-path>/...
    const homeDir = process.env['HOME'] ?? '/root';
    const projectsDir = path.join(homeDir, '.claude', 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);
    if (parts.length > 0) {
      // The directory name is the URL-encoded or path-encoded workspace path
      return parts[0].replace(/-/g, '/');
    }
    return '';
  }

  stop(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }
}
