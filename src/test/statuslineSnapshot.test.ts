import * as assert from 'assert';
import { extractStatuslineContextUsage } from '../utils/statuslineSnapshot';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
    failed++;
  }
}

console.log('\nextractStatuslineContextUsage()');

test('prefers current_usage and excludes output tokens', () => {
  const usage = extractStatuslineContextUsage({
    session_id: 'session-1',
    model: { id: 'claude-sonnet-4-5-20251001' },
    context_window: {
      total_input_tokens: 190_000,
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 80_000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 5_000,
        output_tokens: 20_000,
      },
    },
  });

  assert.deepStrictEqual(usage, {
    usedTokens: 95_000,
    limitTokens: 160_000,
    remainingTokens: 65_000,
    actualLimitTokens: 200_000,
    actualRemainingTokens: 105_000,
    pct: 59,
    source: 'statusline-hook',
    modelId: 'claude-sonnet-4-5-20251001',
  });
});

test('falls back to total_input_tokens when current_usage is absent', () => {
  const usage = extractStatuslineContextUsage({
    session_id: 'session-2',
    context_window: {
      total_input_tokens: 150_000,
      context_window_size: 200_000,
      used_percentage: 75,
    },
  });

  assert.deepStrictEqual(usage, {
    usedTokens: 150_000,
    limitTokens: 160_000,
    remainingTokens: 10_000,
    actualLimitTokens: 200_000,
    actualRemainingTokens: 50_000,
    pct: 94,
    source: 'statusline-hook',
    modelId: undefined,
  });
});

test('falls back to model-based context limit when size is absent', () => {
  const usage = extractStatuslineContextUsage({
    session_id: 'session-3',
    model: { id: 'claude-opus-4-5-20251001' },
    context_window: {
      total_input_tokens: 100_000,
    },
  });

  assert.ok(usage);
  assert.strictEqual(usage?.limitTokens, 160_000);
  assert.strictEqual(usage?.remainingTokens, 60_000);
  assert.strictEqual(usage?.actualLimitTokens, 200_000);
  assert.strictEqual(usage?.actualRemainingTokens, 100_000);
  assert.strictEqual(usage?.pct, 63);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}