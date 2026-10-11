import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MergeRoomEngine } from '../src/engine.js';
import { DemoProvider } from '../src/providers.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/merge-room.js', import.meta.url));

function singleAgentConfig() {
  return { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
}

test('engine keeps the requested runId stable across reused runs', async () => {
  const config = singleAgentConfig();
  const engine = new MergeRoomEngine({ config, provider: new DemoProvider(config), runId: 'stable-id' });
  const first = await engine.run('first mission');
  const second = await engine.run('second mission');
  assert.equal(first.runId, 'stable-id');
  assert.equal(second.runId, 'stable-id');
  assert.equal(first.runId, second.runId);
});

test('engine mints a fresh runId per run without a requested id', async () => {
  const config = singleAgentConfig();
  const engine = new MergeRoomEngine({ config, provider: new DemoProvider(config) });
  const first = await engine.run('first mission');
  const second = await engine.run('second mission');
  assert.ok(first.runId, 'auto runId exists');
  assert.ok(second.runId, 'second auto runId exists');
  assert.notEqual(second.runId, first.runId);
});

test('engine rejects falsy runIds with a generated UUID', async () => {
  const config = singleAgentConfig();
  const engine = new MergeRoomEngine({ config, provider: new DemoProvider(config), runId: '' });
  const result = await engine.run('empty id mission');
  assert.ok(result.runId, 'falsy id falls through to generated UUID');
  assert.notEqual(result.runId, '');
});

test('--events stream has strictly increasing sequences and one terminal run:done', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-identity-'));
  try {
    const { stdout } = await execute(
      process.execPath,
      [cli, '--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--no-stream', '--events', '--run-id=seq-1', 'identity probe'],
      { windowsHide: true }
    );
    const lines = stdout.split('\n').filter(Boolean);
    assert.ok(lines.length > 1, 'event stream has multiple lines');
    const events = lines.map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.every((event) => event.runId === 'seq-1'), 'every event carries --run-id');
    const terminals = events.filter((event) => event.type === 'run:done');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].result.runId, 'seq-1');
    assert.equal(terminals[0].result.request, 'identity probe');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
