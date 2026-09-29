import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { DEFAULT_CONFIG, loadConfig, safeBaseUrl, validateProviderBaseUrl, VERSION } from '../src/config.js';
import { collectWorkspaceContext, formatWorkspaceContext } from '../src/context.js';
import { buildRunPlan, MergeRoomEngine, SCHEMA_VERSION } from '../src/engine.js';
import { liquidGlassLogoLines } from '../src/logo.js';
import { AnthropicProvider, ClaudeCodeCliProvider, CodexCliProvider, createProvider, DemoProvider, OpenAICompatibleProvider, parseClaudeCodeOutput, parseCodexOutput } from '../src/providers.js';
import { formatSessionMarkdown, listSessions, readSession, saveSession, writeSessionExport } from '../src/sessions.js';
import { createLedger, estimateTokens } from '../src/tokens.js';
import { buildResumeRequest, main } from '../src/cli.js';
import { completionScript } from '../src/completions.js';
import { applyCockpitEvent, beginCockpitTurn, createCockpitState, finishCockpitTurn, resetCockpitRoom, selectCockpitRoom } from '../src/cockpit.js';
import { createCockpitRenderer, createConversationRenderer, printResult, printSession, startupPatternLines } from '../src/ui.js';
import { resolveTheme, themeSummaries, THEMES } from '../src/themes.js';

const execFileAsync = promisify(execFile);

test('CLI version matches package metadata', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(VERSION, manifest.version);
});

function runCliWithInput(args, input, cwd = process.cwd()) {
  const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

test('cockpit keeps two independent live rooms and agent activity', () => {
  const agents = DEFAULT_CONFIG.agents.slice(0, 2);
  const state = createCockpitState(agents);
  beginCockpitTurn(state, 0, 'Plan the release', agents);
  selectCockpitRoom(state, 2);
  beginCockpitTurn(state, 1, 'Review the API', agents);
  assert.equal(state.rooms.every((room) => room.running), true);
  applyCockpitEvent(state, 0, { type: 'agent:start', agent: agents[0] });
  applyCockpitEvent(state, 1, { type: 'agent:done', agent: agents[1], text: 'One risk found.', telemetry: { total: 12, calls: 1 } });
  assert.equal(state.rooms[0].statuses[agents[0].id], 'working');
  assert.equal(state.rooms[1].statuses[agents[1].id], 'done');
  assert.equal(state.rooms[1].notes[agents[1].id], 'One risk found.');
  assert.equal(state.rooms[1].usage.total, 12);
  applyCockpitEvent(state, 0, { type: 'run:done', result: { answer: 'Release answer', usage: { total: 20 } } });
  assert.equal(state.rooms[0].status, 'saving');
  assert.equal(state.rooms[0].running, true);
  finishCockpitTurn(state, 0, state.rooms[0].result);
  assert.equal(state.rooms[0].status, 'done');
  assert.equal(state.rooms[1].running, true);
  assert.throws(() => resetCockpitRoom(state, 1, agents), /working/);
  resetCockpitRoom(state, 0, agents);
  assert.equal(state.rooms[0].status, 'idle');
  assert.equal(state.rooms[1].request, 'Review the API');
});

test('cockpit renders a left activity rail and a focused room pane', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, workspace: 'C:\\project', force: true, columns: 100, rows: 28, write: (line) => lines.push(line) });
  beginCockpitTurn(renderer.state, 0, 'Plan the release', config.agents);
  applyCockpitEvent(renderer.state, 0, { type: 'agent:start', agent: config.agents[0] });
  renderer.render();
  const output = lines.join('\n');
  assert.match(output, /ROOMS/);
  assert.match(output, /Room 1/);
  assert.match(output, /Room 2/);
  assert.match(output, /Scout\s+scope & risk/);
  assert.match(output, /│.*│.*ROOM 1/);
  assert.match(output, /LIVE HANDOFFS/);
});

test('interactive CLI accepts work in both rooms from one process', async () => {
  const { stdout } = await runCliWithInput(
    ['interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream', '--team=scout'],
    'Plan release checks\n/2\nReview API risks\n/wait\n/quit\n'
  );
  assert.match(stdout, /\[Room 1\] Plan release checks/);
  assert.match(stdout, /\[Room 2\] Review API risks/);
  assert.equal((stdout.match(/Mission complete/g) || []).length, 2);
});

test('bare merge-room command opens the cockpit', async () => {
  const { stdout } = await runCliWithInput(
    ['--provider=demo', '--no-context', '--no-save', '--no-stream', '--team=scout'],
    'Map the next release\n/wait\n/quit\n'
  );
  assert.match(stdout, /\[Room 1\] Map the next release/);
  assert.match(stdout, /Mission complete/);
});

test('scripted /quit cancels active work', async () => {
  const { stdout } = await runCliWithInput(
    ['interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream', '--team=scout'],
    'Cancel this mission\n/quit\n'
  );
  assert.match(stdout, /Room 1 cancelled/);
  assert.doesNotMatch(stdout, /Mission complete/);
});

test('conversational cockpit prints its mark once and appends the chat', async () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const renderer = createConversationRenderer({ config, provider: { name: 'demo' }, workspace: 'C:\\project', force: true, write: (line) => lines.push(line) });
  await renderer.start({ animate: false });
  await renderer.start({ animate: false });
  beginCockpitTurn(renderer.state, 0, 'Plan the release', config.agents);
  renderer.user(0, 'Plan the release');
  renderer.event(0)({ type: 'agent:start', agent: config.agents[0] });
  renderer.event(0)({ type: 'agent:done', agent: config.agents[0], text: 'Check CI.', telemetry: { total: 12, calls: 1 } });
  renderer.event(0)({ type: 'run:done', result: { answer: 'Ship after CI passes.', usage: { total: 24, calls: 2 } } });
  const output = lines.join('\n');
  assert.equal((output.match(/Merge Room\s+demo\/gpt-4o-mini · two rooms/g) || []).length, 1);
  assert.equal((output.match(/▄█▀▀▀▀▀▀▀▄/g) || []).length, 1);
  assert.match(output, /Room 1 › Plan the release/);
  assert.match(output, /Scout is working/);
  assert.match(output, /Ship after CI passes\./);
  assert.doesNotMatch(output, /\x1b\[2J/);
});

