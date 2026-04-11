import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUTO_COMPACT_WARNING_LIMIT,
  CONTEXT_WINDOW_LIMIT,
  ContextWindowUsage,
  createContextWindowUsage,
  resolveContextWindowLimit,
} from './contextPct';

export interface StatuslineSnapshot {
  session_id?: string;
  transcript_path?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
}

const STATUSLINE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export function getStatuslineSnapshotDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'claude-monitor', 'statusline');
}

export function getStatuslineSnapshotPath(sessionId: string, homeDir = os.homedir()): string {
  return path.join(getStatuslineSnapshotDir(homeDir), `${sessionId}.json`);
}

export function readStatuslineContextUsage(
  sessionId: string,
  fallbackModelId?: string,
  warningLimitTokens = AUTO_COMPACT_WARNING_LIMIT,
  homeDir = os.homedir(),
): ContextWindowUsage | undefined {
  const snapshotPath = getStatuslineSnapshotPath(sessionId, homeDir);

  try {
    const stats = fs.statSync(snapshotPath);
    if (Date.now() - stats.mtimeMs > STATUSLINE_SNAPSHOT_TTL_MS) {
      return undefined;
    }

    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    const parsed = JSON.parse(raw) as StatuslineSnapshot;
    return extractStatuslineContextUsage(parsed, fallbackModelId, warningLimitTokens);
  } catch {
    return undefined;
  }
}

export function extractStatuslineContextUsage(
  snapshot: StatuslineSnapshot,
  fallbackModelId?: string,
  warningLimitTokens = AUTO_COMPACT_WARNING_LIMIT,
): ContextWindowUsage | undefined {
  const contextWindow = snapshot.context_window;
  if (!isRecord(contextWindow)) {
    return undefined;
  }

  const modelId = typeof snapshot.model?.id === 'string'
    ? snapshot.model.id
    : fallbackModelId;
  const limitTokens = positiveNumber(contextWindow.context_window_size)
    ?? resolveContextWindowLimit(modelId, CONTEXT_WINDOW_LIMIT);

  const currentUsage = isRecord(contextWindow.current_usage)
    ? contextWindow.current_usage
    : undefined;

  if (currentUsage) {
    const usedTokens =
      (positiveNumber(currentUsage.input_tokens) ?? 0) +
      (positiveNumber(currentUsage.cache_creation_input_tokens) ?? 0) +
      (positiveNumber(currentUsage.cache_read_input_tokens) ?? 0);
    return createContextWindowUsage(usedTokens, limitTokens, 'statusline-hook', modelId, warningLimitTokens);
  }

  const totalInputTokens = positiveNumber(contextWindow.total_input_tokens);
  if (totalInputTokens !== undefined) {
    return createContextWindowUsage(totalInputTokens, limitTokens, 'statusline-hook', modelId, warningLimitTokens);
  }

  const usedPercentage = positiveNumber(contextWindow.used_percentage);
  if (usedPercentage !== undefined) {
    const usedTokens = Math.round((usedPercentage / 100) * limitTokens);
    return createContextWindowUsage(usedTokens, limitTokens, 'statusline-hook', modelId, warningLimitTokens);
  }

  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}