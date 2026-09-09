import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG, loadConfig, safeBaseUrl } from '../src/config.js';
import { collectWorkspaceContext, formatWorkspaceContext } from '../src/context.js';
import { buildRunPlan, MergeRoomEngine, SCHEMA_VERSION } from '../src/engine.js';
import { createProvider, DemoProvider, OpenAICompatibleProvider } from '../src/providers.js';
import { formatSessionMarkdown, listSessions, readSession, saveSession, writeSessionExport } from '../src/sessions.js';
import { createLedger, estimateTokens } from '../src/tokens.js';
import { buildResumeRequest } from '../src/cli.js';
import { completionScript } from '../src/completions.js';
import { printResult } from '../src/ui.js';
import { resolveTheme, themeSummaries } from '../src/themes.js';

const execFileAsync = promisify(execFile);

test('completion scripts cover supported shells', () => {
  assert.match(completionScript('bash'), /complete -F _merge_room merge-room/);
  assert.match(completionScript('zsh'), /#compdef merge-room/);
  assert.match(completionScript('ps'), /Register-ArgumentCompleter/);
  assert.throws(() => completionScript('fish'), /Supported completion shells/);
  assert.match(completionScript('bash'), /--max-calls=/);
  assert.match(completionScript('bash'), /--cwd=/);
  assert.match(completionScript('bash'), /--prompt-file=/);
  assert.match(completionScript('bash'), /theme/);
});

test('themes expose named palettes and useful aliases', () => {
  assert.equal(resolveTheme('default').id, 'merge-room');
  assert.equal(resolveTheme('highcontrast').id, 'high-contrast');
  assert.equal(themeSummaries().length, 5);
  assert.throws(() => resolveTheme('unknown'), /merge-room theme list/);
});

test('provider mode can force deterministic local runs', () => {
  assert.equal(createProvider({ ...DEFAULT_CONFIG, provider: 'demo' }).name, 'demo');
});

test('human result footer exposes input, output, and total burned usage', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    printResult({ durationMs: 1000, agents: [{ agent: { color: 'cyan', mark: '◇', name: 'Scout' } }], usage: { input: 1200, output: 300, total: 1500, calls: 1, estimatedInput: true, estimatedOutput: false } });
  } finally {
    console.log = originalLog;
  }
  const output = lines.join('\n');
  assert.match(output, /burned/);
  assert.match(output, /~1\.5k burned/);
  assert.match(output, /~1\.2k in/);
  assert.match(output, /300 out/);
});

test('diagnostic URLs redact embedded credentials and secret queries', () => {
  const safe = safeBaseUrl('https://user:password@example.com/v1?api_key=secret&region=west');
  assert.equal(safe.includes('password'), false);
  assert.equal(safe.includes('secret'), false);
  assert.match(safe, /region=west/);
});

test('token ledger tracks input, output, and total', () => {
  const ledger = createLedger();
  ledger.add(12, 8); ledger.add(5, 4, { inputEstimated: true, outputEstimated: true });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.input, 17);
  assert.equal(snapshot.output, 12);
  assert.equal(snapshot.calls, 2);
 assert.equal(snapshot.total, 29);
  assert.equal(snapshot.estimatedInput, 5);
 assert.equal(snapshot.estimatedOutput, 4);
  const modelLedger = createLedger();
  modelLedger.add(10, 4, { model: 'scout-model' });
  modelLedger.add(3, 2, { model: 'scout-model', inputEstimated: true });
  assert.deepEqual(modelLedger.snapshot().byModel['scout-model'], { input: 13, output: 6, calls: 2, estimatedInput: 3, estimatedOutput: 0, total: 19 });
 assert.equal(typeof snapshot.startedAt, 'number');
});

