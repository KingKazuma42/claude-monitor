/**
 * Unit tests for disambiguateNames() logic.
 *
 * The function itself lives in extension.ts (not exported), so we re-implement
 * the same algorithm here as a pure function.  If the algorithm is ever
 * extracted to a utility module, replace the inline copy with an import.
 *
 * Runner: node out/test/disambiguateNames.test.js
 */

import * as assert from 'assert';

// ─── inline copy of the algorithm under test ────────────────────────────────
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

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSession(pid: number, name: string): MinSession {
  return { id: `claude-${pid}`, pid, terminalName: name };
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

console.log('\ndisambiguateNames()');

test('empty array returns empty array', () => {
  assert.deepStrictEqual(disambiguateNames([]), []);
});

test('single session with unique name is unchanged', () => {
  const s = makeSession(100, 'claude');
  const result = disambiguateNames([s]);
  assert.strictEqual(result[0].terminalName, 'claude');
});

test('two sessions with different names are unchanged', () => {
  const sessions = [
    makeSession(100, 'claude (sonnet)'),
    makeSession(200, 'claude (opus)'),
  ];
  const result = disambiguateNames(sessions);
  assert.strictEqual(result[0].terminalName, 'claude (sonnet)');
  assert.strictEqual(result[1].terminalName, 'claude (opus)');
});

test('two sessions with the same name get #1 and #2', () => {
  const sessions = [
    makeSession(100, 'claude'),
    makeSession(200, 'claude'),
  ];
  const result = disambiguateNames(sessions);
  const names = result.map(s => s.terminalName).sort();
  assert.deepStrictEqual(names, ['claude #1', 'claude #2']);
});

test('#1 is assigned to the lowest PID', () => {
  const sessions = [
    makeSession(200, 'claude'),  // inserted first but higher PID
    makeSession(100, 'claude'),
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(100), 'claude #1');
  assert.strictEqual(byPid.get(200), 'claude #2');
});

test('three sessions with the same name get #1 #2 #3 in PID order', () => {
  const sessions = [
    makeSession(300, 'claude'),
    makeSession(100, 'claude'),
    makeSession(200, 'claude'),
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(100), 'claude #1');
  assert.strictEqual(byPid.get(200), 'claude #2');
  assert.strictEqual(byPid.get(300), 'claude #3');
});

test('groups with different names are disambiguated independently', () => {
  const sessions = [
    makeSession(100, 'claude'),
    makeSession(200, 'claude'),
    makeSession(300, 'claude (opus)'),
    makeSession(400, 'claude (opus)'),
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(100), 'claude #1');
  assert.strictEqual(byPid.get(200), 'claude #2');
  assert.strictEqual(byPid.get(300), 'claude (opus) #1');
  assert.strictEqual(byPid.get(400), 'claude (opus) #2');
});

test('original session objects are not mutated', () => {
  const s1 = makeSession(100, 'claude');
  const s2 = makeSession(200, 'claude');
  disambiguateNames([s1, s2]);
  // original objects unchanged
  assert.strictEqual(s1.terminalName, 'claude');
  assert.strictEqual(s2.terminalName, 'claude');
});

test('non-duplicate session in a mixed list is unchanged', () => {
  const sessions = [
    makeSession(100, 'claude'),
    makeSession(200, 'claude'),
    makeSession(300, 'claude (reviewer)'),  // unique
  ];
  const result = disambiguateNames(sessions);
  const byPid = new Map(result.map(s => [s.pid, s.terminalName]));
  assert.strictEqual(byPid.get(300), 'claude (reviewer)');  // no suffix
});

test('output array preserves input order', () => {
  const sessions = [
    makeSession(200, 'claude'),
    makeSession(100, 'claude'),
  ];
  const result = disambiguateNames(sessions);
  // Order in output must match input order (200 first, 100 second)
  assert.strictEqual(result[0].pid, 200);
  assert.strictEqual(result[1].pid, 100);
  // But suffix is still based on PID ordering (100=#1, 200=#2)
  assert.strictEqual(result[0].terminalName, 'claude #2');
  assert.strictEqual(result[1].terminalName, 'claude #1');
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
