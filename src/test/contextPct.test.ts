/**
 * Unit tests for extractContextPct() and CONTEXT_WINDOW_LIMIT.
 *
 * Runner: Node.js built-in assert (no external test framework required).
 * Compile:  npm run compile
 * Execute:  node out/test/contextPct.test.js
 */

import * as assert from 'assert';
import { extractContextPct, CONTEXT_WINDOW_LIMIT } from '../utils/contextPct';

// ─── helpers ────────────────────────────────────────────────────────────────

function assistantLine(usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { usage },
    ...extra,
  });
}

function sidechainLine(usage: Record<string, number>): string {
  return assistantLine(usage, { isSidechain: true });
}

function userLine(content = 'hello'): string {
  return JSON.stringify({ type: 'user', message: { content } });
}

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

// ─── test suite ─────────────────────────────────────────────────────────────

console.log('\nextractContextPct()');

test('empty array returns undefined', () => {
  assert.strictEqual(extractContextPct([]), undefined);
});

test('array of empty strings returns undefined', () => {
  assert.strictEqual(extractContextPct(['', '  ', '\t']), undefined);
});

test('no assistant entries returns undefined', () => {
  const lines = [userLine(), userLine('world')];
  assert.strictEqual(extractContextPct(lines), undefined);
});

test('assistant entry missing usage returns undefined', () => {
  const line = JSON.stringify({ type: 'assistant', message: {} });
  assert.strictEqual(extractContextPct([line]), undefined);
});

test('assistant entry with null usage returns undefined', () => {
  const line = JSON.stringify({ type: 'assistant', message: { usage: null } });
  assert.strictEqual(extractContextPct([line]), undefined);
});

test('all token fields present — sums and rounds correctly', () => {
  // input=100_000, cache_create=40_000, cache_read=20_000, output=20_000 → 180_000/200_000 = 90%
  const line = assistantLine({
    input_tokens: 100_000,
    cache_creation_input_tokens: 40_000,
    cache_read_input_tokens: 20_000,
    output_tokens: 20_000,
  });
  assert.strictEqual(extractContextPct([line]), 90);
});

test('only input_tokens set — other fields treated as 0', () => {
  // 100_000/200_000 = 50%
  const line = assistantLine({ input_tokens: 100_000 });
  assert.strictEqual(extractContextPct([line]), 50);
});

test('all tokens zero returns 0', () => {
  const line = assistantLine({ input_tokens: 0, output_tokens: 0 });
  assert.strictEqual(extractContextPct([line]), 0);
});

test('total exactly equal to limit returns 100', () => {
  const line = assistantLine({ input_tokens: CONTEXT_WINDOW_LIMIT });
  assert.strictEqual(extractContextPct([line]), 100);
});

test('total exceeding limit is capped at 100', () => {
  const line = assistantLine({ input_tokens: CONTEXT_WINDOW_LIMIT + 50_000 });
  assert.strictEqual(extractContextPct([line]), 100);
});

test('fractional percentage is rounded (79.9995 → 80)', () => {
  // 159_999 / 200_000 * 100 = 79.9995 → rounds to 80
  const line = assistantLine({ input_tokens: 159_999 });
  assert.strictEqual(extractContextPct([line]), 80);
});

test('fractional percentage is rounded (79.4999 → 79)', () => {
  // 158_999 / 200_000 * 100 = 79.4995 → rounds to 79
  const line = assistantLine({ input_tokens: 158_999 });
  assert.strictEqual(extractContextPct([line]), 79);
});

test('sidechain-only assistant entries return undefined', () => {
  const lines = [
    sidechainLine({ input_tokens: 100_000 }),
    sidechainLine({ input_tokens: 80_000 }),
  ];
  assert.strictEqual(extractContextPct(lines), undefined);
});