test('openai-compatible adapter cancels retry backoff', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('network down'); };
  const controller = new AbortController();
  const promise = new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 2 }, 'secret').complete({ system: 'system', prompt: 'prompt', signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(promise, (error) => error.name === 'AbortError');
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('session exports preserve the answer and usage ledger', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-export-')); try { const session = { id: 'abc123', savedAt: '2026-01-01T00:00:00.000Z', request: 'Export this', answer: 'A useful answer.', provider: 'demo', model: 'local-demo', strategy: 'staged', synthesisError: 'lead offline', usage: { input: 12, output: 8, total: 20, calls: 5 }, agents: [{ agent: { id: 'scout', name: 'Scout' }, stage: 1, text: 'A concise note.' }] }; const markdown = formatSessionMarkdown(session); assert.ok(markdown.includes('Total tokens burned: 20')); assert.ok(markdown.includes('A useful answer.')); assert.ok(markdown.includes('lead offline')); const output = await writeSessionExport(session, root, 'out/report.json', 'json'); assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).answer, 'A useful answer.'); } finally { await fs.rm(root, { recursive: true, force: true }); } });

test('session markdown preserves orchestration metadata', () => {
  const markdown = formatSessionMarkdown({ strategy: 'staged', durationMs: 1250, waves: [{ label: 'orientation', agentIds: ['scout'] }], agents: [{ agent: { name: 'Scout' }, stage: 1, status: 'done', durationMs: 300, text: 'note' }] });
  assert.match(markdown, /Duration:\*\* 1\.3s/);
  assert.match(markdown, /Waves:\*\* orientation \(scout\)/);
  assert.match(markdown, /Scout · stage 1 · done · 0\.3s/);
  assert.match(formatSessionMarkdown({ context: { fileCount: 2, excerptCount: 1, diff: true } }), /Workspace context:\*\* 2 files · 1 excerpts · diff included/);
  assert.match(formatSessionMarkdown({ usage: { input: 3, output: 1, total: 4, calls: 2, byModel: { scout: { total: 3, calls: 1 } } } }), /scout: 3 total · 1 calls/);
});

test('demo provider returns a usable bounded note', async () => {
  const result = await new DemoProvider(DEFAULT_CONFIG).complete({ system: 'You are Scout', prompt: 'Make a plan' });
  assert.match(result.text, /scope|Focus/i);
 assert.ok(result.inputTokens > 0 && result.outputTokens > 0);
  assert.equal(result.inputEstimated, true);
  assert.equal(result.outputEstimated, true);
});

test('engine fans out to specialists and synthesizes', async () => {
  const events = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const result = await new MergeRoomEngine({ config, provider: new DemoProvider(config), onEvent: (event) => events.push(event) }).run('Ship a small feature');
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(events.every((event) => event.schemaVersion === SCHEMA_VERSION), true);
  assert.equal(result.agents.length, 2);
 assert.equal(result.agents.every((agent) => agent.status === 'done'), true);
 assert.equal(result.agents.every((agent) => agent.durationMs >= 0), true);
 assert.equal(result.usage.estimatedInput > 0, true);
 assert.equal(result.usage.estimatedOutput > 0, true);
  assert.equal(result.agents.every((agent) => agent.inputEstimated === true && agent.outputEstimated === true), true);
 assert.ok(result.answer.length > 20);
  assert.ok(result.usage.total > 0);
  assert.equal(events.at(-1).type, 'run:done');
});

test('reusing an engine starts a fresh ledger and event stream', async () => {
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const events = [];
  const engine = new MergeRoomEngine({ config, provider: new DemoProvider(config), onEvent: (event) => events.push(event) });
  const first = await engine.run('first reusable mission');
  const firstEventCount = events.length;
  const second = await engine.run('second reusable mission');
  assert.equal(first.usage.calls, 2);
  assert.equal(second.usage.calls, 2);
  assert.equal(events[firstEventCount].sequence, 1);
  assert.equal(events.at(-1).sequence, events.length - firstEventCount);
});

test('default roster uses a staged team handoff', async () => {
  const events = [];
  const result = await new MergeRoomEngine({ config: DEFAULT_CONFIG, provider: new DemoProvider(DEFAULT_CONFIG), onEvent: (event) => events.push(event) }).run('Design a small release plan');
  assert.deepEqual(result.waves.map((wave) => wave.label), ['orientation', 'draft', 'review']);
  assert.deepEqual(result.agents.map((item) => item.stage), [1, 1, 2, 3]);
  const dispatches = events.filter((event) => event.type === 'agents:dispatch');
  assert.deepEqual(dispatches.map((event) => event.stage), [1, 2, 3]);
  const stageTwoIndex = events.findIndex((event) => event.type === 'agents:dispatch' && event.stage === 2);
  const stageOneStartIndexes = events.flatMap((event, index) => event.type === 'agent:start' && event.stage === 1 ? [index] : []);
  const firstDoneIndex = events.findIndex((event) => event.type === 'agent:done' && event.stage === 1);
  assert.equal(stageOneStartIndexes.length, 2);
  assert.ok(stageOneStartIndexes[1] < firstDoneIndex);
  const firstWaveDone = events.slice(0, stageTwoIndex).filter((event) => event.type === 'agent:done');
  assert.equal(firstWaveDone.length, 2);
  const stageThreeIndex = events.findIndex((event) => event.type === 'agents:dispatch' && event.stage === 3);
  assert.equal(events.slice(0, stageThreeIndex).filter((event) => event.type === 'agent:done').length, 3);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.at))));
});

