/**
 * Context window usage calculation.
 * Extracted as a pure function to enable unit testing without VS Code API dependencies.
 */

/** Token limit for current Claude models (Sonnet / Opus / Haiku). */
export const CONTEXT_WINDOW_LIMIT = 200_000;
export const EXTENDED_CONTEXT_WINDOW_LIMIT = 1_000_000;

export interface ContextWindowUsage {
  usedTokens: number;
  limitTokens: number;
  remainingTokens: number;
  pct: number;
  source: 'statusline-hook' | 'transcript';
  modelId?: string;
}

const KNOWN_MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-5-20251001': CONTEXT_WINDOW_LIMIT,
  'claude-sonnet-4-5-20251001': CONTEXT_WINDOW_LIMIT,
  'claude-haiku-4-5-20251001': CONTEXT_WINDOW_LIMIT,
};

export function resolveContextWindowLimit(
  modelId?: string,
  fallbackLimit = CONTEXT_WINDOW_LIMIT,
): number {
  const normalized = modelId?.trim().toLowerCase();
  if (!normalized) {
    return fallbackLimit;
  }

  const knownLimit = KNOWN_MODEL_CONTEXT_LIMITS[normalized];
  if (knownLimit) {
    return knownLimit;
  }

  if (normalized.includes('1m') || normalized.includes('extended')) {
    return EXTENDED_CONTEXT_WINDOW_LIMIT;
  }

  if (normalized.startsWith('claude-')) {
    return CONTEXT_WINDOW_LIMIT;
  }

  return fallbackLimit;
}

export function createContextWindowUsage(
  usedTokens: number,
  limitTokens: number,
  source: ContextWindowUsage['source'],
  modelId?: string,
): ContextWindowUsage {
  const normalizedLimit = limitTokens > 0 ? Math.round(limitTokens) : CONTEXT_WINDOW_LIMIT;
  const normalizedUsed = Math.max(0, Math.round(usedTokens));
  const pct = Math.min(100, Math.max(0, Math.round((normalizedUsed / normalizedLimit) * 100)));

  return {
    usedTokens: normalizedUsed,
    limitTokens: normalizedLimit,
    remainingTokens: Math.max(0, normalizedLimit - normalizedUsed),
    pct,
    source,
    modelId,
  };
}

/**
 * Scan JSONL lines from the end and return transcript-derived context usage.
 *
 * Rules:
 * - Only considers `type === 'assistant'` entries.
 * - Skips entries with `isSidechain === true` (subagent traffic).
 * - Uses input-only context accounting:
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
 * - Does NOT include output_tokens.
 * - Returns `undefined` when no qualifying entry with a `usage` object is found.
 */
export function extractTranscriptContextUsage(
  lines: string[],
  modelId?: string,
  contextWindowLimit = CONTEXT_WINDOW_LIMIT,
): ContextWindowUsage | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) { continue; }

    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!isRecord(obj)) { continue; }
    if (obj['isSidechain'] === true) { continue; }
    if (obj['type'] !== 'assistant') { continue; }

    const message = obj['message'];
    if (!isRecord(message)) { continue; }

    const usage = message['usage'];
    if (!isRecord(usage)) { continue; }

    const effectiveModelId = typeof message['model'] === 'string' ? message['model'] : modelId;
    const limitTokens = resolveContextWindowLimit(effectiveModelId, contextWindowLimit);
    const usedTokens =
      numOrZero(usage['input_tokens']) +
      numOrZero(usage['cache_creation_input_tokens']) +
      numOrZero(usage['cache_read_input_tokens']);

    return createContextWindowUsage(usedTokens, limitTokens, 'transcript', effectiveModelId);
  }

  return undefined;
}

export function extractContextPct(lines: string[], contextWindowLimit = CONTEXT_WINDOW_LIMIT): number | undefined {
  return extractTranscriptContextUsage(lines, undefined, contextWindowLimit)?.pct;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