test('sidechain entry is skipped; preceding main-session entry is used', () => {
  // main entry: 100_000 → 50%. sidechain entry: 180_000 → 90%.
  // The sidechain line comes LAST — must be ignored.
  const lines = [
    assistantLine({ input_tokens: 100_000 }),   // main (older)
    sidechainLine({ input_tokens: 180_000 }),   // sidechain (newer, must be skipped)
  ];
  assert.strictEqual(extractContextPct(lines), 50);
});

test('last (most recent) main-session entry wins over older ones', () => {
  // older: 50%, newer: 80% — newer is at the end of the file
  const lines = [
    assistantLine({ input_tokens: 100_000 }),  // 50%
    assistantLine({ input_tokens: 160_000 }),  // 80%
  ];
  assert.strictEqual(extractContextPct(lines), 80);
});

test('malformed JSON lines are skipped gracefully', () => {
  const lines = [
    'not json at all',
    '{broken:',
    assistantLine({ input_tokens: 50_000 }),  // 25%
  ];
  assert.strictEqual(extractContextPct(lines), 25);
});

test('blank lines interspersed do not cause errors', () => {
  const lines = [
    '',
    assistantLine({ input_tokens: 50_000 }),
    '',
    '',
  ];
  assert.strictEqual(extractContextPct(lines), 25);
});

test('non-assistant types (user, system, progress) are skipped', () => {
  const lines = [
    userLine('question'),
    JSON.stringify({ type: 'system', message: { content: 'compact done' } }),
    JSON.stringify({ type: 'progress', message: {} }),
    assistantLine({ input_tokens: 40_000 }),  // 20%
  ];
  assert.strictEqual(extractContextPct(lines), 20);
});

test('assistant entry without message field is skipped; falls back to earlier entry', () => {
  // withoutMessage has no `message` field → no usage → skipped.
  // extractContextPct scans backwards for the last entry WITH usage data.
  const withoutMessage = JSON.stringify({ type: 'assistant', something: 'else' });
  const withMessage = assistantLine({ input_tokens: 60_000 });  // 30%

  // withMessage is the last entry → found immediately
  assert.strictEqual(extractContextPct([withoutMessage, withMessage]), 30);

  // withoutMessage is the last entry → skipped; falls back to withMessage (older)
  assert.strictEqual(extractContextPct([withMessage, withoutMessage]), 30);
});

// ─── color-threshold boundary values ────────────────────────────────────────
//
// These tests validate the numeric thresholds that drive CSS class selection
// in buildContextBarHtml() (main.js).  The JS function itself is not tested
// here (requires DOM), but verifying the raw percentage values produced by
// extractContextPct ensures the right numbers flow into the webview.

console.log('\nColor threshold boundary values (pct that extractContextPct produces)');

test('79% → below warning threshold', () => {
  // 158_000 / 200_000 * 100 = 79 → ctx-normal
  const line = assistantLine({ input_tokens: 158_000 });
  const pct = extractContextPct([line]);
  assert.strictEqual(pct, 79);
  assert.ok(pct! < 80, `Expected pct < 80, got ${pct}`);
});

test('80% → warning threshold', () => {
  // 160_000 / 200_000 * 100 = 80 → ctx-warning
  const line = assistantLine({ input_tokens: 160_000 });
  const pct = extractContextPct([line]);
  assert.strictEqual(pct, 80);
  assert.ok(pct! >= 80 && pct! < 90, `Expected 80 <= pct < 90, got ${pct}`);
});

test('89% → still warning (not danger)', () => {
  // 178_000 / 200_000 * 100 = 89 → ctx-warning
  const line = assistantLine({ input_tokens: 178_000 });
  const pct = extractContextPct([line]);
  assert.strictEqual(pct, 89);
  assert.ok(pct! >= 80 && pct! < 90, `Expected 80 <= pct < 90, got ${pct}`);
});

test('90% → danger threshold', () => {
  // 180_000 / 200_000 * 100 = 90 → ctx-danger
  const line = assistantLine({ input_tokens: 180_000 });
  const pct = extractContextPct([line]);
  assert.strictEqual(pct, 90);
  assert.ok(pct! >= 90, `Expected pct >= 90, got ${pct}`);
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