test('parallel strategy dispatches every specialist in one wave', async () => {
  const events = [];
  const config = { ...DEFAULT_CONFIG, strategy: 'parallel', agents: DEFAULT_CONFIG.agents.slice(0, 3) };
  const provider = { name: 'recording', model: 'test', complete: async ({ onDelta }) => {
    onDelta?.('ok');
    return { text: 'ok', inputTokens: 1, outputTokens: 1 };
  } };
  const result = await new MergeRoomEngine({ config, provider, onEvent: (event) => events.push(event) }).run('Run in parallel');
  assert.deepEqual(result.waves, [{ stage: 1, label: 'parallel', agentIds: ['scout', 'architect', 'maker'] }]);
  assert.deepEqual(result.agents.map((item) => item.stage), [1, 1, 2]);
  const firstDone = events.findIndex((event) => event.type === 'agent:done');
  const starts = events.filter((event) => event.type === 'agent:start');
  assert.equal(starts.length, 3);
  assert.ok(events.findIndex((event) => event.type === 'agents:dispatch' && event.stageLabel === 'parallel') < firstDone);
  assert.equal(result.usage.calls, 4);
});

test('run plan mirrors staged orchestration without calling a provider', () => {
  const plan = buildRunPlan({ strategy: 'staged', agents: DEFAULT_CONFIG.agents });
  assert.deepEqual(plan.waves, [
    { stage: 1, label: 'orientation', agentIds: ['scout', 'architect'] },
    { stage: 2, label: 'draft', agentIds: ['maker'] },
    { stage: 3, label: 'review', agentIds: ['critic'] }
  ]);
});

test('engine enforces a provider call budget and reports skipped agents', async () => {
  let calls = 0;
  const config = { ...DEFAULT_CONFIG, maxCalls: 2 };
  const provider = { name: 'budgeted', model: 'test', complete: async () => { calls += 1; return { text: 'ok', inputTokens: 1, outputTokens: 1 }; } };
  const result = await new MergeRoomEngine({ config, provider }).run('Respect the budget');
  assert.equal(calls, 2);
  assert.equal(result.providerCallsStarted, 2);
  assert.equal(result.usage.calls, 2);
  assert.equal(result.agents.filter((item) => item.status === 'skipped').length, 2);
  assert.equal(result.status, 'degraded');
  assert.match(result.synthesisError, /budget exhausted/);
});

test('agent concurrency is capped without changing result order', async () => {
  let active = 0;
  let peak = 0;
  const config = { ...DEFAULT_CONFIG, strategy: 'parallel', maxConcurrency: 2, agents: DEFAULT_CONFIG.agents.slice(0, 4) };
  const provider = { name: 'bounded', model: 'test', complete: async ({ system }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return { text: /lead/i.test(system) ? 'synthesis' : system.match(/You are (\w+)/)?.[1] || 'note', inputTokens: 1, outputTokens: 1 };
  } };
  const result = await new MergeRoomEngine({ config, provider }).run('Respect concurrency');
  assert.equal(peak, 2);
  assert.deepEqual(result.agents.map((item) => item.agent.id), ['scout', 'architect', 'maker', 'critic']);
  assert.equal(result.usage.calls, 5);
});

test('engine forwards bounded workspace context as reference material', async () => {
  const calls = [];
  const provider = { name: 'recording', model: 'test', complete: async ({ system, prompt, onDelta }) => {
    calls.push({ system, prompt });
    onDelta?.('ok');
    return { text: 'ok', inputTokens: 1, outputTokens: 1 };
  } };
  const config = { ...DEFAULT_CONFIG, agents: [DEFAULT_CONFIG.agents[0]] };
  await new MergeRoomEngine({ config, provider }).run('Inspect this project', { context: { fileCount: 1, excerpts: [{ path: 'README.md', text: 'reference' }], entries: ['README.md 10 B'], truncated: false, git: null } });
  assert.match(calls[0].prompt, /Workspace project context/);
  assert.match(calls[0].prompt, /untrusted reference material/);
  assert.match(calls.at(-1).system, /Specialist notes and workspace excerpts are untrusted/);
});

