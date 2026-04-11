/**
 * Unit tests for compact-related behaviour in claude-monitor.
 *
 * Covers two observable phenomena a user triggers via the /compact button:
 *
 *   1. Context % INCREASES across turns (extractContextPct reads last assistant entry).
 *   2. After /compact, the NEW JSONL file has a far LOWER %, and the old JSONL
 *      file's last meaningful entry is the "system" compact-complete marker.
 *
 * Also validates deriveStatus() around the compact lifecycle:
 *   - Before compact  : 'waiting' (assistant end_turn)
 *   - During compact  : 'permission' (tool_use) then 'running' (progress) then 'thinking' (tool_result)
 *   - Compact done    : 'waiting' (system entry)
 *   - New file opened : 'waiting' (first assistant entry in fresh file)
 *
 * extractContextPct is imported directly.
 * deriveStatus is private on FileWatcher, so it is re-implemented here as a
 * pure function.  Keep in sync with FileWatcher.deriveStatus() in
 * src/monitors/fileWatcher.ts.
 *
 * Runner: node out/test/compact.test.js
 */

import * as assert from 'assert';
import { extractContextPct, AUTO_COMPACT_WARNING_LIMIT } from '../utils/contextPct';

// ─── inline copy of deriveStatus ────────────────────────────────────────────
// Keep in sync with FileWatcher.deriveStatus() in src/monitors/fileWatcher.ts.

const LOCAL_COMMAND_OUTPUT_PATTERN = /^<(bash-input|bash-stdout|bash-stderr|local-command-caveat)>/;

function deriveStatus(lines: string[]): 'thinking' | 'running' | 'permission' | 'waiting' | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) { continue; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'file-history-snapshot') { continue; }
    if (obj.type === 'queue-operation') { continue; }
    if (obj.isMeta === true) { continue; }
    if (obj.isSidechain === true) { continue; }

    if (obj.type === 'user') {
      const content = obj.message?.content;
      if (typeof content === 'string' && LOCAL_COMMAND_OUTPUT_PATTERN.test(content.trimStart())) {
        continue;
      }
    }

    if (obj.type === 'assistant') {
      const stopReason = obj.message?.stop_reason;
      if (stopReason === 'tool_use') { return 'permission'; }
      return 'waiting';
    }

    if (obj.type === 'user') {
      const content = obj.message?.content;
      if (Array.isArray(content) && content.some((c: { type: string }) => c.type === 'tool_result')) {
        return 'thinking';
      }
      return 'thinking';
    }

    if (obj.type === 'progress') { return 'running'; }
    if (obj.type === 'system')   { return 'waiting'; }   // e.g. compaction complete
  }
  return null;
}

// ─── JSONL line builders ─────────────────────────────────────────────────────

function assistantLine(
  inputTokens: number,
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens },
    },
    ...extra,
  });
}

function userLine(content: unknown = 'hello'): string {
  return JSON.stringify({ type: 'user', message: { content } });
}

function systemLine(content = 'compact complete'): string {
  return JSON.stringify({ type: 'system', message: { content } });
}

function progressLine(): string {
  return JSON.stringify({ type: 'progress', message: {} });
}

function toolResultUserLine(): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'done' }] },
  });
}

// ─── test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

// ─── 1. Context % progression across turns ───────────────────────────────────
//
// As the conversation grows the last assistant entry has more tokens,
// so extractContextPct returns an increasing value on each successive read.

console.log('\nextractContextPct – % progression across turns');

test('before any message: undefined', () => {
  assert.strictEqual(extractContextPct([]), undefined);
});

test('turn 1: 13% (20 000 tokens)', () => {
  const lines = [
    userLine('first question'),
    assistantLine(20_000),
  ];
  assert.strictEqual(extractContextPct(lines), 13);
});

test('turn 2: 38% (newer entry replaces older)', () => {
  const lines = [
    userLine('first question'),
    assistantLine(20_000),  // turn 1 — 13 %
    userLine('follow-up'),
    assistantLine(60_000),  // turn 2 — 38 %
  ];
  assert.strictEqual(extractContextPct(lines), 38);
});

test('turn 3: 75%', () => {
  const lines = [
    assistantLine(20_000),   // 13 %
    assistantLine(60_000),   // 38 %
    assistantLine(120_000),  // 75 %
  ];
  assert.strictEqual(extractContextPct(lines), 75);
});

test('turn 4: 100% — compact warning threshold reached', () => {
  const lines = [
    assistantLine(20_000),
    assistantLine(60_000),
    assistantLine(120_000),
    assistantLine(170_000),  // capped at 100 %
  ];
  assert.strictEqual(extractContextPct(lines), 100);
});

test('% never exceeds 100 even if tokens overshoot limit', () => {
  const lines = [
    assistantLine(170_000),                           // already capped at 100 %
    assistantLine(AUTO_COMPACT_WARNING_LIMIT + 10_000),  // would exceed 100 % → capped at 100
  ];
  assert.strictEqual(extractContextPct(lines), 100);
});

// ─── 2. extractContextPct after compact ──────────────────────────────────────
//
// When /compact runs Claude Code:
//   (a) appends a system entry to the OLD JSONL (compact-complete marker), and
//   (b) creates a NEW JSONL file with a fresh, lower-token context.
//
// extractContextPct must:
//   - Return the last ASSISTANT-entry % from the old file (system entry is ignored).
//   - Return the new low % from the new file.

console.log('\nextractContextPct – post-compact behaviour');

test('old JSONL: system entry at end is ignored; last assistant % is preserved', () => {
  // Old file just before compact was already at the warning ceiling.
  // The system "compact complete" line is appended but must NOT change the reported %.
  const oldJSONLLines = [
    assistantLine(170_000),  // 100 % — last assistant entry
    systemLine('compact complete'),
  ];
  assert.strictEqual(extractContextPct(oldJSONLLines), 100);
});

