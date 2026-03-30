import * as vscode from 'vscode';

export type SessionStatus = 'running' | 'idle' | 'stopped';

export interface ClaudeSession {
  id: string;
  pid: number;
  terminalName: string;
  workDir: string;
  status: SessionStatus;
  startedAt: Date;
  lastActivity: Date;
  outputLog: string[];
  cpuPercent?: number;
  memoryMB?: number;
  terminal?: vscode.Terminal;
}

export function createSession(pid: number, workDir: string, terminal?: vscode.Terminal): ClaudeSession {
  const now = new Date();
  return {
    id: `claude-${pid}`,
    pid,
    terminalName: terminal?.name ?? `claude (${pid})`,
    workDir,
    status: 'running',
    startedAt: now,
    lastActivity: now,
    outputLog: [],
    terminal,
  };
}

export function updateSessionStatus(session: ClaudeSession, status: SessionStatus): ClaudeSession {
  return { ...session, status, lastActivity: new Date() };
}

export function appendLog(session: ClaudeSession, line: string, maxLines: number): ClaudeSession {
  const outputLog = [...session.outputLog, line];
  if (outputLog.length > maxLines) {
    outputLog.splice(0, outputLog.length - maxLines);
  }
  return { ...session, outputLog, lastActivity: new Date() };
}
