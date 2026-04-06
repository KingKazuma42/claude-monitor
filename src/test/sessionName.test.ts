/**
 * Unit tests for the --name / -n parsing logic used in ProcessMonitor.getSessionName()
 * and for the downstream disambiguateNames() interaction.
 *
 * getSessionName() is private in ProcessMonitor, so the parsing algorithm is
 * re-implemented here as a pure function.  Keep in sync with the private method.
 *
 * Runner: node out/test/sessionName.test.js
 */

import * as assert from 'assert';

// ─── inline copy of the parsing algorithm ───────────────────────────────────
// Keep in sync with ProcessMonitor.getSessionName() in processMonitor.ts.

function parseSessionName(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--name' || arg === '-n') && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith('--name=')) {
      return arg.slice('--name='.length);
    }
  }
  return undefined;
}

// ─── inline copy of disambiguateNames() ─────────────────────────────────────
// Keep in sync with disambiguateNames() in extension.ts.

interface MinSession {
  id: string;
  pid: number;
  terminalName: string;
}

function disambiguateNames<T extends MinSession>(sessions: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const s of sessions) {
    const list = groups.get(s.terminalName) ?? [];
    list.push(s);
    groups.set(s.terminalName, list);
  }

  return sessions.map(s => {
    const group = groups.get(s.terminalName)!;
    if (group.length <= 1) { return s; }
    const sorted = [...group].sort((a, b) => a.pid - b.pid);
    const rank = sorted.indexOf(s) + 1;
    return { ...s, terminalName: `${s.terminalName} #${rank}` };
  });
}

function makeSession(pid: number, name: string): MinSession {
  return { id: `claude-${pid}`, pid, terminalName: name };
}

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── parseSessionName tests ──────────────────────────────────────────────────

console.log('\nparseSessionName()');

test('returns undefined when no --name or -n present', () => {
  assert.strictEqual(parseSessionName(['claude', '--model', 'sonnet']), undefined);
});

test('returns undefined for empty args', () => {
  assert.strictEqual(parseSessionName([]), undefined);
});

test('parses --name <value> (separate arg)', () => {
  assert.strictEqual(parseSessionName(['claude', '--name', 'backend']), 'backend');
});

test('parses -n <value> (short form)', () => {
  assert.strictEqual(parseSessionName(['claude', '-n', 'frontend']), 'frontend');
});

test('parses --name=<value> (equals form)', () => {
  assert.strictEqual(parseSessionName(['claude', '--name=my session']), 'my session');
});

test('parses --name with spaces in value (shell split form)', () => {
  // Shell already splits the value: ["claude", "--name", "my session"]
  assert.strictEqual(parseSessionName(['claude', '--name', 'my session']), 'my session');
});

test('--name after other flags is still found', () => {
  assert.strictEqual(
    parseSessionName(['claude', '--model', 'opus', '--name', 'review']),
    'review'
  );
});

test('-n after other flags is still found', () => {
  assert.strictEqual(
    parseSessionName(['claude', '--agent', 'planner', '-n', 'proj-a']),
    'proj-a'
  );
});

test('--name at end of args without value returns undefined', () => {
  assert.strictEqual(parseSessionName(['claude', '--name']), undefined);
});

test('-n at end of args without value returns undefined', () => {
  assert.strictEqual(parseSessionName(['claude', '-n']), undefined);
});

test('--name= with empty string returns empty string', () => {
  assert.strictEqual(parseSessionName(['claude', '--name=']), '');
});

test('--name before -n returns first match (--name)', () => {
  assert.strictEqual(
    parseSessionName(['claude', '--name', 'first', '-n', 'second']),
    'first'
  );
});

// ─── disambiguateNames + named sessions ─────────────────────────────────────

console.log('\ndisambiguateNames() with user-named sessions');

test('two sessions with unique --name values need no suffix', () => {
  const sessions = [
    makeSession(100, 'backend'),
    makeSession(200, 'frontend'),
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(100), 'backend');
  assert.strictEqual(byPid.get(200), 'frontend');
});

test('two sessions with same --name still get #1/#2 disambiguation', () => {
  const sessions = [
    makeSession(100, 'backend'),
    makeSession(200, 'backend'),
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(100), 'backend #1');
  assert.strictEqual(byPid.get(200), 'backend #2');
});

test('mix of named and unnamed sessions disambiguates each group independently', () => {
  const sessions = [
    makeSession(100, 'backend'),
    makeSession(200, 'claude'),
    makeSession(300, 'claude'),
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(100), 'backend');      // unique name → no suffix
  assert.strictEqual(byPid.get(200), 'claude #1');
  assert.strictEqual(byPid.get(300), 'claude #2');
});

test('all three sessions with distinct --name values have no suffix', () => {
  const sessions = [
    makeSession(100, 'review'),
    makeSession(200, 'plan'),
    makeSession(300, 'implement'),
  ];
  const result = disambiguateNames(sessions);
  const names = result.map(s => s.terminalName);
  assert.deepStrictEqual(names, ['review', 'plan', 'implement']);
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