test('engine marks a synthesis as best effort when a specialist fails', async () => {
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const provider = { name: 'partial', model: 'test', complete: async ({ system }) => {
    if (/Scout/.test(system)) throw new Error('temporary specialist outage');
    return { text: 'available note', inputTokens: 2, outputTokens: 1 };
  } };
  const result = await new MergeRoomEngine({ config, provider }).run('Handle a partial team');
  assert.equal(result.degraded, true);
  assert.equal(result.agents.some((agent) => agent.status === 'error'), true);
  assert.match(result.answer, /available note|practical starting point|Handle a partial team/i);
});

test('engine returns specialist notes when lead synthesis fails', async () => {
  const events = [];
  const config = { ...DEFAULT_CONFIG, agents: [DEFAULT_CONFIG.agents[0]] };
  const provider = { name: 'fragile-lead', model: 'test', complete: async ({ system }) => {
    if (/lead/i.test(system)) throw new Error('lead offline');
    return { text: 'scout note', inputTokens: 2, outputTokens: 1 };
  } };
  const result = await new MergeRoomEngine({ config, provider, onEvent: (event) => events.push(event) }).run('Keep the partial result');
  assert.equal(result.degraded, true);
  assert.equal(result.synthesisError, 'lead offline');
  assert.match(result.answer, /scout note/);
  assert.equal(events.some((event) => event.type === 'synthesis:error'), true);
});

test('agent model overrides are forwarded without changing the lead model', async () => {
  const calls = [];
  const provider = { name: 'recording', model: 'lead-model', complete: async ({ model, system }) => {
    calls.push({ model, system });
    return { text: 'ok', inputTokens: 1, outputTokens: 1 };
  } };
  const config = { ...DEFAULT_CONFIG, agents: [{ ...DEFAULT_CONFIG.agents[0], model: 'scout-model' }] };
  const result = await new MergeRoomEngine({ config, provider }).run('Compare models');
  assert.equal(calls[0].model, 'scout-model');
  assert.equal(calls.at(-1).model, undefined);
 assert.equal(result.agents[0].model, 'scout-model');
 assert.equal(result.model, 'lead-model');
  assert.equal(result.usage.byModel['scout-model'].calls, 1);
  assert.equal(result.usage.byModel['lead-model'].calls, 1);
});

test('engine stops before synthesis when its signal is cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const events = [];
  const provider = { name: 'recording', complete: async () => { calls.push('unexpected'); return { text: 'no', inputTokens: 1, outputTokens: 1 }; } };
  await assert.rejects(() => new MergeRoomEngine({ config: { ...DEFAULT_CONFIG, agents: [DEFAULT_CONFIG.agents[0]] }, provider, onEvent: (event) => events.push(event) }).run('Cancel this', { signal: controller.signal }), /Mission cancelled/);
  assert.equal(calls.length, 0);
  assert.equal(events.at(-1).type, 'run:cancelled');
  assert.equal(events.at(-1).sequence, 1);
});

test('demo provider cancels an in-flight mission', async () => {
  const config = { ...DEFAULT_CONFIG, streaming: false, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const controller = new AbortController();
  const events = [];
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(
    () => new MergeRoomEngine({ config, provider: new DemoProvider(config), onEvent: (event) => events.push(event) }).run('cancel during work', { signal: controller.signal }),
    (error) => error.name === 'AbortError'
  );
  assert.equal(events.at(-1).type, 'run:cancelled');
});

test('token estimate is stable and non-negative', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('12345678'), 2);
});

test('openai-compatible adapter preserves provider usage metadata', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (url, options) => {
    requestBody = { url, ...JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'wrapper', content: [{ type: 'text', text: 'adapter response' }] }] } }], usage: { prompt_tokens: 21, completion_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' }, 'secret').complete({ system: 'system', prompt: 'prompt' });
    assert.equal(requestBody.url, 'https://example.test/v1/chat/completions');
    assert.equal(requestBody.messages.length, 2);
   assert.deepEqual({ input: result.inputTokens, output: result.outputTokens }, { input: 21, output: 7 });
    assert.equal(result.inputEstimated, false);
    assert.equal(result.outputEstimated, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('openai-compatible adapter retries a transient provider failure', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { status: 200 });
  };
  try {
    const result = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 1 }, 'secret').complete({ system: 'system', prompt: 'prompt' });
    assert.equal(calls, 2);
    assert.equal(result.text, 'recovered');
  } finally {
    global.fetch = originalFetch;
  }
});

test('openai-compatible adapter streams lead text and usage', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":[{"type":"wrapper","content":[{"type":"text","text":"world"}]}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ];
    const body = new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk))); controller.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    let streamed = '';
    const result = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'secret').complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => { streamed += delta; } });
    assert.equal(streamed, 'hello world');
    assert.equal(result.text, 'hello world');
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.stream_options, undefined);
    assert.deepEqual({ input: result.inputTokens, output: result.outputTokens }, { input: 8, output: 2 });
  } finally {
    global.fetch = originalFetch;
  }
});

