import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

/** Pattern matching system-injected context tags that should be excluded from conversation display. */
const SYSTEM_TAG_PATTERN = /^<(ide_|system_reminder|antml_thinking|context_window)[a-z_]*/;

/** Pattern matching !command output injected into the conversation by Claude Code CLI. */
const LOCAL_COMMAND_OUTPUT_PATTERN = /^<(bash-input|bash-stdout|bash-stderr|local-command-caveat)>/;

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

export interface ClaudeFileActivity {
  workDir: string;
  filePath: string;
  entries: ConversationEntry[];
  /** Derived status from last meaningful JSONL entry. */
  derivedStatus: 'thinking' | 'permission' | 'waiting' | null;
  updatedAt: Date;
}

export class FileWatcher extends EventEmitter {
  private watchers: vscode.FileSystemWatcher[] = [];
  private workDirCache = new Map<string, string>();
  private workDirReverseMap = new Map<string, string>();  // encoded -> realPath

  /**
   * Register a known workDir to build reverse mapping for path decoding.
   * Finds the encoded directory name that corresponds to this workDir.
   */
  registerWorkDir(workDir: string): void {
    const homeDir = process.env['HOME'] ?? '/root';
    const projectsDir = path.join(homeDir, '.claude', 'projects');

    // Simple encoding attempt: replace / and _ with -
    const encoded = '-' + workDir.slice(1).replace(/[/_]/g, '-');

    // Check if this encoded dir exists
    try {
      const encodedPath = path.join(projectsDir, encoded);
      if (fs.existsSync(encodedPath)) {
        this.workDirReverseMap.set(encoded, workDir);
        return;
      }
    } catch {
      // Ignore
    }

    // Fallback: scan all directories and find best match
    try {
      const dirs = fs.readdirSync(projectsDir);
      for (const dir of dirs) {
        // Try basic decoding
        const decoded = dir.startsWith('-')
          ? '/' + dir.slice(1).replace(/-/g, '/')
          : dir;

        if (decoded === workDir) {
          this.workDirReverseMap.set(dir, workDir);
          return;
        }
      }
    } catch {
      // Ignore errors
    }
  }

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
      const lines = fs.readFileSync(uri.fsPath, 'utf-8').trim().split('\n');
      const cwd = this.extractCwdFromLines(lines);
      const entries = this.parseJsonlLines(lines);
      const workDir = cwd || this.inferWorkDir(uri.fsPath);

      const activity: ClaudeFileActivity = {
        workDir,
        filePath: uri.fsPath,
        entries,
        derivedStatus: this.deriveStatus(lines),
        updatedAt: new Date(),
      };

