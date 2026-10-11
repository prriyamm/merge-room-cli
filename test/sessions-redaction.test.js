import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatSessionMarkdown, readSession, sanitizeSessionForStorage, saveSession, writeSessionExport } from '../src/sessions.js';
import { buildResumeRequest } from '../src/cli.js';

const SECRET_VALUE = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ASSIGNMENT = `SECRET_ACCESS_KEY=${SECRET_VALUE}`;

function missionSession() {
  return {
    runId: 'run-redaction',
    theme: 'merge-room',
    request: `Deploy the app with ${SECRET_ASSIGNMENT} please`,
    answer: `Deployed using ${SECRET_ASSIGNMENT} done`,
    agents: [
      { agent: { id: 'scout', name: 'Scout' }, stage: 1, status: 'done', text: `Scout note with ${SECRET_ASSIGNMENT}` },
    ],
    conversation: [
      {
        request: `Prior turn with ${SECRET_ASSIGNMENT}`,
        answer: `Prior answer with ${SECRET_ASSIGNMENT}`,
        agents: [{ name: 'Scout', stage: 1, text: `Prior agent note with ${SECRET_ASSIGNMENT}` }],
      },
    ],
    synthesisError: `Lead failed with ${SECRET_ASSIGNMENT}`,
    status: 'complete',
    usage: { input: 1, output: 2, total: 3, calls: 1 },
  };
}

test('sanitizeSessionForStorage deep-clones and redacts secret text', () => {
  const session = missionSession();
  const snapshot = JSON.parse(JSON.stringify(session));
  const clean = sanitizeSessionForStorage(session);
  assert.deepEqual(session, snapshot, 'input must not be mutated');
  assert.notEqual(clean, session);
  const dumped = JSON.stringify(clean);
  assert.doesNotMatch(dumped, new RegExp(SECRET_VALUE));
  assert.match(dumped, /\[redacted\]/);
  assert.equal(clean.usage.total, 3, 'non-secret shapes preserved');
  assert.equal(clean.agents.length, 1);
  assert.equal(clean.conversation.length, 1);
  assert.equal(clean.conversation[0].agents.length, 1);
});

test('saveSession stores redacted JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-redact-save-'));
  try {
    const session = missionSession();
    const { id, file } = await saveSession(session, root);
    const raw = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(raw, new RegExp(SECRET_VALUE));
    assert.match(raw, /\[redacted\]/);
    const reread = await readSession(id, root);
    assert.ok(reread);
    assert.doesNotMatch(JSON.stringify(reread), new RegExp(SECRET_VALUE));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeSessionExport md/json lack plaintext and contain [redacted]', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-redact-export-'));
  try {
    const session = { id: 'export-redact', ...missionSession() };
    const mdFile = await writeSessionExport(session, root, 'report.md', 'md');
    const md = await fs.readFile(mdFile, 'utf8');
    assert.doesNotMatch(md, new RegExp(SECRET_VALUE));
    assert.match(md, /\[redacted\]/);
    const jsonFile = await writeSessionExport(session, root, 'report.json', 'json');
    const json = await fs.readFile(jsonFile, 'utf8');
    assert.doesNotMatch(json, new RegExp(SECRET_VALUE));
    assert.match(json, /\[redacted\]/);
    const mdDirect = formatSessionMarkdown(session);
    assert.doesNotMatch(mdDirect, new RegExp(SECRET_VALUE));
    assert.match(mdDirect, /\[redacted\]/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('redacted prior still resumes with conversation intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-redact-resume-'));
  try {
    const { id } = await saveSession(missionSession(), root);
    const prior = await readSession(id, root);
    assert.ok(Array.isArray(prior.conversation));
    assert.equal(prior.conversation.length, 1);
    assert.equal(prior.conversation[0].agents.length, 1);
    const resumed = buildResumeRequest('follow up task', prior);
    assert.match(resumed, /follow up task/);
    assert.match(resumed, /Prior conversation/);
    assert.doesNotMatch(resumed, new RegExp(SECRET_VALUE));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
