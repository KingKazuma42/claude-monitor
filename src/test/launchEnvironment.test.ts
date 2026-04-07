import * as assert from 'assert';
import { parseLaunchEnvironment } from '../utils/launchEnvironment';

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

console.log('\nparseLaunchEnvironment()');

test('returns an empty object for blank input', () => {
  assert.deepStrictEqual(parseLaunchEnvironment('   '), {});
});

test('parses multiple unquoted assignments', () => {
  assert.deepStrictEqual(
    parseLaunchEnvironment('CLAUDE_CODE_NO_FLICKER=1 FOO=bar BAZ=qux'),
    {
      CLAUDE_CODE_NO_FLICKER: '1',
      FOO: 'bar',
      BAZ: 'qux',
    },
  );
});

test('parses quoted values with spaces', () => {
  assert.deepStrictEqual(
    parseLaunchEnvironment('LABEL="my value" NOTE=\'two words\''),
    {
      LABEL: 'my value',
      NOTE: 'two words',
    },
  );
});

test('allows empty values', () => {
  assert.deepStrictEqual(
    parseLaunchEnvironment('EMPTY= NEXT=value'),
    {
      EMPTY: '',
      NEXT: 'value',
    },
  );
});

test('supports escaped characters inside double quotes', () => {
  assert.deepStrictEqual(
    parseLaunchEnvironment('MULTI="line\\nvalue" TAB="a\\tb" QUOTE="say \\"hi\\""'),
    {
      MULTI: 'line\nvalue',
      TAB: 'a\tb',
      QUOTE: 'say "hi"',
    },
  );
});

test('throws on invalid variable names', () => {
  assert.throws(() => parseLaunchEnvironment('1BAD=value'), /無効な環境変数名/);
});

test('throws on missing equals', () => {
  assert.throws(() => parseLaunchEnvironment('FOO bar=baz'), /KEY=value/);
});

test('throws on unterminated quoted values', () => {
  assert.throws(() => parseLaunchEnvironment('FOO="bar'), /閉じられていません/);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}