test('startup mark preserves the supplied 60-column liquid-glass M', () => {
  const pattern = startupPatternLines();
  const colored = liquidGlassLogoLines();
  assert.equal(pattern.length, 21);
  assert.equal(pattern.every((line) => line.length <= 60), true);
  assert.equal(pattern[0], '     ▄█▀▀▀▀▀▀▀▄                              ▄▀▀▀▀▀▀▀▀▄');
  assert.equal(pattern[8].includes('███████████████████████████'), true);
  assert.equal(pattern[15].includes('             ▄▄▄▄             '), true);
  assert.equal(pattern.at(-1).trim(), '▀███████████▀███▀                ▀███████████████▀');
  assert.equal(colored.length, pattern.length);
  assert.equal(colored.some((line) => line.includes('\x1b[38;5;159;48;5;152m')), true);
  assert.equal(colored.some((line) => line.includes('\x1b[38;5;183;48;5;255m')), true);
});

test('completion scripts cover supported shells', () => {
  assert.match(completionScript('bash'), /complete -F _merge_room merge-room/);
  assert.match(completionScript('zsh'), /#compdef merge-room/);
  assert.match(completionScript('ps'), /Register-ArgumentCompleter/);
  assert.throws(() => completionScript('fish'), /Supported completion shells/);
  assert.match(completionScript('bash'), /--max-calls=/);
  assert.match(completionScript('bash'), /--cwd=/);
  assert.match(completionScript('bash'), /--prompt-file=/);
  assert.match(completionScript('bash'), /theme/);
  assert.match(completionScript('bash'), /providers/);
  assert.match(completionScript('zsh'), /providers/);
  assert.match(completionScript('powershell'), /providers/);
});

test('themes expose named palettes and useful aliases', () => {
  assert.equal(resolveTheme('default').id, 'merge-room');
  assert.equal(resolveTheme('highcontrast').id, 'high-contrast');
  assert.equal(resolveTheme('glass').id, 'liquid-glass');
  assert.deepEqual(themeSummaries().map((theme) => theme.id), ['merge-room', 'ocean', 'ember', 'mono', 'high-contrast', 'liquid-glass', 'graphite', 'sage', 'dusk', 'champagne']);
  for (const theme of themeSummaries()) {
    assert.equal(typeof theme.label, 'string');
    assert.equal(typeof theme.description, 'string');
    for (const key of ['reset', 'dim', 'bold', 'cyan', 'teal', 'blue', 'purple', 'magenta', 'yellow', 'red', 'green', 'white', 'gray', 'bg']) {
      assert.match(THEMES[theme.id].colors[key], /^\x1b\[/);
    }
  }
  assert.throws(() => resolveTheme('unknown'), /merge-room theme list/);
});

test('documentation screenshots show the one-time mark and scrollable conversation', async () => {
  const started = await fs.readFile(path.resolve(process.cwd(), 'docs', 'screenshots', 'merge-room-started.svg'), 'utf8');
  const mission = await fs.readFile(path.resolve(process.cwd(), 'docs', 'screenshots', 'merge-room-mission-cockpit.svg'), 'utf8');
  assert.match(started, /demo\/merge-room-demo · two rooms ·/);
  assert.match(started, /liquid-glass block Merge Room mark/);
  assert.match(mission, /Room 1 ›/);
  assert.match(mission, /Room 2 ›/);
  assert.match(mission, /scrollable conversation/);
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
  assert.equal(safeBaseUrl('https://example.com/v1?key=secret').includes('secret'), false);
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

test('saved specialist reports identify their provider profile and model', async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (line = '') => lines.push(String(line));
  const session = { request: 'Audit routes', answer: 'Complete', agents: [
    { agent: { id: 'scout', name: 'Scout' }, stage: 1, provider: 'work', model: 'gpt-main', text: 'OpenAI note.' },
    { agent: { id: 'critic', name: 'Critic' }, stage: 3, provider: 'claude', model: 'claude-sonnet', text: 'Claude note.' },
    { agent: { id: 'legacy', name: 'Legacy' }, stage: 2, text: 'Older note.' }
  ] };
  try {
    const markdown = formatSessionMarkdown(session);
    assert.match(markdown, /Scout · stage 1 · work · gpt-main/);
    assert.match(markdown, /Critic · stage 3 · claude · claude-sonnet/);
    assert.match(markdown, /### Legacy · stage 2/);
    printSession(session);
    assert.ok(lines.some((line) => line.includes('Scout · stage 1 · work · gpt-main')));
    assert.ok(lines.some((line) => line.includes('Critic · stage 3 · claude · claude-sonnet')));
    assert.ok(!lines.join('\n').includes('OPENAI_API_KEY'));
  } finally {
    console.log = originalLog;
  }
});

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

test('provider profiles route agents and lead across OpenAI and Anthropic', async () => {
  const originalFetch = globalThis.fetch;
  const oldAnthropic = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  const oldOpenAI = process.env.MERGE_ROOM_TEST_OPENAI;
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  const requests = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-routes-'));
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    const response = url.includes('anthropic.test')
      ? { content: [{ type: 'text', text: 'Claude response' }], usage: { input_tokens: 11, output_tokens: 7 } }
      : { choices: [{ message: { content: 'OpenAI response' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
    return new Response(JSON.stringify(response), { status: 200 });
  };
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      streaming: false,
      providers: {
        openai: { type: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://openai.test/v1', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' },
        claude: { type: 'anthropic', model: 'claude-test', baseUrl: 'https://anthropic.test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' }
      },
      defaultProvider: 'openai', leadProvider: 'claude',
      agents: [{ id: 'scout', provider: 'claude' }, { id: 'architect' }]
    }));
    const config = await loadConfig(root);
    const result = await new MergeRoomEngine({ config, provider: createProvider(config) }).run('route calls');
    assert.equal(requests.length, 3);
    const promptText = (call) => call.body.system || call.body.messages?.[0]?.content || '';
    const scout = requests.find((call) => promptText(call).includes('Scout'));
    const architect = requests.find((call) => promptText(call).includes('Architect'));
    const synthesis = requests.find((call) => call.body.messages?.[0]?.content?.includes('Specialist notes'));
    assert.equal(scout.url, 'https://anthropic.test/v1/messages');
    assert.equal(scout.options.headers['x-api-key'], 'anthropic-secret');
    assert.equal(scout.options.headers['anthropic-version'], '2023-06-01');
    assert.equal(architect.url, 'https://openai.test/v1/chat/completions');
    assert.equal(architect.options.headers.authorization, 'Bearer openai-secret');
    assert.equal(synthesis.url, 'https://anthropic.test/v1/messages');
    assert.equal(result.agents[0].provider, 'claude');
    assert.equal(result.agents[1].provider, 'openai');
    assert.equal(result.provider, 'claude');
    assert.equal(result.usage.input, 27);
    assert.equal(result.usage.byModel['claude/claude-test'].calls, 2);
    assert.equal(result.usage.byModel['openai/gpt-test'].calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
    if (oldAnthropic === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldAnthropic;
    if (oldOpenAI === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldOpenAI;
  }
});

test('Codex CLI profiles use bounded JSONL with read-only permissions and local sign-in', async () => {
  const oldPath = process.env.PATH;
  const oldOpenAI = process.env.OPENAI_API_KEY;
  const oldCodex = process.env.CODEX_API_KEY;
  const oldCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-codex-cli-'));
  const bin = path.join(root, 'bin');
  const probe = path.join(root, 'probe.json');
  await fs.mkdir(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  process.env.OPENAI_API_KEY = 'must-not-reach-the-cli';
  process.env.CODEX_API_KEY = 'also-must-not-reach-the-cli';
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  await fs.writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst nl = String.fromCharCode(10);\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => input += chunk);\nprocess.stdin.on('end', () => { const output = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'A read-only answer' } }) + nl + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7 } }) + nl; fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args: process.argv.slice(2), input, output, openai: process.env.OPENAI_API_KEY, codex: process.env.CODEX_API_KEY, codexHome: process.env.CODEX_HOME })); process.stdout.write(output); });\n`);
  await fs.chmod(path.join(bin, 'codex'), 0o755);
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { chatgpt: { type: 'codex-cli', model: 'gpt-test' } }, defaultProvider: 'chatgpt', agents: [{ id: 'scout', provider: 'chatgpt' }] }));
    const config = await loadConfig(root);
    assert.equal(config.providers.chatgpt.type, 'codex-cli');
    const provider = createProvider(config, root);
    assert.ok(provider.profiles.get('chatgpt') instanceof CodexCliProvider);
    let answer;
    try { answer = await provider.complete({ provider: 'chatgpt', system: 'Stay focused.', prompt: 'inspect this project', model: 'gpt-override' }); }
    catch (error) { const received = JSON.parse(await fs.readFile(probe, 'utf8')); assert.fail(`${error.message}; output=${received.output}`); }
    const received = JSON.parse(await fs.readFile(probe, 'utf8'));
    assert.equal(answer.text, 'A read-only answer');
    assert.equal(answer.provider, 'chatgpt');
    assert.equal(answer.model, 'gpt-override');
    assert.equal(answer.inputTokens, 12);
    assert.equal(answer.outputTokens, 7);
    assert.ok(received.args.includes('--json'));
    assert.ok(received.args.includes('--ephemeral'));
    assert.ok(received.args.includes('--ignore-user-config'));
    assert.ok(received.args.includes('mcp_servers={}'));
    assert.deepEqual(received.args.slice(received.args.indexOf('--sandbox'), received.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.ok(received.args.includes('-'));
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { chatgpt: { type: 'codex-cli' } }, defaultProvider: 'chatgpt', agents: [{ id: 'scout', provider: 'chatgpt' }] }));
    const defaultModelConfig = await loadConfig(root);
    const defaultModelProvider = createProvider(defaultModelConfig, root);
    const defaultModelAnswer = await defaultModelProvider.complete({ provider: 'chatgpt', system: 'Stay focused.', prompt: 'inspect this project' });
    const defaultModelCall = JSON.parse(await fs.readFile(probe, 'utf8'));
    assert.equal(defaultModelAnswer.model, 'codex-default');
    assert.equal(defaultModelCall.args.includes('--model'), false);
    assert.match(received.input, /Stay focused\.[\s\S]*inspect this project/);
    assert.equal(received.openai, undefined);
    assert.equal(received.codex, undefined);
    assert.equal(received.codexHome, process.env.CODEX_HOME);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { chatgpt: { type: 'codex-cli', apiKeyEnv: 'OPENAI_API_KEY' } } }));
    await assert.rejects(() => loadConfig(root), /codex-cli.*does not accept.*apiKeyEnv/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAI;
    if (oldCodex === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = oldCodex;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Codex JSONL parser keeps final assistant text and rejects malformed output', () => {
  const output = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Final report' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21, output_tokens: 8 } })
  ].join('\n');
  assert.deepEqual(parseCodexOutput(output), { text: 'Final report', inputTokens: 21, outputTokens: 8 });
  assert.throws(() => parseCodexOutput('{broken json}'), /malformed JSONL/);
  assert.throws(() => parseCodexOutput(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Truncated' } })), /did not include a completed turn/);
  assert.throws(() => parseCodexOutput(JSON.stringify({ type: 'turn.completed' })), /without a final assistant message/);
});

test('Claude Code CLI profiles use restricted JSON with tools and session persistence disabled', async () => {
  const oldPath = process.env.PATH;
  const oldApiKey = process.env.ANTHROPIC_API_KEY;
  const oldConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-claude-cli-'));
  const bin = path.join(root, 'bin');
  const probe = path.join(root, 'probe.json');
  await fs.mkdir(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  process.env.ANTHROPIC_API_KEY = 'must-not-reach-the-cli';
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
  await fs.writeFile(path.join(bin, 'claude'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => input += chunk);\nprocess.stdin.on('end', () => { const output = JSON.stringify({ result: 'A Claude answer', is_error: false, usage: { input_tokens: 9, output_tokens: 4 } }); fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args: process.argv.slice(2), input, output, apiKey: process.env.ANTHROPIC_API_KEY, configDir: process.env.CLAUDE_CONFIG_DIR })); process.stdout.write(output); });\n`);
  await fs.chmod(path.join(bin, 'claude'), 0o755);
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { claude: { type: 'claude-code-cli' } }, defaultProvider: 'claude', agents: [{ id: 'scout', provider: 'claude' }] }));
    const config = await loadConfig(root);
    const provider = createProvider(config, root);
    assert.ok(provider.profiles.get('claude') instanceof ClaudeCodeCliProvider);
    const answer = await provider.complete({ provider: 'claude', system: 'Stay focused.', prompt: 'review this project' });
    const received = JSON.parse(await fs.readFile(probe, 'utf8'));
    assert.equal(answer.text, 'A Claude answer');
    assert.equal(answer.model, 'claude-code-default');
    assert.equal(answer.inputTokens, 9);
    assert.equal(answer.outputTokens, 4);
    assert.ok(received.args.includes('--restricted'));
    assert.ok(received.args.includes('--no-session-persistence'));
    assert.ok(received.args.includes('--print'));
    assert.ok(received.args.includes('--output-format'));
    assert.ok(received.args.includes('--system-prompt'));
    assert.ok(received.args.includes('Stay focused.'));
    assert.ok(received.args.includes('--tools'));
    assert.equal(received.args[received.args.indexOf('--tools') + 1], '');
    assert.ok(received.args.includes('mcp__*'));
    assert.equal(received.args.includes('--model'), false);
    assert.equal(received.input, 'review this project');
    assert.equal(received.apiKey, undefined);
    assert.equal(received.configDir, process.env.CLAUDE_CONFIG_DIR);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { claude: { type: 'claude-code-cli', apiKeyEnv: 'ANTHROPIC_API_KEY' } } }));
    await assert.rejects(() => loadConfig(root), /claude-code-cli.*does not accept.*apiKeyEnv/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldApiKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldApiKey;
    if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfigDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Claude Code JSON parser rejects errors and malformed output', () => {
  assert.deepEqual(parseClaudeCodeOutput(JSON.stringify({ result: 'Final report', usage: { input_tokens: 5, output_tokens: 3 } })), { text: 'Final report', inputTokens: 5, outputTokens: 3 });
  assert.throws(() => parseClaudeCodeOutput('{broken json}'), /malformed JSON/);
  assert.throws(() => parseClaudeCodeOutput(JSON.stringify({ result: '', is_error: false })), /without a final assistant message/);
  assert.throws(() => parseClaudeCodeOutput(JSON.stringify({ result: 'failed', is_error: true })), /reported a failed turn/);
});

