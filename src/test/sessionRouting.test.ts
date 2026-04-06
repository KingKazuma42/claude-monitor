import * as assert from 'assert';
import { findActivityOwnerPid } from '../utils/sessionRouting';
import { SessionStatus } from '../models/claudeSession';

interface SessionSlice {
  pid: number;
  claudeSessionId?: string;
  transcriptPath?: string;
  workDir: string;
  status: SessionStatus;
}

function session(overrides: Partial<SessionSlice> & Pick<SessionSlice, 'pid' | 'workDir'>): SessionSlice {
  return {
    status: 'idle',
    ...overrides,
  };
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

console.log('\nfindActivityOwnerPid()');

test('routes by Claude sessionId before any workDir fallback', () => {
  const sessions = [
    session({ pid: 100, claudeSessionId: 'session-a', workDir: '/repo' }),
    session({ pid: 200, claudeSessionId: 'session-b', workDir: '/repo' }),
  ];

  const result = findActivityOwnerPid(
    { filePath: '/tmp/session-b.jsonl', workDir: '/repo', sessionId: 'session-b' },
    sessions,
    new Map([['session-a', 100], ['session-b', 200]]),
    new Map(),
  );

  assert.strictEqual(result, 200);
});

test('routes by transcript path when it is already known', () => {
  const transcript = '/home/user/.claude/projects/-repo/session-a.jsonl';
  const sessions = [session({ pid: 100, workDir: '/repo', transcriptPath: transcript })];

  const result = findActivityOwnerPid(
    { filePath: transcript, workDir: '/repo' },
    sessions,
    new Map(),
    new Map([[transcript, 100]]),
  );

  assert.strictEqual(result, 100);
});

test('single unbound session in a workDir may use exact-workDir fallback', () => {
  const sessions = [session({ pid: 100, workDir: '/repo' })];

  const result = findActivityOwnerPid(
    { filePath: '/tmp/new.jsonl', workDir: '/repo' },
    sessions,
    new Map(),
    new Map(),
  );

  assert.strictEqual(result, 100);
});

test('multiple sessions in the same workDir do not guess without a sessionId', () => {
  const sessions = [
    session({ pid: 100, workDir: '/repo' }),
    session({ pid: 200, workDir: '/repo' }),
  ];

  const result = findActivityOwnerPid(
    { filePath: '/tmp/ambiguous.jsonl', workDir: '/repo' },
    sessions,
    new Map(),
    new Map(),
  );

  assert.strictEqual(result, undefined);
});

test('multiple sessions in same workDir do not steal activity when sessionId is unknown', () => {
  const sessions = [
    session({ pid: 100, claudeSessionId: 'session-a', workDir: '/repo' }),
    session({ pid: 200, claudeSessionId: 'session-b', workDir: '/repo' }),
  ];

  const result = findActivityOwnerPid(
    { filePath: '/tmp/unknown.jsonl', workDir: '/repo', sessionId: 'session-c' },
    sessions,
    new Map([['session-a', 100], ['session-b', 200]]),
    new Map(),
  );

  assert.strictEqual(result, undefined);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
