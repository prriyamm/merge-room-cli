import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSessionExport } from '../src/sessions.js';

test('session export keeps the previous file until the complete replacement is ready', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-atomic-export-'));
  const output = path.join(root, 'report.json');
  const session = { id: 'export-id', answer: 'A complete answer.' };
  const originalRename = fs.rename;
  let replacementObserved = false;
  try {
    await fs.writeFile(output, 'Previous export', 'utf8');
    fs.rename = async (source, destination) => {
      if (destination === output) {
        assert.equal(path.dirname(source), root);
        assert.equal(await fs.readFile(output, 'utf8'), 'Previous export');
        assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), session);
        replacementObserved = true;
      }
      return originalRename(source, destination);
    };
    assert.equal(await writeSessionExport(session, root, 'report.json', 'json'), output);
    assert.equal(replacementObserved, true);
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), session);
    assert.deepEqual(await fs.readdir(root), ['report.json']);
  } finally {
    fs.rename = originalRename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed export staging or replacement preserves the old file and removes its temporary file', async () => {
  for (const failurePoint of ['write', 'rename']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-export-failure-'));
    const output = path.join(root, 'report.md');
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    const failure = new Error(`Simulated ${failurePoint} failure`);
    let failureReached = false;
    try {
      await fs.writeFile(output, 'Previous export', 'utf8');
      fs.open = async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (failurePoint === 'write' && path.dirname(file) === root && path.basename(file).startsWith('.merge-room-export-')) {
          const originalHandleWriteFile = handle.writeFile;
          handle.writeFile = async () => {
            await originalHandleWriteFile.call(handle, 'Incomplete replacement', 'utf8');
            failureReached = true;
            throw failure;
          };
        }
        return handle;
      };
      fs.rename = async (source, destination) => {
        if (failurePoint === 'rename' && destination === output) {
          assert.match(await fs.readFile(source, 'utf8'), /Complete replacement/);
          failureReached = true;
          throw failure;
        }
        return originalRename(source, destination);
      };
      await assert.rejects(writeSessionExport({ answer: 'Complete replacement' }, root, 'report.md'), (error) => error === failure);
      assert.equal(failureReached, true, failurePoint);
      assert.equal(await fs.readFile(output, 'utf8'), 'Previous export', failurePoint);
      assert.deepEqual(await fs.readdir(root), ['report.md'], failurePoint);
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRename;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('session export accepts a long valid destination filename without leaving staging files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-long-export-'));
  const filename = `${'r'.repeat(218)}.json`;
  const output = path.join(root, filename);
  const session = { id: 'long-export-id', answer: 'Complete replacement' };
  try {
    await fs.writeFile(output, 'Previous export', 'utf8');
    assert.equal(await writeSessionExport(session, root, filename, 'json'), output);
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), session);
    assert.deepEqual(await fs.readdir(root), [filename]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
