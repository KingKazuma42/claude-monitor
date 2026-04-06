import * as assert from 'assert';
import { buildClaudeCliArgs } from '../utils/claudeCliArgs';

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

console.log('\nbuildClaudeCliArgs()');

test('returns an empty array when no options are provided', () => {
  assert.deepStrictEqual(buildClaudeCliArgs({}), []);
});

test('builds separate argv entries for model, agent, and name', () => {
  assert.deepStrictEqual(
    buildClaudeCliArgs({
      model: 'claude-sonnet-4-5-20251001',
      agent: 'reviewer',
      sessionName: 'backend',
    }),
    ['--model', 'claude-sonnet-4-5-20251001', '--agent', 'reviewer', '--name', 'backend'],
  );
});

test('preserves shell metacharacters as literal argv content', () => {
  assert.deepStrictEqual(
    buildClaudeCliArgs({
      model: 'claude-$(whoami)',
      agent: 'review;rm -rf /',
      sessionName: 'foo`uname`$HOME',
    }),
    ['--model', 'claude-$(whoami)', '--agent', 'review;rm -rf /', '--name', 'foo`uname`$HOME'],
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}