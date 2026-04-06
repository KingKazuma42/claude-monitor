import * as assert from 'assert';
import {
  encodeClaudeProjectDir,
  getTranscriptPathForSession,
  isRuntimeSessionMetadataConsistent,
} from '../utils/runtimeSessionMetadata';

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

console.log('\nruntimeSessionMetadata()');

test('encodes absolute workDir using Claude project convention', () => {
  assert.strictEqual(
    encodeClaudeProjectDir('/home/exe315/repos/claude-monitor'),
    '-home-exe315-repos-claude-monitor',
  );
});

test('transcript path uses encoded workDir plus sessionId filename', () => {
  assert.strictEqual(
    getTranscriptPathForSession('abc-123', '/home/exe315/repos', '/tmp/home'),
    '/tmp/home/.claude/projects/-home-exe315-repos/abc-123.jsonl',
  );
});

test('runtime metadata is accepted when cwd and startedAt align with the process', () => {
  assert.strictEqual(
    isRuntimeSessionMetadataConsistent(
      {
        pid: 100,
        sessionId: 'session-a',
        cwd: '/home/exe315/repos',
        startedAt: 1_700_000_000_000,
      },
      '/home/exe315/repos',
      new Date(1_700_000_000_500),
    ),
    true,
  );
});

test('runtime metadata is rejected when process start time differs too much', () => {
  assert.strictEqual(
    isRuntimeSessionMetadataConsistent(
      {
        pid: 100,
        sessionId: 'session-a',
        cwd: '/home/exe315/repos',
        startedAt: 1_700_000_000_000,
      },
      '/home/exe315/repos',
      new Date(1_700_000_030_000),
    ),
    false,
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
