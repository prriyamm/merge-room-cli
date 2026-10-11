import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/merge-room.js', import.meta.url));

async function runCli(args, options = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], {
      windowsHide: true,
      timeout: 15000,
      ...options,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    return {
      ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code,
    };
  }
}

async function expectHumanError(args, literals) {
  const result = await runCli(args);
  assert.equal(result.ok, false, `expected CLI to fail: ${args.join(' ')}`);
  assert.equal(result.code, 1, `expected exit 1: ${args.join(' ')} stderr=${result.stderr}`);
  for (const literal of literals) {
    assert.ok(
      result.stderr.includes(literal),
      `human stderr should include literal ${JSON.stringify(literal)}\nargs: ${args.join(' ')}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

async function expectJsonError(args, literals) {
  const result = await runCli([...args, '--json']);
  assert.equal(result.ok, false, `expected CLI to fail (--json): ${args.join(' ')}`);
  assert.equal(result.code, 1, `expected exit 1 (--json): ${args.join(' ')} stderr=${result.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stderr.trim());
  } catch {
    assert.fail(`--json stderr is not JSON\nargs: ${args.join(' ')}\nstderr: ${result.stderr}`);
  }
  assert.equal(parsed?.error?.code, 'MERGE_ROOM_ERROR', `--json error.code stderr=${result.stderr}`);
  assert.equal(typeof parsed?.error?.message, 'string', `--json error.message stderr=${result.stderr}`);
  for (const literal of literals) {
    assert.ok(
      parsed.error.message.includes(literal),
      `--json message should include literal ${JSON.stringify(literal)}\nargs: ${args.join(' ')}\nmessage: ${parsed.error.message}`,
    );
  }
  return result;
}

async function expectDualMode(args, literals) {
  await expectHumanError(args, literals);
  await expectJsonError(args, literals);
}

async function makeWorkspace(configObj) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-errors2-'));
  if (configObj !== undefined) {
    await fs.writeFile(path.join(workspace, 'merge-room.config.json'), JSON.stringify(configObj));
  }
  return workspace;
}

async function rmWorkspace(workspace) {
  await fs.rm(workspace, { recursive: true, force: true });
}

// ---- (c) --cwd/--config failures (non-cockpit `config` command) ----

test('(c) --cwd ghost dir fails with Could not open workspace', async () => {
  const ghostDir = path.join(os.tmpdir(), `merge-room-ghost-${process.pid}-${Date.now()}-nope`);
  const candidate = path.resolve(process.cwd(), ghostDir);
  // Ensure it really does not exist.
  await fs.rm(ghostDir, { recursive: true, force: true });
  const result = await runCli(['--cwd', ghostDir, 'config']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.ok(
    result.stderr.includes(`Could not open workspace: ${candidate}`),
    `stderr should include literal "Could not open workspace: ${candidate}"\nstderr: ${result.stderr}`,
  );
});

test('(c) --cwd file-as-dir fails with Workspace is not a directory', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-errors2-filecwd-'));
  try {
    const filePath = path.join(parent, 'not-a-dir');
    await fs.writeFile(filePath, 'i am a file\n');
    const candidate = path.resolve(process.cwd(), filePath);
    const result = await runCli(['--cwd', filePath, 'config']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes(`Workspace is not a directory: ${candidate}`),
      `stderr should include literal "Workspace is not a directory: ${candidate}"\nstderr: ${result.stderr}`,
    );
  } finally {
    await rmWorkspace(parent);
  }
});

test('(c) missing --config fails with Could not read missing.json', async () => {
  const workspace = await makeWorkspace();
  try {
    const result = await runCli(['--cwd', workspace, '--config', 'missing.json', 'config']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes('Could not read missing.json: file not found.'),
      `stderr should include literal "Could not read missing.json: file not found."\nstderr: ${result.stderr}`,
    );
  } finally {
    await rmWorkspace(workspace);
  }
});

// ---- (d) show/resume error table x dual-mode ----

test('(d) show no-arg errors in human and --json modes', async () => {
  const workspace = await makeWorkspace();
  try {
    const literal = 'Give show a session id. Try `merge-room history` first.';
    await expectDualMode(['--cwd', workspace, 'show'], [literal]);
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) resume no-arg errors in human and --json modes', async () => {
  const workspace = await makeWorkspace();
  try {
    const literal = 'Give resume a session id. Try `merge-room history` first.';
    await expectDualMode(['--cwd', workspace, 'resume'], [literal]);
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) show history-disabled errors in human and --json modes', async () => {
  const workspace = await makeWorkspace({ sessionDir: null });
  try {
    const literal = 'Session history is disabled in merge-room.config.json.';
    await expectDualMode(['--cwd', workspace, 'show', 'anything123'], [literal]);
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) resume history-disabled errors in human and --json modes', async () => {
  const workspace = await makeWorkspace({ sessionDir: null });
  try {
    const literal = 'Session history is disabled in merge-room.config.json.';
    await expectDualMode(
      ['--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--no-stream', 'resume', 'anything123', 'follow-up mission'],
      [literal],
    );
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) show unknown-id errors in human and --json modes', async () => {
  const workspace = await makeWorkspace();
  try {
    const unknownId = 'does-not-exist-xyz';
    await expectDualMode(['--cwd', workspace, 'show', unknownId], [`Session not found: ${unknownId}`]);
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) resume unknown-id errors in human and --json modes', async () => {
  const workspace = await makeWorkspace();
  try {
    const unknownId = 'does-not-exist-xyz';
    await expectDualMode(
      ['--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--no-stream', 'resume', unknownId, 'follow-up mission'],
      [`Session not found: ${unknownId}`],
    );
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) show ambiguous-prefix errors in human and --json modes', async () => {
  const workspace = await makeWorkspace();
  try {
    const idA = 'abc111aaa';
    const idB = 'abc222bbb';
    const sessionDir = path.join(workspace, '.merge-room', 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, `${idA}.json`), JSON.stringify({ request: 'r-a', answer: 'a-a' }));
    await fs.writeFile(path.join(sessionDir, `${idB}.json`), JSON.stringify({ request: 'r-b', answer: 'a-b' }));
    const literals = ['Session prefix is ambiguous', idA, idB];
    await expectDualMode(['--cwd', workspace, 'show', 'abc'], literals);
  } finally {
    await rmWorkspace(workspace);
  }
});

test('(d) resume ambiguous-prefix errors in human and --json modes', async () => {
  const workspace = await makeWorkspace();
  try {
    const idA = 'abc111aaa';
    const idB = 'abc222bbb';
    const sessionDir = path.join(workspace, '.merge-room', 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, `${idA}.json`), JSON.stringify({ request: 'r-a', answer: 'a-a' }));
    await fs.writeFile(path.join(sessionDir, `${idB}.json`), JSON.stringify({ request: 'r-b', answer: 'a-b' }));
    const literals = ['Session prefix is ambiguous', idA, idB];
    await expectDualMode(
      ['--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--no-stream', 'resume', 'abc', 'follow-up mission'],
      literals,
    );
  } finally {
    await rmWorkspace(workspace);
  }
});
