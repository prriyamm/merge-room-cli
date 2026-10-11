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

test('strict mode exits zero for a complete run with --json', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-strict-complete-'));
  try {
    const { stdout } = await execute(
      process.execPath,
      [cli, '--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--strict', '--json', 'complete mission'],
      { windowsHide: true, timeout: 30000 }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'complete');
    assert.equal(result.degraded, false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('strict mode exits 2 with a single terminal run:done for degraded --events runs', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-strict-events-'));
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [cli, '--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--strict', '--events', '--max-calls=1', '--no-stream', 'degraded mission'],
        { windowsHide: true, timeout: 30000 }
      ),
      (error) => {
        if (error.code !== 2) return false;
        const lines = String(error.stdout || '').split('\n').filter(Boolean);
        if (!lines.length) return false;
        const events = lines.map((line) => JSON.parse(line));
        const terminals = events.filter((event) => event.type === 'run:done');
        if (terminals.length !== 1) return false;
        const last = events[events.length - 1];
        return last.type === 'run:done' && last.result?.degraded === true;
      }
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('strict mode exits 2 with best-effort output for degraded human runs', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-strict-human-'));
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [cli, '--cwd', workspace, '--provider=demo', '--no-context', '--no-save', '--strict', '--max-calls=1', '--no-stream', 'degraded mission'],
        { windowsHide: true, timeout: 30000 }
      ),
      (error) => error.code === 2 && /best effort/i.test(error.stdout || '')
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('plan --prompt-file reports a missing file with the workspace path', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-workspace-'));
  try {
    const realWorkspace = await fs.realpath(workspace);
    await assert.rejects(
      execute(
        process.execPath,
        [cli, '--cwd', workspace, 'plan', '--no-context', '--prompt-file', 'nope.md'],
        { cwd: caller, windowsHide: true, timeout: 30000 }
      ),
      (error) => error.code === 1 && error.stderr.includes(`Could not read prompt file: ${path.join(realWorkspace, 'nope.md')}`)
    );
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('plan --prompt-file rejects a directory path', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-workspace-'));
  try {
    await fs.mkdir(path.join(workspace, 'notes'));
    const realWorkspace = await fs.realpath(workspace);
    await assert.rejects(
      execute(
        process.execPath,
        [cli, '--cwd', workspace, 'plan', '--no-context', '--prompt-file', 'notes'],
        { cwd: caller, windowsHide: true, timeout: 30000 }
      ),
      (error) => error.code === 1 && error.stderr.includes(`Prompt path is not a file: ${path.join(realWorkspace, 'notes')}`)
    );
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('plan --prompt-file rejects an empty file', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-workspace-'));
  try {
    await fs.writeFile(path.join(workspace, 'empty.md'), '', 'utf8');
    const realWorkspace = await fs.realpath(workspace);
    await assert.rejects(
      execute(
        process.execPath,
        [cli, '--cwd', workspace, 'plan', '--no-context', '--prompt-file', 'empty.md'],
        { cwd: caller, windowsHide: true, timeout: 30000 }
      ),
      (error) => error.code === 1 && error.stderr.includes(`Prompt file is empty: ${path.join(realWorkspace, 'empty.md')}`)
    );
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('plan --prompt-file rejects a file larger than 256 KiB', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-workspace-'));
  try {
    await fs.writeFile(path.join(workspace, 'big.md'), 'x'.repeat(257 * 1024), 'utf8');
    await assert.rejects(
      execute(
        process.execPath,
        [cli, '--cwd', workspace, 'plan', '--no-context', '--prompt-file', 'big.md'],
        { cwd: caller, windowsHide: true, timeout: 30000 }
      ),
      (error) => error.code === 1 && error.stderr.includes('exceeds the 256 KB limit')
    );
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('plan --prompt-file resolves a workspace-relative file from the caller cwd', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-workspace-'));
  try {
    const body = 'Review the release and list the two highest risks.';
    await fs.writeFile(path.join(workspace, 'mission.md'), `${body}\n`, 'utf8');
    const { stdout } = await execute(
      process.execPath,
      [cli, '--cwd', workspace, 'plan', '--no-context', '--json', '--prompt-file', 'mission.md'],
      { cwd: caller, windowsHide: true, timeout: 30000 }
    );
    assert.equal(JSON.parse(stdout).request, body);
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
