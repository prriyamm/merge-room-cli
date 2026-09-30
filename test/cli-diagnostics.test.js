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

test('diagnostics describe the same overridden team, models and limits as preflight', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-effective-diagnostics-'));
  try {
    await fs.writeFile(path.join(workspace, 'merge-room.config.json'), JSON.stringify({
      providers: { work: { type: 'openai-compatible', model: 'profile-model', baseUrl: 'https://profile.example/v1' } },
      agents: [{ id: 'scout', model: 'agent-model' }, { id: 'critic' }]
    }));
    const flags = [
      '--cwd', workspace, '--provider=demo', '--profile=work', '--model=override-model',
      '--team=scout', '--base-url=https://fallback.example/v1', '--max-tokens=321',
      '--concurrency=2', '--timeout=400', '--retries=0', '--max-calls=3', '--temperature=0.2',
      '--parallel', '--no-stream', '--stream-usage', '--no-context', '--include=README.md,src/app.js', '--diff', '--json'
    ];
    const readCommand = async (...args) => {
      const { stdout } = await execute(process.execPath, [cli, ...flags, ...args], { windowsHide: true });
      return JSON.parse(stdout);
    };
    const config = await readCommand('config');
    const agents = await readCommand('agents');
    const providers = await readCommand('providers');
    const doctor = await readCommand('doctor');
    const plan = await readCommand('plan', 'Check this run before starting it');

    assert.equal(config.model, 'override-model');
    assert.equal(config.baseUrl, 'https://fallback.example/v1');
    assert.deepEqual(config.agents.map((agent) => agent.id), ['scout']);
    assert.deepEqual(agents.agents, config.agents);
    assert.equal(agents.model, config.model);
    assert.equal(providers.profiles[0].model, config.model);
    assert.deepEqual(providers.profiles[0].agents, ['scout']);
    assert.equal(doctor.config, config.model);
    assert.deepEqual(doctor.agents, plan.agents.map((agent) => agent.id));
    assert.equal(plan.agents[0].model, config.agents[0].model);
    assert.equal(plan.strategy, config.strategy);
    for (const field of ['maxCalls', 'maxConcurrency', 'maxTokens', 'requestTimeoutMs', 'retries']) {
      assert.equal(config[field], plan.limits[field], `${field} should agree with preflight`);
    }
    assert.equal(doctor.maxConcurrency, plan.limits.maxConcurrency);
    assert.equal(doctor.leadStreaming, false);
    assert.equal(doctor.streamUsage, true);
    assert.equal(doctor.workspaceContext.enabled, false);
    assert.equal(config.context.enabled, false);
    assert.deepEqual(config.context.include, ['README.md', 'src/app.js']);
    assert.equal(config.context.includeDiff, true);
    assert.equal(config.temperature, 0.2);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('diagnostic commands reject invalid run overrides instead of silently ignoring them', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-invalid-diagnostics-'));
  try {
    for (const [command, option, expected] of [
      ['config', '--concurrency=0', /concurrency/],
      ['agents', '--team=unknown-specialist', /Unknown agent/],
      ['doctor', '--timeout=10', /timeout/]
    ]) {
      await assert.rejects(
        execute(process.execPath, [cli, '--cwd', workspace, '--provider=demo', '--json', option, command], { windowsHide: true }),
        (error) => error.code === 1 && expected.test(error.stderr)
      );
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