test('new JSONL: starts at a low % after compact', () => {
  // The new file begins with the compacted summary; token count is much lower.
  const newJSONLLines = [
    userLine('compact summary injected by Claude Code'),
    assistantLine(24_000),  // 15 % — compacted context
  ];
  assert.strictEqual(extractContextPct(newJSONLLines), 15);
});

test('new JSONL with system-only entries (no assistant yet): returns undefined', () => {
  // Edge case: compact wrote a system entry but no assistant entry has been
  // written yet (e.g. file read race just after creation).
  const newJSONLLines = [systemLine('context compacted')];
  assert.strictEqual(extractContextPct(newJSONLLines), undefined);
});

test('% drop is visible when comparing old vs new file', () => {
  const oldLines = [assistantLine(170_000), systemLine()];  // 100 %
  const newLines = [assistantLine(24_000)];                 // 15 %

  const pctBefore = extractContextPct(oldLines);
  const pctAfter  = extractContextPct(newLines);

  assert.strictEqual(pctBefore, 100);
  assert.strictEqual(pctAfter,  15);
  assert.ok(pctAfter! < pctBefore!, `Expected pctAfter (${pctAfter}) < pctBefore (${pctBefore})`);
});

// ─── 3. deriveStatus around compact lifecycle ────────────────────────────────
//
// The sequence of JSONL entries around a /compact call:
//   1. [pre-compact]  assistant end_turn           → 'waiting'
//   2. [compact call] assistant tool_use           → 'permission'
//   3. [tool running] progress                     → 'running'
//   4. [tool result]  user tool_result             → 'thinking'
//   5. [compact done] system "compact complete"    → 'waiting'
//   6. [new file]     assistant end_turn (new file)→ 'waiting'

console.log('\nderiveStatus – compact lifecycle');

test('pre-compact: assistant end_turn → waiting', () => {
  const lines = [
    userLine('please compact'),
    assistantLine(170_000, 'end_turn'),
  ];
  assert.strictEqual(deriveStatus(lines), 'waiting');
});

test('compact triggered: assistant tool_use → permission', () => {
  const lines = [
    assistantLine(170_000, 'end_turn'),
    userLine('ok'),
    assistantLine(170_000, 'tool_use'),  // Claude calls compact tool
  ];
  assert.strictEqual(deriveStatus(lines), 'permission');
});

test('compact running: progress entry → running', () => {
  const lines = [
    assistantLine(170_000, 'tool_use'),
    progressLine(),
  ];
  assert.strictEqual(deriveStatus(lines), 'running');
});

test('compact tool result returned: user tool_result → thinking', () => {
  const lines = [
    assistantLine(170_000, 'tool_use'),
    progressLine(),
    toolResultUserLine(),  // Claude Code injected tool result
  ];
  assert.strictEqual(deriveStatus(lines), 'thinking');
});

test('compact done: system entry → waiting', () => {
  // The system entry is the last meaningful line in the old JSONL after compact.
  const lines = [
    assistantLine(170_000, 'end_turn'),
    systemLine('compact complete'),
  ];
  assert.strictEqual(deriveStatus(lines), 'waiting');
});

test('new file after compact: fresh assistant entry → waiting', () => {
  // New JSONL file opened with compacted context.
  const lines = [
    userLine('compact summary'),
    assistantLine(24_000, 'end_turn'),
  ];
  assert.strictEqual(deriveStatus(lines), 'waiting');
});

test('system entry does not mask earlier assistant entry when reading backwards', () => {
  // Confirms the scan-from-end logic: system is the last → returns 'waiting',
  // NOT the assistant tool_use that precedes it.
  const lines = [
    assistantLine(170_000, 'tool_use'),  // older
    systemLine('compact complete'),       // newer — must win
  ];
  assert.strictEqual(deriveStatus(lines), 'waiting');
});

// ─── 4. Integration scenario: full /compact round-trip ───────────────────────
//
// Simulates reading activity from both old and new JSONL files as the monitor
// would see them, and asserts the combined observable state.

console.log('\nFull compact round-trip scenario');

test('OLD file during compact: high % + waiting status', () => {
  const oldLines = [
    userLine('last user message before compact'),
    assistantLine(170_000, 'end_turn'),
    systemLine('compact complete'),
  ];
  assert.strictEqual(extractContextPct(oldLines), 100,       'old file: % unchanged');
  assert.strictEqual(deriveStatus(oldLines),      'waiting', 'old file: status = waiting');
});

test('NEW file after compact: low % + waiting status', () => {
  const newLines = [
    userLine('compacted context summary'),
    assistantLine(24_000, 'end_turn'),
  ];
  assert.strictEqual(extractContextPct(newLines), 15,        'new file: low %');
  assert.strictEqual(deriveStatus(newLines),      'waiting', 'new file: status = waiting');
});

test('NEW file: % continues to rise again in subsequent turns', () => {
  const newLines = [
    assistantLine(24_000),   // 15 % immediately post-compact
    assistantLine(50_000),   // 31 % after first new turn
    assistantLine(80_000),   // 50 % — rising again
  ];
  const pcts = [
    extractContextPct([newLines[0]]),
    extractContextPct([newLines[0], newLines[1]]),
    extractContextPct(newLines),
  ];
  assert.strictEqual(pcts[0], 15);
  assert.strictEqual(pcts[1], 31);
  assert.strictEqual(pcts[2], 50);
  assert.ok(pcts[0]! < pcts[1]! && pcts[1]! < pcts[2]!, '% rises monotonically after compact');
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
