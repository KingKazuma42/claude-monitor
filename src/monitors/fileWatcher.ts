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
  /** Role of the last entry: user → Claude is thinking, assistant → waiting for input */
  lastEntryRole: 'user' | 'assistant' | null;
  updatedAt: Date;
}

export class FileWatcher extends EventEmitter {
  private watchers: vscode.FileSystemWatcher[] = [];

  start(): void {
    // Watch all .claude/projects directories in workspace folders
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder.uri.fsPath, '**/.claude/projects/**/*.jsonl');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidChange(uri => this.handleChange(uri));
      watcher.onDidCreate(uri => this.handleChange(uri));

      this.watchers.push(watcher);
    }

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

      const lastEntry = entries[entries.length - 1] ?? null;
      const activity: ClaudeFileActivity = {
        workDir,
        filePath: uri.fsPath,
        entries,
        lastEntryRole: lastEntry?.role ?? null,
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
        const msgContent = obj.message?.content ?? obj.content;
        const role = this.getMessageRole(obj);
        if (role === 'user') {
          const text = this.extractText(msgContent);
          if (text) entries.push({
            role: 'user',
            content: text,
            timestamp: obj.timestamp ? new Date(obj.timestamp) : undefined,
          });
        } else if (role === 'assistant') {
          const text = this.extractText(msgContent, /* skipTools */ true);
          if (text) entries.push({
            role: 'assistant',
            content: text,
            timestamp: obj.timestamp ? new Date(obj.timestamp) : undefined,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  private getMessageRole(obj: any): 'user' | 'assistant' | null {
    if (!obj || typeof obj !== 'object') return null;
    const explicitRole = obj.message?.role;
    if (explicitRole === 'user' || explicitRole === 'assistant') {
      return explicitRole;
    }

    const role = obj.role ?? obj.type;
    if (role === 'user' || role === 'assistant') {
      return role;
    }

    return null;
  }

  private extractText(value: unknown, skipTools = false): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value
        .filter(item => {
          if (!skipTools) return true;
          // Skip tool_use / tool_result blocks in assistant messages
          return !(item && typeof item === 'object' && 'type' in item &&
            (item.type === 'tool_use' || item.type === 'tool_result'));
        })
        .map(item => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'text' in item) return String(item.text);
          return '';
        })
        .filter(s => s.trim())
        .join('\n')
        .trim();
    }
    if (value && typeof value === 'object' && 'text' in value) {
      return String((value as { text: unknown }).text).trim();
    }
    return '';
  }

  private inferWorkDir(filePath: string): string {
    const homeDir = process.env['HOME'] ?? '/root';
    const projectsDir = path.join(homeDir, '.claude', 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length === 0) return '';

    let encoded = parts[0];
    try {
      encoded = decodeURIComponent(encoded);
    } catch {
      // Ignore invalid encoding
    }

    if (encoded.startsWith('/')) {
      return encoded;
    }
    if (encoded.startsWith(homeDir)) {
      return encoded;
    }
    if (encoded.includes('home/')) {
      return path.join('/', encoded);
    }
    if (encoded.includes('-')) {
      return '/' + encoded.replace(/-/g, '/');
    }

    return encoded;
  }

  stop(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }
}
