import * as assert from 'assert';
import { getPermissionReplySequence } from '../utils/permissionInput';

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

console.log('\ngetPermissionReplySequence()');

test('maps yes to the first menu option', () => {
  assert.strictEqual(getPermissionReplySequence('yes'), '1\r');
});

test('maps no to the third menu option', () => {
  assert.strictEqual(getPermissionReplySequence('no'), '3\r');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}