test('openai-compatible adapter can disable streaming for older servers', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'compat response' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
  };
  try {
    let deltas = '';
    const result = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, streaming: false, retries: 0 }, 'secret').complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => { deltas += delta; } });
    assert.equal(requestBody.stream, undefined);
    assert.equal(deltas, '');
    assert.equal(result.text, 'compat response');
  } finally {
    global.fetch = originalFetch;
  }
});

test('openai-compatible adapter reports provider timeouts distinctly', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    reject(error);
  }, { once: true }));
  try {
    await assert.rejects(() => new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, requestTimeoutMs: 20, retries: 0 }, 'secret').complete({ system: 'system', prompt: 'prompt' }), /timed out after 20ms/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('workspace context is bounded and excludes secret-looking files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-context-'));
  try {
    await fs.writeFile(path.join(root, 'README.md'), '# Project\nUseful notes');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=do-not-include');
    await fs.writeFile(path.join(root, 'settings.json'), '{"apiKey":"do-not-include-either"}');
    const context = await collectWorkspaceContext(root, { maxBytes: 500, maxFiles: 10 });
    assert.equal(context.git, null);
    assert.equal(context.entries.some((entry) => entry.includes('.env')), false);
    assert.match(formatWorkspaceContext(context), /README\.md/);
    assert.equal(formatWorkspaceContext(context).includes('do-not-include'), false);
    assert.equal(formatWorkspaceContext(context).includes('do-not-include-either'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace excerpt caps are measured in UTF-8 bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-context-utf8-'));
  try {
    await fs.writeFile(path.join(root, 'unicode.md'), '🙂'.repeat(120), 'utf8');
    const context = await collectWorkspaceContext(root, { maxBytes: 100, maxExcerptBytes: 400 });
    const excerptBytes = context.excerpts.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
    assert.ok(excerptBytes <= 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context prioritizes safe explicit includes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-include-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'background\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const answer = 42;\n', 'utf8');
    await fs.writeFile(path.join(root, 'secrets', 'app.js'), 'should never be included\n', 'utf8');
    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000, include: ['src/app.js', 'secrets/app.js', '../outside.js'] });
    assert.equal(context.excerpts[0].path, 'src/app.js');
    assert.equal(context.excerpts.some((item) => item.path.includes('secrets')), false);
    assert.equal(context.excerpts.some((item) => item.path.includes('outside')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context respects project ignore patterns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-'));
  try {
    await fs.mkdir(path.join(root, 'cache'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), '*.log\ncache/\n!/cache/keep.json\n', 'utf8');
    await fs.writeFile(path.join(root, 'visible.md'), 'keep me\n', 'utf8');
    await fs.writeFile(path.join(root, 'debug.log'), 'skip me\n', 'utf8');
    await fs.writeFile(path.join(root, 'cache', 'result.json'), 'skip me too\n', 'utf8');
    await fs.writeFile(path.join(root, 'cache', 'keep.json'), 'keep me too\n', 'utf8');
    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('debug.log')), false);
    assert.equal(context.entries.some((entry) => entry.includes('result.json')), false);
   assert.equal(context.entries.some((entry) => entry.includes('visible.md')), true);
    assert.equal(context.entries.some((entry) => entry.includes('keep.json')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace formatting keeps an opt-in diff clearly bounded', () => {
  const formatted = formatWorkspaceContext({
    fileCount: 1,
    entries: ['src/app.js 10 B'],
    excerpts: [],
    truncated: false,
    git: { status: '## main', diffStat: '1 file changed', diff: '@@ -1 +1 @@\n-old\n+new' }
  });
  assert.match(formatted, /Bounded diff excerpt/);
  assert.match(formatted, /\+new/);
});

test('opt-in Git context includes staged and unstaged changes from HEAD', async () => {
  try { await execFileAsync('git', ['--version']); } catch { return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-git-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Merge Room Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'merge-room-test@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, 'app.js'), 'const state = "base";\n', 'utf8');
    await execFileAsync('git', ['add', 'app.js'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await fs.writeFile(path.join(root, 'app.js'), 'const state = "staged";\n', 'utf8');
    await execFileAsync('git', ['add', 'app.js'], { cwd: root });
    await fs.writeFile(path.join(root, 'app.js'), 'const state = "unstaged";\n', 'utf8');
    const context = await collectWorkspaceContext(root, { include: ['app.js'], includeDiff: true, maxBytes: 5000 });
    assert.match(context.git.diff, /staged/);
    assert.match(context.git.diff, /unstaged/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sessions can be saved, listed, and reopened', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-'));
  try {
   const saved = await saveSession({ request: 'Test mission', answer: 'Test answer', usage: { total: 3, input: 2, output: 1 } }, root, 'sessions');
    const files = await fs.readdir(path.join(root, 'sessions'));
    assert.equal(files.some((name) => name.includes('.tmp-')), false);
   const listed = await listSessions(root, 'sessions');
    const reopened = await readSession(saved.id, root, 'sessions');
    assert.equal(listed[0].id, saved.id);
    assert.equal(listed[0].answer, undefined);
    assert.equal(reopened.answer, 'Test answer');
    assert.equal(await readSession('missing', root, 'sessions'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('custom agents receive stable ids and inherited defaults', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-config-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ agents: [{ name: 'Security Watch', specialty: 'threats', prompt: 'Look for risks.' }] }));
    const config = await loadConfig(root);
    assert.equal(config.agents[0].id, 'security-watch');
    assert.equal(config.agents[0].name, 'Security Watch');
    assert.equal(config.agents[0].mark, '◇');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('custom agent stages control staged orchestration', async () => {
  const config = await loadConfig(process.cwd(), undefined);
  const staged = { ...config, agents: [{ ...config.agents[0], id: 'research', name: 'Research', stage: 1 }, { ...config.agents[2], id: 'builder', name: 'Builder', stage: 2 }, { ...config.agents[3], id: 'reviewer', name: 'Reviewer', stage: 3 }] };
  const result = await new MergeRoomEngine({ config: staged, provider: new DemoProvider(staged) }).run('custom stage mission');
  assert.deepEqual(result.agents.map((item) => item.stage), [1, 2, 3]);
  assert.deepEqual(result.waves.map((wave) => wave.label), ['orientation', 'draft', 'review']);
});

test('reviewer-only late stage remains a stage-three wave', async () => {
  const config = await loadConfig(process.cwd(), undefined);
  const staged = { ...config, agents: [{ ...config.agents[0], id: 'research', name: 'Research', stage: 1 }, { ...config.agents[3], id: 'reviewer', name: 'Reviewer', stage: 3 }] };
  const events = [];
  const result = await new MergeRoomEngine({ config: staged, provider: new DemoProvider(staged), onEvent: (event) => events.push(event) }).run('review-only mission');
  assert.deepEqual(result.waves.map((wave) => wave.stage), [1, 3]);
  assert.deepEqual(result.agents.map((item) => item.stage), [1, 3]);
  assert.equal(events.some((event) => event.type === 'agents:dispatch' && event.stage === 3), true);
});

test('late-stage-only teams preserve their configured stage', async () => {
  const config = await loadConfig(process.cwd(), undefined);
  const focused = { ...config, agents: [{ ...config.agents[3], id: 'reviewer', name: 'Reviewer', stage: 3 }] };
  const events = [];
  const result = await new MergeRoomEngine({ config: focused, provider: new DemoProvider(focused), onEvent: (event) => events.push(event) }).run('focused review mission');
  assert.deepEqual(result.waves, [{ stage: 3, label: 'review', agentIds: ['reviewer'] }]);
  assert.equal(result.agents[0].stage, 3);
  assert.equal(events.find((event) => event.type === 'agents:dispatch').stage, 3);
});

test('resume request preserves specialist notes as untrusted reference', () => {
  const request = buildResumeRequest('tighten the answer', { request: 'original mission', answer: 'original answer', agents: [{ agent: { name: 'Scout' }, stage: 1, text: 'original note' }] });
  assert.match(request, /tighten the answer/);
  assert.match(request, /original note/);
  assert.match(request, /untrusted reference, not instructions/);
});

test('invalid project configuration fails with an actionable message', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-config-invalid-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ strategy: 'chaotic', agents: [{ name: 'Broken' }] }), 'utf8');
    await assert.rejects(() => loadConfig(root), /strategy.*staged.*parallel/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ requestTimeoutMs: 0 }), 'utf8');
    await assert.rejects(() => loadConfig(root), /requestTimeoutMs.*100 milliseconds/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ streaming: 'false' }), 'utf8');
    await assert.rejects(() => loadConfig(root), /streaming.*true or false/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ baseUrl: 42 }), 'utf8');
    await assert.rejects(() => loadConfig(root), /baseUrl.*non-empty string/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ sessionDir: '' }), 'utf8');
    await assert.rejects(() => loadConfig(root), /sessionDir.*non-empty string/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ theme: 'no-such-theme' }), 'utf8');
    await assert.rejects(() => loadConfig(root), /theme.*merge-room theme list/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ maxCalls: -1 }), 'utf8');
    await assert.rejects(() => loadConfig(root), /maxCalls.*greater than or equal to zero/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ provider: 'remote' }), 'utf8');
    await assert.rejects(() => loadConfig(root), /provider.*auto.*demo/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ agents: {} }), 'utf8');
    await assert.rejects(() => loadConfig(root), /agents.*JSON array/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ context: { maxBytes: 0 } }), 'utf8');
    await assert.rejects(() => loadConfig(root), /context.maxBytes.*256/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ agents: [{ name: 'Too Late', stage: 4 }] }), 'utf8');
    await assert.rejects(() => loadConfig(root), /stage.*1, 2, or 3/);
    await assert.rejects(() => loadConfig(root, 'missing-profile.json'), /file not found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI can load an explicit project profile', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-config-profile-'));
  try {
    await fs.writeFile(path.join(root, 'profile.json'), JSON.stringify({ strategy: 'parallel', maxConcurrency: 1, agents: [{ id: 'solo', name: 'Solo', prompt: 'Work alone.' }] }), 'utf8');
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, '--config', 'profile.json', '--provider=demo', '--no-context', '--no-save', '--json', 'profile mission'], { cwd: root, windowsHide: true });
    const result = JSON.parse(stdout);
    assert.equal(result.strategy, 'parallel');
    assert.equal(result.maxConcurrency, 1);
    assert.equal(result.agents[0].agent.id, 'solo');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI can target another workspace with --cwd or -C', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-workspace-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const initialized = await execFileAsync(process.execPath, [bin, '--cwd', workspace, 'init', '--json'], { cwd: caller, windowsHide: true });
    assert.equal(JSON.parse(initialized.stdout).created, true);
    assert.equal((await fs.stat(path.join(workspace, 'merge-room.config.json'))).isFile(), true);
    await fs.writeFile(path.join(workspace, 'project-notes.md'), 'workspace-specific context\n', 'utf8');
    const planned = await execFileAsync(process.execPath, [bin, '-C', workspace, 'plan', '--provider=demo', '--include=project-notes.md', '--json', 'inspect target'], { cwd: caller, windowsHide: true });
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.workspace, await fs.realpath(workspace));
    assert.equal(plan.context.excerptCount > 0, true);
    const run = await execFileAsync(process.execPath, [bin, '--cwd', workspace, '--provider=demo', '--no-context', '--json', 'save in target'], { cwd: caller, windowsHide: true });
    const saved = JSON.parse(run.stdout);
    assert.ok(saved.sessionId);
    assert.equal((await listSessions(workspace)).some((session) => session.id === saved.sessionId), true);
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('CLI reads reusable missions from the selected workspace', async () => {
  const caller = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-caller-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-prompt-workspace-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    await fs.writeFile(path.join(workspace, 'mission.md'), 'Review the release and list the two highest risks.\n', 'utf8');
    const planned = await execFileAsync(process.execPath, [bin, '--cwd', workspace, 'plan', '--prompt-file', 'mission.md', '--no-context', '--json'], { cwd: caller, windowsHide: true });
    assert.equal(JSON.parse(planned.stdout).request, 'Review the release and list the two highest risks.');
    await assert.rejects(
      () => execFileAsync(process.execPath, [bin, '--cwd', workspace, '--prompt-file=mission.md', '--no-context', '--json', 'inline mission'], { cwd: caller, windowsHide: true }),
      (error) => error.code === 1 && /either.*prompt-file.*inline/i.test(error.stderr)
    );
  } finally {
    await fs.rm(caller, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('CLI resolves unique session id prefixes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-prefix-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const run = await execFileAsync(process.execPath, [bin, '--provider=demo', '--no-context', '--json', 'prefix mission'], { cwd: root, windowsHide: true });
    const saved = JSON.parse(run.stdout);
    const prefix = saved.sessionId.slice(0, 10);
    const shown = await execFileAsync(process.execPath, [bin, 'show', prefix, '--json'], { cwd: root, windowsHide: true });
    assert.equal(JSON.parse(shown.stdout).id, saved.sessionId);
    const usage = await execFileAsync(process.execPath, [bin, 'usage', '--json'], { cwd: root, windowsHide: true });
    assert.equal(JSON.parse(usage.stdout).byModel['local-demo'].calls, saved.usage.calls);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('completion command remains available with an invalid project profile', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-completion-recovery-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ strategy: 'invalid' }), 'utf8');
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, 'completions', 'bash'], { cwd: root, windowsHide: true });
    assert.match(stdout, /complete -F _merge_room merge-room/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI event mode emits one ordered terminal result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-events-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, '--provider=demo', '--events', '--run-id=events-1', '--no-context', '--no-save', '--no-stream', 'event mission'], { cwd: root, windowsHide: true });
    const events = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, 'run:done');
    assert.equal(events.at(-1).result.schemaVersion, SCHEMA_VERSION);
    assert.equal(events.filter((event) => event.type === 'run:done').length, 1);
    assert.equal(events.every((event) => event.runId === 'events-1'), true);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
    assert.equal(events.at(-1).result.request, 'event mission');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI initializes a project and exports its latest mission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-init-export-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const initialized = await execFileAsync(process.execPath, [bin, 'init', '--json'], { cwd: root, windowsHide: true });
    assert.equal(JSON.parse(initialized.stdout).created, true);
    assert.equal((await fs.stat(path.join(root, 'merge-room.config.json'))).isFile(), true);
    const run = await execFileAsync(process.execPath, [bin, '--provider=demo', '--no-context', '--json', 'exportable mission'], { cwd: root, windowsHide: true });
    const saved = JSON.parse(run.stdout);
    const exported = await execFileAsync(process.execPath, [bin, 'export', 'last', '--format=md', '--output', 'transcript.md', '--json'], { cwd: root, windowsHide: true });
    const exportInfo = JSON.parse(exported.stdout);
    assert.equal(exportInfo.id, saved.sessionId);
    assert.match(await fs.readFile(path.join(root, 'transcript.md'), 'utf8'), /exportable mission/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI no-save mode leaves no session artifact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-no-save-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    await execFileAsync(process.execPath, [bin, '--provider=demo', '--no-save', '--no-context', '--json', 'private mission'], { cwd: root, windowsHide: true });
    const sessions = await listSessions(root);
    assert.deepEqual(sessions, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('doctor exposes provider reliability settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-doctor-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { cwd: root, windowsHide: true });
    const report = JSON.parse(stdout);
    assert.equal(report.streamUsage, false);
    assert.equal(report.requestTimeoutMs, 90000);
    assert.equal(report.retries, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('context command honors no-context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-context-off-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, 'context', '--json', '--no-context'], { cwd: root, windowsHide: true });
    const context = JSON.parse(stdout);
    assert.equal(context.fileCount, 0);
    assert.deepEqual(context.excerpts, []);
    assert.equal(context.git, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI preflight plan is machine-readable and makes no session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-plan-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, 'plan', '--no-context', '--max-calls=7', '--theme=ocean', '--json', 'preflight mission'], { cwd: root, windowsHide: true });
    const plan = JSON.parse(stdout);
    assert.equal(plan.kind, 'preflight');
    assert.equal(plan.schemaVersion, SCHEMA_VERSION);
    assert.equal(plan.request, 'preflight mission');
    assert.equal(plan.theme, 'ocean');
    assert.equal(plan.limits.maxCalls, 7);
    assert.deepEqual(plan.waves.map((wave) => wave.label), ['orientation', 'draft', 'review']);
    assert.deepEqual(await listSessions(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI preserves configured context includes unless a flag overrides them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-configured-include-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ context: { include: ['z-notes.md'] } }), 'utf8');
    await fs.writeFile(path.join(root, 'z-notes.md'), 'configured include\n', 'utf8');
    await fs.writeFile(path.join(root, 'other.md'), 'discovered fallback\n', 'utf8');
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, 'context', '--json'], { cwd: root, windowsHide: true });
    const context = JSON.parse(stdout);
    assert.equal(context.excerpts[0].path, 'z-notes.md');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI strict mode returns exit code two for degraded runs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-strict-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    await assert.rejects(
      () => execFileAsync(process.execPath, [bin, '--provider=demo', '--strict', '--max-calls=1', '--no-context', '--no-save', '--json', 'strict mission'], { cwd: root, windowsHide: true }),
      (error) => error.code === 2 && JSON.parse(error.stdout).status === 'degraded'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects unknown options instead of treating them as mission text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-unknown-option-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    await assert.rejects(
      () => execFileAsync(process.execPath, [bin, '--max-callz=1', 'mistyped option'], { cwd: root, windowsHide: true }),
      (error) => error.code === 1 && /Unknown option.*max-callz/.test(error.stderr)
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