      this.emit('activity', activity);
    } catch {
      // Ignore read errors (file may be locked during write)
    }
  }

  /**
   * Derive Claude's current status by scanning JSONL lines from the end,
   * skipping non-meaningful entries (meta, sidechain, file snapshots, queue ops).
   *
   * Status semantics:
   *   thinking   - Claude is generating a text response
   *   running    - A tool/command is actively executing (progress entries present)
   *   permission - Claude called a tool but is waiting for user approval
   *   waiting    - Claude finished responding (end_turn), waiting for next message
   */
  private deriveStatus(lines: string[]): 'thinking' | 'permission' | 'waiting' | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      // Skip entries that don't reflect main session state
      if (obj.type === 'file-history-snapshot') continue;
      if (obj.type === 'queue-operation') continue;
      if (obj.isMeta === true) continue;       // !command caveat messages
      if (obj.isSidechain === true) continue;  // subagent messages

      // Skip !command output injected into the conversation
      // e.g. <bash-input>ls</bash-input>, <bash-stdout>...</bash-stdout>
      if (obj.type === 'user') {
        const content = obj.message?.content;
        if (typeof content === 'string' && LOCAL_COMMAND_OUTPUT_PATTERN.test(content.trimStart())) {
          continue;
        }
      }

      if (obj.type === 'assistant') {
        const stopReason = obj.message?.stop_reason;
        if (stopReason === 'tool_use') {
          // Tool was called — if the VERY next meaningful entry is also assistant or nothing,
          // we're still waiting for permission. If progress follows, tool is running.
          // Since we scan from end, reaching tool_use as the last means no progress yet.
          return 'permission';
        }
        return 'waiting';  // end_turn or other stop reasons
      }

      if (obj.type === 'user') {
        const content = obj.message?.content;
        if (Array.isArray(content) && content.some((c: any) => c.type === 'tool_result')) {
          return 'thinking';  // tool result returned, Claude will resume
        }
        return 'thinking';  // regular user message
      }

      if (obj.type === 'progress') return 'permission';  // hook executing (treat same as permission)
      if (obj.type === 'system') return 'waiting';    // e.g. compaction complete
    }

    return null;
  }

  /** Extract the cwd field from JSONL lines (first entry that has it). */
  private extractCwdFromLines(lines: string[]): string {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd && typeof obj.cwd === 'string') {
          return obj.cwd;
        }
      } catch { /* skip */ }
    }
    return '';
  }

  readJsonlFile(filePath: string): ConversationEntry[] {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    return this.parseJsonlLines(lines);
  }

  private parseJsonlLines(lines: string[]): ConversationEntry[] {
    const entries: ConversationEntry[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const msgContent = obj.message?.content ?? obj.content;
        const role = this.getMessageRole(obj);
        if (role === 'user') {
          const text = this.extractText(msgContent, /* skipTools */ false, /* skipIdeContext */ true);
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

  private extractText(value: unknown, skipTools = false, skipIdeContext = false): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value
        .filter(item => {
          if (!item || typeof item !== 'object') return true;
          // Skip tool_use / tool_result blocks in assistant messages
          if (skipTools && 'type' in item &&
              (item.type === 'tool_use' || item.type === 'tool_result')) {
            return false;
          }
          // Skip IDE-injected context blocks in user messages
          if (skipIdeContext && 'text' in item) {
            const text = String(item.text).trimStart();
            if (SYSTEM_TAG_PATTERN.test(text)) return false;
          }
          return true;
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

    const encoded = parts[0];

    // Check reverse map first (most accurate)
    if (this.workDirReverseMap.has(encoded)) {
      return this.workDirReverseMap.get(encoded)!;
    }

    // Check cache
    if (this.workDirCache.has(encoded)) {
      return this.workDirCache.get(encoded)!;
    }

    // Claude Code encodes paths by replacing '/' with '-' and '_' with '-'
    // e.g., /home/ec2-user/repos/foo_bar -> -home-ec2-user-repos-foo-bar
    // This makes perfect decoding impossible, so we use filesystem checks
    if (!encoded.startsWith('-')) {
      return encoded;
    }

    // Remove leading '-' and split by '-'
    const segments = encoded.slice(1).split('-');

    // Greedily reconstruct the path by checking filesystem
    let resolved = '';
    let i = 0;

    while (i < segments.length) {
      const nextSegment = segments[i];
      const candidate = resolved ? path.join(resolved, nextSegment) : '/' + nextSegment;

      if (fs.existsSync(candidate)) {
        resolved = candidate;
        i++;
        continue;
      }

      // Try with underscore (since '_' is encoded as '-')
      const candidateUnderscore = resolved ? path.join(resolved, nextSegment.replace(/-/g, '_')) : '/' + nextSegment.replace(/-/g, '_');
      if (fs.existsSync(candidateUnderscore)) {
        resolved = candidateUnderscore;
        i++;
        continue;
      }

      // Try combining with next segment (handles multi-word dirs)
      if (i + 1 < segments.length) {
        const combinedSegment = nextSegment + '-' + segments[i + 1];
        const candidateWithNext = resolved ? path.join(resolved, combinedSegment) : '/' + combinedSegment;
        if (fs.existsSync(candidateWithNext)) {
          resolved = candidateWithNext;
          i += 2;
          continue;
        }

        // Try with underscore
        const combinedWithUnderscore = nextSegment + '_' + segments[i + 1];
        const candidateWithUnderscoreNext = resolved ? path.join(resolved, combinedWithUnderscore) : '/' + combinedWithUnderscore;
        if (fs.existsSync(candidateWithUnderscoreNext)) {
          resolved = candidateWithUnderscoreNext;
          i += 2;
          continue;
        }
      }

      // No match found, append remaining as-is
      const remaining = segments.slice(i).join('-');
      resolved = resolved ? path.join(resolved, remaining) : '/' + remaining;
      break;
    }

    this.workDirCache.set(encoded, resolved);
    return resolved;
  }

  stop(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }
}
