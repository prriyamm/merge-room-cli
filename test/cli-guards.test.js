import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionExport } from '../src/sessions.js';
import { formatRoomError } from '../src/ui.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/merge-room.js', import.meta.url));

async function makeWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-guards-'));
  return workspace;
}

test('cockpit rejects automation flags instead of silently dropping them', async () => {
  const workspace = await makeWorkspace();
  try {
    for (const flag of ['--json', '--events', '--strict', '--run-id=x']) {
      await assert.rejects(
        execute(process.execPath, [cli, '--cwd', workspace, '--provider=demo', flag], { timeout: 15000, windowsHide: true }),
        (error) => error.code === 1 && /cockpit/i.test(error.stderr),
        `expected ${flag} to be rejected before the cockpit starts`
      );
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('ignored overrides warn on stderr without breaking stdout contracts', async () => {
  const workspace = await makeWorkspace();
  try {
    await fs.writeFile(path.join(workspace, 'merge-room.config.json'), JSON.stringify({
      providers: { work: { type: 'openai-compatible', model: 'm', baseUrl: 'https://profile.example/v1' } }
    }));
    // --base-url is dead when named profiles exist; --include is dead with --no-context.
    const { stdout, stderr } = await execute(
      process.execPath,
      [cli, '--cwd', workspace, '--provider=demo', '--base-url=https://fallback.example/v1', '--include=README.md', '--no-context', '--json', 'config'],
      { windowsHide: true }
    );
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.model, 'stdout JSON contract stays parseable');
    assert.match(stderr, /--base-url.*ignored for named provider profiles/);
    assert.match(stderr, /--include.*no effect while workspace context is disabled/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('session export preserves the prior file mode instead of leaking 0600', async () => {
  const workspace = await makeWorkspace();
  try {
    const session = { id: 's1', request: 'r', answer: 'a', agents: [], usage: {}, status: 'complete' };
    const dest = path.join(workspace, 'report.md');
    await fs.writeFile(dest, 'old report\n', { mode: 0o644 });
    const before = (await fs.stat(dest)).mode & 0o777;
    await writeSessionExport(session, workspace, 'report.md', 'md');
    const stat = await fs.stat(dest);
    assert.equal(stat.mode & 0o777, before, 'export preserves the prior file mode');
    assert.notEqual(stat.mode & 0o777, 0o600, 'staging mode must not leak onto the final report');
    const body = await fs.readFile(dest, 'utf8');
    assert.match(body, /a/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('formatRoomError does not duplicate the status prefix', () => {
  assert.equal(formatRoomError('cancelled', 'Mission cancelled.'), 'Cancelled: Mission cancelled.');
  assert.equal(formatRoomError('cancelled', 'Cancelled: Mission cancelled.'), 'Cancelled: Mission cancelled.');
  assert.equal(formatRoomError('cancelled', 'cancelled by user'), 'cancelled by user');
  assert.equal(formatRoomError('error', 'disk full'), 'Stopped: disk full');
  assert.equal(formatRoomError('error', 'Stopped: disk full'), 'Stopped: disk full');
});
