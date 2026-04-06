import * as fs from 'fs';
import * as path from 'path';

export interface ClaudeRuntimeSessionMetadata {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  entrypoint?: string;
}

export function readRuntimeSessionMetadata(pid: number, homeDir = process.env['HOME'] ?? '/root'): ClaudeRuntimeSessionMetadata | undefined {
  const filePath = path.join(homeDir, '.claude', 'sessions', `${pid}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ClaudeRuntimeSessionMetadata>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.startedAt !== 'number'
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
      kind: parsed.kind,
      entrypoint: parsed.entrypoint,
    };
  } catch {
    return undefined;
  }
}

export function encodeClaudeProjectDir(workDir: string): string {
  if (!workDir.startsWith('/')) {
    return workDir.replace(/[/_]/g, '-');
  }
  return '-' + workDir.slice(1).replace(/[/_]/g, '-');
}

export function getTranscriptPathForSession(
  sessionId: string,
  workDir: string,
  homeDir = process.env['HOME'] ?? '/root',
): string {
  return path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(workDir), `${sessionId}.jsonl`);
}

export function isRuntimeSessionMetadataConsistent(
  metadata: ClaudeRuntimeSessionMetadata,
  workDir: string,
  startedAt: Date,
  toleranceMs = 15_000,
): boolean {
  if (workDir && path.resolve(metadata.cwd) !== path.resolve(workDir)) {
    return false;
  }

  return Math.abs(startedAt.getTime() - metadata.startedAt) <= toleranceMs;
}