test('providers command reports routes and binary presence without revealing API keys', async () => {
  const oldPath = process.env.PATH;
  const oldKey = process.env.MERGE_ROOM_TEST_PROVIDER_KEY;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldMergeKey = process.env.MERGE_ROOM_API_KEY;
  const oldCwd = process.cwd();
  const originalLog = console.log;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-providers-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  await fs.writeFile(path.join(root, 'claude'), '#!/bin/sh\nexit 0\n');
  await fs.chmod(path.join(bin, 'codex'), 0o755);
  await fs.chmod(path.join(root, 'claude'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${path.delimiter}`;
  process.env.MERGE_ROOM_TEST_PROVIDER_KEY = 'never-print-this-secret';
  try {
    process.chdir(root);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: {
        api: { type: 'openai-compatible', model: 'gpt-test', apiKeyEnv: 'MERGE_ROOM_TEST_PROVIDER_KEY' },
        chatgpt: { type: 'codex-cli' },
        claude: { type: 'claude-code-cli' }
      },
      defaultProvider: 'api', leadProvider: 'claude',
      agents: [{ id: 'scout', provider: 'chatgpt' }, { id: 'maker', provider: 'claude' }]
    }));
    let output = '';
    console.log = (line) => { output = String(line); };
    await main(['providers', '--json', '--cwd', root]);
    const report = JSON.parse(output);
    assert.equal(report.defaultProvider, 'api');
    assert.equal(report.leadProvider, 'claude');
    assert.deepEqual(report.profiles[0].agents, []);
    assert.equal(report.profiles[0].configured, true);
    assert.equal(report.profiles[1].binaryAvailable, true);
    assert.deepEqual(report.profiles[1].agents, ['scout']);
    assert.equal(report.profiles[2].binaryAvailable, true);
    assert.deepEqual(report.profiles[2].agents, ['maker']);
    assert.equal(JSON.stringify(report).includes('never-print-this-secret'), false);
    await main(['providers', '--json', '--provider=demo', '--cwd', root]);
    assert.equal(JSON.parse(output).effectiveProvider.type, 'demo');
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ provider: 'demo', providers: { api: { type: 'openai-compatible', model: 'gpt-test' } } }));
    await main(['providers', '--json', '--cwd', root]);
    assert.equal(JSON.parse(output).effectiveProvider.type, 'demo');
    await fs.writeFile(path.join(root, 'merge-room.config.json'), '{}');
    process.env.OPENAI_API_KEY = 'direct-key-must-not-print';
    delete process.env.MERGE_ROOM_API_KEY;
    await main(['providers', '--json', '--cwd', root]);
    const direct = JSON.parse(output);
    assert.equal(direct.profiles.length, 0);
    assert.equal(direct.directFallback.type, 'openai-compatible');
    assert.equal(direct.directFallback.configured, true);
    assert.equal(JSON.stringify(direct).includes('direct-key-must-not-print'), false);
    delete process.env.OPENAI_API_KEY;
    await main(['providers', '--json', '--cwd', root]);
    assert.equal(JSON.parse(output).directFallback.type, 'demo');
  } finally {
    process.chdir(oldCwd);
    console.log = originalLog;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_PROVIDER_KEY; else process.env.MERGE_ROOM_TEST_PROVIDER_KEY = oldKey;
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAIKey;
    if (oldMergeKey === undefined) delete process.env.MERGE_ROOM_API_KEY; else process.env.MERGE_ROOM_API_KEY = oldMergeKey;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI profile override routes every agent and lead through the selected profile', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const oldKey = process.env.MERGE_ROOM_TEST_OPENAI;
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  const requests = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-profile-override-'));
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Routed response' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  let output = '';
  console.log = (line) => { output += `${line}\n`; };
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      streaming: false,
      providers: {
        claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'UNSET_TEST_KEY' },
        work: { type: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://openai.test/v1', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' }
      },
      defaultProvider: 'claude', leadProvider: 'claude',
      agents: [{ id: 'scout', provider: 'claude' }, { id: 'critic', provider: 'claude', stage: 3 }]
    }));
    await main(['--cwd', root, '--profile=work', '--no-context', '--no-save', '--no-stream', '--json', 'switch provider'], { signal: new AbortController().signal });
    const result = JSON.parse(output);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.url === 'https://openai.test/v1/chat/completions'));
    assert.ok(result.agents.every((agent) => agent.provider === 'work'));
    assert.equal(result.provider, 'work');
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldKey;
  }
});

test('cockpit can switch provider profiles without resetting room context', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const oldOpenAI = process.env.MERGE_ROOM_TEST_OPENAI;
  const oldAnthropic = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  const requests = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-profiles-'));
  let output = '';
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['/team scout\nFirst provider turn\n/wait\n/profile claude\nSecond provider turn\n/wait\n/quit\n']) });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const body = url.includes('/v1/messages')
      ? { content: [{ type: 'text', text: 'Claude answer' }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { choices: [{ message: { content: 'OpenAI answer' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  console.log = (line) => { output += `${line}\n`; };
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      streaming: false,
      providers: {
        openai: { type: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://openai.test/v1', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' },
        claude: { type: 'anthropic', model: 'claude-test', baseUrl: 'https://anthropic.test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' }
      },
      defaultProvider: 'openai', leadProvider: 'openai',
      agents: [{ id: 'scout', provider: 'claude' }]
    }));
    await main(['--cwd', root, 'interactive', '--no-context', '--no-save', '--no-stream'], { signal: new AbortController().signal });
    assert.equal(requests.length, 4);
    assert.equal(requests[0].url, 'https://anthropic.test/v1/messages');
    assert.equal(requests[1].url, 'https://openai.test/v1/chat/completions');
    assert.ok(requests.slice(2).every((request) => request.url === 'https://anthropic.test/v1/messages'));
    assert.match(output, /Second provider turn/);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
    if (oldOpenAI === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldOpenAI;
    if (oldAnthropic === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldAnthropic;
  }
});

test('named OpenAI profile uses its endpoint, API key, and model', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_ROOM_TEST_OPENAI;
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openai.test/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer openai-secret');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, 'gpt-profile');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OpenAI response' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
  };
  try {
    const config = { ...DEFAULT_CONFIG, providers: { work: { type: 'openai-compatible', model: 'gpt-profile', baseUrl: 'https://openai.test/v1', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' } } };
    const response = await createProvider(config).complete({ provider: 'work', system: 'system', prompt: 'prompt' });
    assert.equal(response.text, 'OpenAI response');
    assert.equal(response.provider, 'work');
    assert.equal(response.model, 'gpt-profile');
    assert.equal(response.inputTokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldKey;
  }
});

test('Anthropic adapter streams text and provider usage metadata', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 13 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude' } },
    { type: 'message_delta', usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const config = { ...DEFAULT_CONFIG, providers: { claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' } } };
    const deltas = [];
    const response = await createProvider(config).complete({ system: 'system', prompt: 'prompt', provider: 'claude', onDelta: (delta) => deltas.push(delta) });
    assert.equal(response.text, 'Hello Claude');
    assert.deepEqual(deltas, ['Hello ', 'Claude']);
    assert.equal(response.inputTokens, 13);
    assert.equal(response.outputTokens, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldKey;
  }
});

test('Anthropic adapter retries transient failures and times out', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'try again' } }), { status: 503 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'recovered' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  try {
    const config = { ...DEFAULT_CONFIG, retries: 1, providers: { claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' } } };
    const response = await createProvider(config).complete({ provider: 'claude', system: 'system', prompt: 'prompt' });
    assert.equal(calls, 2);
    assert.equal(response.text, 'recovered');
    globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const timeoutConfig = { ...config, requestTimeoutMs: 100, retries: 0 };
    await assert.rejects(() => createProvider(timeoutConfig).complete({ provider: 'claude', system: 'system', prompt: 'prompt' }), { name: 'TimeoutError' });
    let cancelledCalls = 0;
    globalThis.fetch = async (_url, { signal }) => {
      cancelledCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
    };
    const abortDuringBackoff = new AbortController();
    const retrying = createProvider(config).complete({ provider: 'claude', system: 'system', prompt: 'prompt', signal: abortDuringBackoff.signal });
    setTimeout(() => abortDuringBackoff.abort(), 20);
    await assert.rejects(() => retrying, { name: 'AbortError' });
    assert.equal(cancelledCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldKey;
  }
});

test('provider profiles reject inline keys and unknown agent routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-profile-validation-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { claude: { type: 'anthropic', apiKey: 'do-not-store' } } }));
    await assert.rejects(() => loadConfig(root), /unsupported field.*reference them with apiKeyEnv/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { claude: { type: 'anthropic' } }, agents: [{ id: 'scout', provider: 'missing' }] }));
    await assert.rejects(() => loadConfig(root), /must name a configured provider profile/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('provider endpoints require secure transport and reject URL credentials', async () => {
  for (const url of ['http://api.example.test/v1', 'ftp://api.example.test/v1', 'https://user:secret@example.test/v1', 'https://@api.example.test/v1', 'https://api.example.test/v1?token=secret', 'https://api.example.test/v1?', 'https://api.example.test/v1#fragment', 'https://api.example.test/v1#', ' https://api.example.test/v1']) {
    assert.throws(() => validateProviderBaseUrl(url, 'profile endpoint'));
  }
  assert.equal(validateProviderBaseUrl('https://gateway.example.test/company/v1/'), 'https://gateway.example.test/company/v1');
  assert.equal(validateProviderBaseUrl('http://localhost:8000/v1'), 'http://localhost:8000/v1');
  assert.equal(validateProviderBaseUrl('http://127.0.0.2:8000/v1'), 'http://127.0.0.2:8000/v1');
  assert.equal(validateProviderBaseUrl('http://[::1]:8000/v1'), 'http://[::1]:8000/v1');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-profile-endpoint-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ providers: { untrusted: { type: 'anthropic', baseUrl: 'http://api.example.test' } } }));
    await assert.rejects(() => loadConfig(root), /provider profile `untrusted` baseUrl.*HTTPS/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  assert.throws(() => new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'http://api.example.test/v1' }, 'secret'), /HTTPS/);

  const loadConfigScript = "import('./src/config.js').then(({loadConfig}) => loadConfig(process.argv[1]))";
  await assert.rejects(
    () => execFileAsync(process.execPath, ['--input-type=module', '-e', loadConfigScript, root], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, MERGE_ROOM_BASE_URL: 'http://api.example.test/v1' } }),
    (error) => /HTTPS/.test(error.stderr)
  );
});

test('CLI base-url overrides fallback endpoints while named profile endpoints take precedence', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const oldKey = process.env.MERGE_ROOM_TEST_OPENAI;
  const oldAnthropic = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  const requests = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-profile-base-override-'));
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    const body = url.endsWith('/v1/messages')
      ? { content: [{ type: 'text', text: 'override worked' }] }
      : { choices: [{ message: { content: 'override worked' } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  console.log = () => {};
  try {
    process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: {
        work: { type: 'openai-compatible', model: 'gpt-test', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' },
        claude: { type: 'anthropic', model: 'claude-test', baseUrl: 'https://anthropic.example', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' }
      },
      defaultProvider: 'work', leadProvider: 'claude',
      agents: [{ id: 'scout', provider: 'claude' }, { id: 'critic', provider: 'work', stage: 3 }]
    }));
    await main(['--cwd', root, '--base-url=https://override.example/v1', '--no-context', '--no-save', '--no-stream', 'override endpoint'], { signal: new AbortController().signal });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests, ['https://anthropic.example/v1/messages', 'https://override.example/v1/chat/completions', 'https://anthropic.example/v1/messages']);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldKey;
    if (oldAnthropic === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldAnthropic;
  }
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

test('provider stream failures do not retry after emitting partial output', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      provider: new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.openai.com/v1', retries: 2 }, 'openai-secret'),
      frame: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      recovered: 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
      terminator: 'data: [DONE]\n\n'
    },
    {
      provider: new AnthropicProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.anthropic.com', retries: 2 }, 'anthropic-secret'),
      frame: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      recovered: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"recovered"}}\n\n',
      terminator: 'data: {"type":"message_stop"}\n\n'
    }
  ];
  try {
    for (const { provider, frame, recovered, terminator } of cases) {
      let calls = 0;
      const deltas = [];
      globalThis.fetch = async () => {
        calls += 1;
        let sent = false;
        const body = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(frame)); } else controller.error(new Error('stream disconnected')); } }, { highWaterMark: 0 });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
      await assert.rejects(() => provider.complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => deltas.push(delta) }), /stream disconnected/);
      assert.equal(calls, 1);
      assert.deepEqual(deltas, ['partial']);

      calls = 0;
      deltas.length = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) {
          const body = new ReadableStream({ pull(controller) { controller.error(new Error('early stream disconnect')); } }, { highWaterMark: 0 });
          return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(`${recovered}${terminator}`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
      const response = await provider.complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => deltas.push(delta) });
      assert.equal(calls, 2);
      assert.equal(response.text, 'recovered');
      assert.deepEqual(deltas, ['recovered']);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('provider stream rejects a clean close before its protocol completion marker', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      provider: new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.openai.com/v1', retries: 2 }, 'openai-secret'),
      frame: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      error: /ended before \[DONE\]/
    },
    {
      provider: new AnthropicProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.anthropic.com', retries: 2 }, 'anthropic-secret'),
      frame: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      error: /ended before message_stop/
    }
  ];
  try {
    for (const { provider, frame, error } of cases) {
      let calls = 0;
      const deltas = [];
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
      await assert.rejects(() => provider.complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => deltas.push(delta) }), error);
      assert.equal(calls, 1);
      assert.deepEqual(deltas, ['partial']);
    }
  } finally { globalThis.fetch = originalFetch; }
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

test('workspace context prioritizes files inside explicitly included directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-include-directory-'));
  try {
    await fs.mkdir(path.join(root, 'z-scope', 'private'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'z-scope/ignored.js\nprivate\n!**/keep.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'a-notes.md'), 'discovered first\n', 'utf8');
    await fs.writeFile(path.join(root, 'z-scope', 'app.js'), 'included first\n', 'utf8');
    await fs.writeFile(path.join(root, 'z-scope', 'ignored.js'), 'ignored by project rules\n', 'utf8');
    await fs.writeFile(path.join(root, 'z-scope', 'private', 'notes.md'), 'ignored directory contents\n', 'utf8');
    await fs.writeFile(path.join(root, 'z-scope', 'private', 'keep.md'), 'explicitly unignored\n', 'utf8');

    const context = await collectWorkspaceContext(root, { include: ['z-scope'], maxFiles: 3, maxBytes: 5000 });
    assert.equal(context.entries.length, 3);
    assert.match(context.entries[0], /^z-scope\/app\.js\s+/);
    assert.equal(context.entries.some((entry) => entry.includes('ignored.js')), false);
    assert.equal(context.entries.some((entry) => entry.includes('private/notes.md')), false);
    assert.equal(context.entries.some((entry) => entry.includes('keep.md')), true);
    assert.equal(context.excerpts[0].path, 'z-scope/app.js');

    const ignoredInclude = await collectWorkspaceContext(root, { include: ['z-scope/private'], maxFiles: 20, maxBytes: 5000 });
    assert.equal(ignoredInclude.entries.some((entry) => entry.includes('private/notes.md')), false);
    assert.equal(ignoredInclude.entries.some((entry) => entry.includes('keep.md')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context respects project ignore patterns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-'));
  try {
    await fs.mkdir(path.join(root, 'cache'), { recursive: true });
    await fs.mkdir(path.join(root, 'archive'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), '*.log\ncache/\n!/cache/keep.json\narchive/\n!*.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'visible.md'), 'keep me\n', 'utf8');
    await fs.writeFile(path.join(root, 'debug.log'), 'skip me\n', 'utf8');
    await fs.writeFile(path.join(root, 'cache', 'result.json'), 'skip me too\n', 'utf8');
    await fs.writeFile(path.join(root, 'cache', 'keep.json'), 'keep me too\n', 'utf8');
    await fs.writeFile(path.join(root, 'archive', 'reinclude.md'), 'must stay ignored under an ignored directory\n', 'utf8');
    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('debug.log')), false);
    assert.equal(context.entries.some((entry) => entry.includes('result.json')), false);
   assert.equal(context.entries.some((entry) => entry.includes('visible.md')), true);
    assert.equal(context.entries.some((entry) => entry.includes('keep.json')), true);
    assert.equal(context.entries.some((entry) => entry.includes('archive/reinclude.md')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context matches root files for leading gitignore globstars', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-globstar-'));
  try {
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), '**/*.generated.js\n', 'utf8');
    await fs.writeFile(path.join(root, 'root.generated.js'), 'skip root\n', 'utf8');
    await fs.writeFile(path.join(root, 'nested', 'child.generated.js'), 'skip nested\n', 'utf8');
    await fs.writeFile(path.join(root, 'keep.js'), 'keep\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('root.generated.js')), false);
    assert.equal(context.entries.some((entry) => entry.includes('child.generated.js')), false);
    assert.equal(context.entries.some((entry) => entry.includes('keep.js')), true);
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

test('legacy saved-session resume clips oversized answers and notes', () => {
  const request = buildResumeRequest('continue safely', {
    request: 'legacy project goal',
    answer: 'a'.repeat(20000),
    agents: [{ agent: { name: 'Scout' }, stage: 1, text: 'b'.repeat(20000) }]
  });
  assert.match(request, /legacy project goal/);
  assert.match(request, /continue safely/);
  assert.ok(request.length < 13000);
  assert.doesNotMatch(request, /a{1000}/);
  assert.doesNotMatch(request, /b{1000}/);
});

test('resume request carries bounded multi-turn project history', () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({ request: `request ${index}`, answer: `answer ${index}`, agents: [{ name: 'Scout', stage: 1, text: `note ${index}` }] }));
  const request = buildResumeRequest('continue the project', { request: 'latest request', answer: 'latest answer', agents: [{ agent: { name: 'Critic' }, text: 'latest note' }], conversation });
  assert.match(request, /continue the project/);
  assert.match(request, /Original project goal \(first turn\):\nrequest 0/);
  assert.match(request, /request 19/);
  assert.match(request, /latest request/);
  assert.match(request, /latest note/);
  assert.match(request, /omitted to stay within the context bound/);
  assert.ok(request.length < 13000);
});

test('cockpit and saved resume retain earlier project turns', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const oldKey = process.env.MERGE_ROOM_TEST_OPENAI;
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  const prompts = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-conversation-chain-'));
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['First alpha anchor\n/wait\nSecond beta bridge\n/wait\nThird gamma current\n/wait\n/quit\n']) });
  globalThis.fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A durable answer' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  console.log = () => {};
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      streaming: false,
      providers: { work: { type: 'openai-compatible', model: 'gpt-test', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' } },
      defaultProvider: 'work',
      agents: [{ id: 'scout', provider: 'work' }]
    }));
    await main(['--cwd', root, 'interactive', '--no-context', '--no-stream'], { signal: new AbortController().signal });
    assert.equal(prompts.length, 6);
    assert.match(prompts[4], /First alpha anchor/);
    assert.match(prompts[4], /Second beta bridge/);
    const sessions = await listSessions(root);
    assert.equal(sessions.length, 3);
    const latestSummary = sessions.find((session) => session.request === 'Third gamma current');
    const latest = await readSession(latestSummary.id, root);
    assert.deepEqual(latest.conversation.map((turn) => turn.request), ['First alpha anchor', 'Second beta bridge']);

    prompts.length = 0;
    await main(['--cwd', root, 'resume', latest.id, 'Fourth delta follow-up', '--no-context', '--no-stream'], { signal: new AbortController().signal });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /First alpha anchor/);
    assert.match(prompts[0], /Second beta bridge/);
    assert.match(prompts[0], /Third gamma current/);
    const resumedSessions = await listSessions(root);
    const resumedSummary = resumedSessions.find((session) => session.request === 'Fourth delta follow-up');
    const resumed = await readSession(resumedSummary.id, root);
    assert.equal(resumed.request, 'Fourth delta follow-up');
    assert.deepEqual(resumed.conversation.map((turn) => turn.request), ['First alpha anchor', 'Second beta bridge', 'Third gamma current']);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldKey;
  }
});

test('cockpit conversation history stays in its room and /new clears it', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const oldKey = process.env.MERGE_ROOM_TEST_OPENAI;
  process.env.MERGE_ROOM_TEST_OPENAI = 'openai-secret';
  const prompts = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-room-history-'));
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([
    'Room one anchor\n/wait\n/2\nRoom two anchor\n/wait\n/1\nRoom one follow-up\n/wait\n/2\nRoom two follow-up\n/wait\n/1\n/new\nFresh room one mission\n/wait\n/quit\n'
  ]) });
  globalThis.fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A durable answer' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  console.log = () => {};
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      streaming: false,
      providers: { work: { type: 'openai-compatible', model: 'gpt-test', apiKeyEnv: 'MERGE_ROOM_TEST_OPENAI' } },
      defaultProvider: 'work',
      agents: [{ id: 'scout', provider: 'work' }]
    }));
    await main(['--cwd', root, 'interactive', '--no-context', '--no-stream', '--no-save'], { signal: new AbortController().signal });
    assert.equal(prompts.length, 10);
    assert.match(prompts[4], /Room one anchor/);
    assert.doesNotMatch(prompts[4], /Room two anchor/);
    assert.match(prompts[6], /Room two anchor/);
    assert.doesNotMatch(prompts[6], /Room one anchor/);
    assert.doesNotMatch(prompts[8], /Room one anchor|Room one follow-up/);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_OPENAI;
    else process.env.MERGE_ROOM_TEST_OPENAI = oldKey;
  }
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

test('project configuration rejects unknown top-level options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-config-unknown-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ maxConcurency: 2 }), 'utf8');
    await assert.rejects(() => loadConfig(root), /unknown option: `maxConcurency`/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ context: { maxByte: 4096 } }), 'utf8');
    await assert.rejects(() => loadConfig(root), /unknown context option: `maxByte`/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ context: { include: 'README.md' } }), 'utf8');
    await assert.rejects(() => loadConfig(root), /context.include.*array of non-empty file paths/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ context: { include: [42] } }), 'utf8');
    await assert.rejects(() => loadConfig(root), /context.include.*array of non-empty file paths/);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ context: { include: ['README.md'] } }), 'utf8');
    assert.deepEqual((await loadConfig(root)).context.include, ['README.md']);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf8');
    const config = await loadConfig(root);
    assert.equal(config.maxConcurrency, DEFAULT_CONFIG.maxConcurrency);
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

test('CLI preflight plan resolves effective provider models for agents and lead', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-plan-routes-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: {
        work: { type: 'openai-compatible', model: 'gpt-work' },
        review: { type: 'anthropic', model: 'claude-review' }
      },
      defaultProvider: 'work',
      leadProvider: 'review',
      agents: [
        { id: 'scout', name: 'Scout', stage: 1 },
        { id: 'critic', name: 'Critic', stage: 3, provider: 'review' },
        { id: 'maker', name: 'Maker', stage: 2, provider: 'review', model: 'custom-review' }
      ]
    }));
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, '-C', root, 'plan', '--no-context', '--json', 'route audit'], { cwd: root, windowsHide: true });
    const plan = JSON.parse(stdout);
    assert.equal(plan.defaultProvider, 'work');
    assert.equal(plan.leadProvider, 'review');
    assert.equal(plan.model, 'claude-review');
    assert.deepEqual(plan.agents.map(({ provider, model }) => [provider, model]), [
      ['work', 'gpt-work'], ['review', 'claude-review'], ['review', 'custom-review']
    ]);
    assert.equal(plan.waves.flatMap((wave) => wave.agents).find((agent) => agent.id === 'critic').model, 'claude-review');

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      provider: 'demo',
      providers: { work: { type: 'openai-compatible', model: 'gpt-work' } },
      defaultProvider: 'work', leadProvider: 'work',
      agents: [{ id: 'scout', name: 'Scout', stage: 1, provider: 'work' }]
    }));
    const forced = await execFileAsync(process.execPath, [bin, '-C', root, 'plan', '--no-context', '--json', 'demo audit'], { cwd: root, windowsHide: true });
    const demoPlan = JSON.parse(forced.stdout);
    assert.equal(demoPlan.configuredProfilesBypassed, true);
    assert.equal(demoPlan.effectiveLeadProvider, 'demo');
    assert.equal(demoPlan.model, 'local-demo');
    assert.deepEqual([demoPlan.agents[0].provider, demoPlan.agents[0].configuredProvider, demoPlan.agents[0].model], ['demo', 'work', 'local-demo']);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: { codex: { type: 'codex-cli' }, claude: { type: 'claude-code-cli' } },
      defaultProvider: 'codex', leadProvider: 'claude',
      agents: [{ id: 'scout', name: 'Scout', stage: 1, provider: 'codex' }, { id: 'critic', name: 'Critic', stage: 3, provider: 'claude' }]
    }));
    const native = await execFileAsync(process.execPath, [bin, '-C', root, 'plan', '--no-context', '--json', 'native audit'], { cwd: root, windowsHide: true });
    const nativePlan = JSON.parse(native.stdout);
    assert.equal(nativePlan.model, null);
    assert.equal(nativePlan.modelSource, 'cli-default');
    assert.deepEqual(nativePlan.agents.map(({ provider, model, modelSource }) => [provider, model, modelSource]), [
      ['codex', null, 'cli-default'], ['claude', null, 'cli-default']
    ]);
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
