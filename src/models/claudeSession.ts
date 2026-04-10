import * as vscode from 'vscode';
import type { ConversationEntry } from '../monitors/fileWatcher';
import type { ContextWindowUsage } from '../utils/contextPct';

export type SessionStatus = 'thinking' | 'running' | 'permission' | 'waiting' | 'idle' | 'stopped';

export interface ClaudeSession {
  id: string;
  pid: number;
  terminalName: string;
  claudeSessionId?: string;
  transcriptPath?: string;
  workDir: string;
  status: SessionStatus;
  startedAt: Date;
  lastActivity: Date;
  outputLog: string[];
  conversation?: ConversationEntry[];
  cpuPercent?: number;
  memoryMB?: number;
  contextWindow?: ContextWindowUsage;
  contextPct?: number;
  terminal?: vscode.Terminal;
}

export function createSession(pid: number, workDir: string, terminal?: vscode.Terminal): ClaudeSession {
  const now = new Date();
  return {
    id: `claude-${pid}`,
    pid,
    terminalName: terminal?.name ?? `claude (${pid})`,
    workDir,
    status: 'idle',
    startedAt: now,
    lastActivity: now,
    outputLog: [],
    terminal,
  };
}

export function updateSessionStatus(session: ClaudeSession, status: SessionStatus): ClaudeSession {
  return { ...session, status, lastActivity: new Date() };
}
