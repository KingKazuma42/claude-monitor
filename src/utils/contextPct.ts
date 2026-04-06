/**
 * Context window usage calculation.
 * Extracted as a pure function to enable unit testing without VS Code API dependencies.
 */

/** Token limit for current Claude models (Sonnet / Opus / Haiku). Update when new model families ship. */
export const CONTEXT_WINDOW_LIMIT = 200_000;

/**
 * Scan JSONL lines from the end and return context window usage as a percentage (0-100, rounded).
 *
 * Rules:
 * - Only considers `type === 'assistant'` entries.
 * - Skips entries with `isSidechain === true` (subagent traffic).
 * - Sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens.
 * - Caps the result at 100 even if actual usage exceeds CONTEXT_WINDOW_LIMIT.
 * - Returns `undefined` when no qualifying entry with a `usage` object is found.
 */
export function extractContextPct(lines: string[], contextWindowLimit = CONTEXT_WINDOW_LIMIT): number | undefined {
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

    const total =
      (numOrZero(usage['input_tokens'])) +
      (numOrZero(usage['cache_creation_input_tokens'])) +
      (numOrZero(usage['cache_read_input_tokens'])) +
      (numOrZero(usage['output_tokens']));

    return Math.min(100, Math.round(total / contextWindowLimit * 100));
  }

  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
