import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { DEFAULT_CONFIG, loadConfig, safeBaseUrl, validateProviderBaseUrl, VERSION, writeStarterConfig } from '../src/config.js';
import { collectWorkspaceContext, formatWorkspaceContext } from '../src/context.js';
import { buildRunPlan, MergeRoomEngine, SCHEMA_VERSION } from '../src/engine.js';
import { liquidGlassLogoLines } from '../src/logo.js';
import { AnthropicProvider, ClaudeCodeCliProvider, CodexCliProvider, createProvider, DemoProvider, OpenAICompatibleProvider, parseClaudeCodeOutput, parseCodexOutput } from '../src/providers.js';
import { formatSessionMarkdown, listSessions, readSession, saveSession, selectNewestSessionNames, selectNewestSessionSummaries, writeSessionExport } from '../src/sessions.js';
import { createLedger, estimateTokens } from '../src/tokens.js';
import { buildResumeRequest, cockpitHelpMorePage, cockpitHelpMorePages, main } from '../src/cli.js';
import { completionScript } from '../src/completions.js';
import { applyCockpitEvent, beginCockpitTurn, createCockpitState, finishCockpitTurn, resetCockpitRoom, resolveAgentReference, restoreAgentStatuses, selectCockpitRoom, waitForCockpitTasks } from '../src/cockpit.js';
import { createCockpitRenderer, createConversationRenderer, printResult, printSession, startupPatternLines } from '../src/ui.js';
import { resolveTheme, themeSummaries, THEMES } from '../src/themes.js';

const execFileAsync = promisify(execFile);

test('CLI version matches package metadata', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(VERSION, manifest.version);
});

function runCliWithInput(args, input, cwd = process.cwd(), timeoutMs = 30_000) {
  const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error(`CLI timed out after ${timeoutMs}ms. Args: ${JSON.stringify(args)}\nStdout: ${stdout}\nStderr: ${stderr}`));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => code === 0 ? finish(null, { stdout, stderr }) : finish(new Error(`CLI exited ${code}. Args: ${JSON.stringify(args)}\nStdout: ${stdout}\nStderr: ${stderr}`)));
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

test('cockpit agent lookup prefers an exact ID over another agent name', () => {
  const agents = [
    { id: 'first', name: 'Scout' },
    { id: 'scout', name: 'Researcher' },
    { id: 'indexer', name: 'Indexer' },
    { id: 'ipek', name: 'İpek' }
  ];
  assert.equal(resolveAgentReference(agents, 'SCOUT')?.name, 'Researcher');
  assert.equal(resolveAgentReference(agents, 'researcher')?.id, 'scout');
  assert.equal(resolveAgentReference(agents, 'INDEXER')?.id, 'indexer');
  assert.equal(resolveAgentReference(agents, 'İPEK')?.id, 'ipek');
  assert.equal(resolveAgentReference(agents, 'unknown'), null);
});

test('cockpit restores statuses only for the current team', () => {
  const currentTeam = [{ id: 'scout' }, { id: 'maker' }];
  const savedAgents = [
    { agent: { id: 'scout' }, status: 'done' },
    { agent: { id: 'critic' }, status: 'error' }
  ];
  assert.deepEqual(restoreAgentStatuses(currentTeam, savedAgents), { scout: 'done', maker: 'idle' });
});

test('cockpit wait includes tasks added while existing work is finishing', async () => {
  const tasks = new Map();
  let finishFirst;
  let finishSecond;
  const first = new Promise((resolve) => { finishFirst = resolve; }).finally(() => {
    tasks.delete('first');
    const second = new Promise((resolve) => { finishSecond = resolve; }).finally(() => tasks.delete('second'));
    tasks.set('second', second);
  });
  tasks.set('first', first);

  const waiting = waitForCockpitTasks(tasks);
  finishFirst();
  await Promise.resolve();
  assert.equal(tasks.has('second'), true);
  finishSecond();
  await waiting;
  assert.equal(tasks.size, 0);
});

test('cockpit wait catches work queued in the same readline turn while idle', async () => {
  const tasks = new Map();
  let finishMission;
  let finished = false;
  const waiting = waitForCockpitTasks(tasks).then(() => { finished = true; });
  const mission = new Promise((resolve) => { finishMission = resolve; }).finally(() => tasks.delete('mission'));
  tasks.set('mission', mission);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  finishMission();
  await waiting;
  assert.equal(tasks.size, 0);
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
  assert.match(output, /Scout\s+working · s/);
  assert.match(output, /│.*│.*ROOM 1/);
  assert.match(output, /LIVE HANDOFFS/);
});

test('Cockpit dashboard shows agents added after startup team filtering', () => {
  const lines = [];
  const allAgents = [
    { id: 'scout', name: 'Scout', specialty: 'Research', color: 'cyan' },
    { id: 'critic', name: 'Critic', specialty: 'Review', color: 'magenta' }
  ];
  const startupConfig = { ...DEFAULT_CONFIG, agents: allAgents.slice(0, 1) };
  let activeConfig = startupConfig;
  const renderer = createCockpitRenderer({
    config: startupConfig,
    getConfig: () => activeConfig,
    provider: { name: 'demo' },
    force: true,
    columns: 100,
    rows: 28,
    write: (line) => lines.push(line)
  });
  activeConfig = { ...startupConfig, agents: allAgents };
  beginCockpitTurn(renderer.state, 0, 'Review the proposal', activeConfig.agents);
  renderer.render();

  assert.match(lines.join('\n'), /Critic\s+queued/);
});

test('compact cockpit keeps an answer preview inside a short terminal', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 60, rows: 8, write: (line) => lines.push(line) });
  const room = renderer.state.rooms[0];
  room.request = 'Keep the release moving';
  room.notes[config.agents[0].id] = 'Build and review are aligned';
  room.events.push({ message: 'Latest event: ready to ship' });
  room.final = 'Answer remains visible';

  renderer.render();

  const output = lines.join('\n');
  assert.match(output, /Room 1: idle/);
  assert.match(output, /Room 2: idle/);
  assert.match(output, /Mission: Keep the release moving/);
  assert.match(output, /Handoff: Build and review/);
  assert.match(output, /Latest: Latest event:/);
  assert.match(output, /Answer: Answer remains visible/);
  assert.equal(lines.length, 7);
});

test('compact cockpit previews the other room mission when the status row has room', () => {
  for (const { columns, expectPreview } of [{ columns: 60, expectPreview: true }, { columns: 43, expectPreview: false }]) {
    const lines = [];
    const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
    const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns, rows: 8, write: (line) => lines.push(line) });
    renderer.state.rooms[1].request = 'Review the other release';

    renderer.render();

    const output = lines.join('\n');
    assert.ok(output.includes('Room 1: idle') || output.includes('1:idle'));
    assert.ok(output.includes('Room 2: idle') || output.includes('2:idle'));
    assert.equal(output.includes('Other: Review'), expectPreview);
  }
});

test('compact cockpit preserves an answer preview when one row shorter', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 60, rows: 7, write: (line) => lines.push(line) });
  const room = renderer.state.rooms[0];
  room.request = 'Keep the release moving';
  room.notes[config.agents[0].id] = 'Build and review are aligned';
  room.events.push({ message: 'Latest event: ready to ship' });
  room.final = 'Answer remains visible';

  renderer.render();

  assert.match(lines.join('\n'), /Answer: Answer remains visible/);
  assert.equal(lines.length, 6);
});

test('compact Cockpit marks omitted answer text while keeping the latest tail', () => {
  const lines = [];
  const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns: 60, rows: 8, write: (line) => lines.push(line) });
  renderer.state.rooms[0].request = 'Review the release';
  renderer.state.rooms[0].final = ['ANSWER-START', ...Array.from({ length: 12 }, (_, index) => `middle answer line ${index + 1}`), 'ANSWER-END'].join('\n');

  renderer.render();

  const output = lines.join('\n');
  assert.match(output, /earlier omitted/);
  assert.doesNotMatch(output, /ANSWER-START/);
  assert.match(output, /ANSWER-END/);
  assert.ok(lines.some((line) => /earlier omitted.*ANSWER-END/.test(line)), 'the one-row preview keeps its marker and latest answer tail together');
  assert.ok(lines.every((line) => line.length <= 60));
  assert.ok(lines.length <= 7);
});

test('compact Cockpit reserves an answer row when mission and handoff details fill the pane', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 60, rows: 9, write: (line) => lines.push(line) });
  const room = renderer.state.rooms[0];
  room.request = 'Review the release';
  room.notes[config.agents[0].id] = 'Build checks are green';
  room.events.push({ message: 'Latest event: review finished' });
  room.final = ['ANSWER-START', ...Array.from({ length: 12 }, (_, index) => `middle answer line ${index + 1}`), 'ANSWER-END'].join('\n');

  renderer.render();

  const output = lines.join('\n');
  assert.match(output, /Mission: Review the release/);
  assert.match(output, /Handoff:.*Latest:/);
  assert.doesNotMatch(output, /ANSWER-START/);
  assert.ok(lines.some((line) => /earlier omitted.*ANSWER-END/.test(line)), 'the latest answer tail remains visible beside its omission marker');
  assert.ok(lines.every((line) => line.length <= 60));
  assert.ok(lines.length <= 8);
});

test('wide Cockpit marks omitted answer text when only one answer row remains', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 2) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 100, rows: 25, write: (line) => lines.push(line) });
  const room = renderer.state.rooms[0];
  room.request = 'Review this release request carefully '.repeat(5);
  room.notes[config.agents[0].id] = 'First handoff';
  room.notes[config.agents[1].id] = 'Second handoff';
  room.events.push(...Array.from({ length: 2 }, (_, index) => ({ time: '12:00:00', message: `Run event ${index + 1}` })));
  room.error = 'Lead synthesis failed';
  room.final = ['ANSWER-START', ...Array.from({ length: 12 }, (_, index) => `middle answer line ${index + 1}`), 'ANSWER-END'].join('\n');

  renderer.render();

  const output = lines.join('\n');
  assert.match(output, /earlier omitted/);
  assert.doesNotMatch(output, /ANSWER-START/);
  assert.match(output, /ANSWER-END/);
  assert.ok(lines.some((line) => /earlier omitted.*ANSWER-END/.test(line)), 'the one-row preview keeps its marker and latest answer tail together');
  assert.ok(lines.every((line) => line.length <= 100));
  assert.ok(lines.length <= 24);
});

test('compact Cockpit history exposes short load references at 13 and 8 columns', () => {
  const historyEntries = [
    { id: '2026-09-29T22-15-10-123-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa1f0', reference: '@1', request: 'Repair the parser' },
    { id: '2026-09-29T22-15-10-456-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb2e1', reference: '@2', request: 'Review login flow' },
    { id: '2026-09-29T22-15-11-789-cccccccc-cccc-4ccc-8ccc-ccccccccc3d2', reference: '@3', request: 'Document release steps' }
  ];
  for (const columns of [13, 8]) {
    const rows = 9;
    const lines = [];
    const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns, rows, write: (line) => lines.push(line) });
    renderer.state.historyEntries = historyEntries;
    renderer.state.message = `Recent: ${historyEntries.map((item) => `${item.id} ${item.request}`).join(' · ')}`;

    renderer.render();

    const output = lines.join('\n');
    const compactOutput = output.replace(/\s/g, '');
    for (const entry of historyEntries) assert.ok(compactOutput.includes(entry.reference), `history reference ${entry.reference} at ${columns} columns`);
    assert.ok(compactOutput.includes('/show@n'), `load syntax should be visible at ${columns} columns`);
    assert.ok(lines.every((line) => line.length <= columns), `history output should fit ${columns} columns`);
    assert.ok(lines.length <= rows - 1, `history output should fit the ${rows}-row viewport`);
  }

  const wideLines = [];
  const wideRenderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns: 108, rows: 28, write: (line) => wideLines.push(line) });
  wideRenderer.state.historyEntries = historyEntries;
  const wideMessage = `Recent: ${historyEntries.map((item) => `${item.id} ${item.request.slice(0, 18)}`).join(' · ')}`;
  wideRenderer.state.message = wideMessage;
  wideRenderer.render();
  assert.ok(wideLines.join('\n').includes(historyEntries[0].id), 'wide Cockpit should retain the existing full-ID history message');
});

test('Cockpit history aliases load a listed session despite an older ID suffix collision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-history-short-ref-'));
  const sessionDir = path.join(root, '.merge-room', 'sessions');
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalLog = console.log;
  const output = [];
  const firstId = '2026-09-29T22-15-10-123-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa1f0';
  const secondId = '2026-09-29T22-15-10-456-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb2e1';
  const thirdId = '2026-09-29T22-15-11-789-cccccccc-cccc-4ccc-8ccc-ccccccccc3d2';
  const olderCollisionId = '2026-09-29T22-14-00-000-dddddddd-dddd-4ddd-8ddd-aaaaaaaaa1f0';
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    for (const [id, request] of [[firstId, 'Repair the parser'], [secondId, 'Review login flow'], [thirdId, 'Document release steps'], [olderCollisionId, 'Older hidden collision']]) {
      await fs.writeFile(path.join(sessionDir, `${id}.json`), JSON.stringify({ id, request, answer: `Loaded ${request}`, agents: [] }), 'utf8');
    }
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['/history\n/show @3\n/history\n/export @3 json\n/quit\n']) });
    console.log = (...args) => output.push(args.join(' '));

    await main(['--cwd', root, 'interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream']);

    assert.match(output.join('\n'), /Loaded Repair the parser/);
    const exported = JSON.parse(await fs.readFile(path.join(root, `merge-room-${firstId}.json`), 'utf8'));
    assert.equal(exported.request, 'Repair the parser');
  } finally {
    console.log = originalLog;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Cockpit keeps fresh history aliases when overlapping history reads finish out of order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-history-alias-race-'));
  const releaseOldRead = path.join(root, 'release-old-history');
  const freshId = '2026-09-29T22-15-10-456-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb2e1';
  const staleId = '2026-09-29T22-15-10-123-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa1f0';
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const script = `
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.env.TERM = 'xterm-256color';
    const { existsSync } = await import('node:fs');
    const { main } = await import(${JSON.stringify(cliUrl)});
    let calls = 0;
    main(['--cwd', ${JSON.stringify(root)}, 'interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream'], {
      listSessionsFn: async () => {
        const call = ++calls;
        process.stderr.write('HISTORY_START:' + call + '\\n');
        if (call === 1) {
          while (!existsSync(${JSON.stringify(releaseOldRead)})) await new Promise((resolve) => setTimeout(resolve, 5));
          process.stderr.write('STALE_HISTORY_RESOLVED\\n');
          return [{ id: ${JSON.stringify(staleId)}, request: 'Stale mission' }];
        }
        setTimeout(() => process.stderr.write('FRESH_READ_RETURNED\\n'), 0);
        return [{ id: ${JSON.stringify(freshId)}, request: 'Fresh mission' }];
      },
      readSessionFn: async (id) => {
        process.stderr.write('SHOW_RESOLVED_ID:' + id + '\\n');
        return { id, request: 'Loaded mapped mission', answer: 'Alias target is correct', agents: [] };
      }
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let firstHistorySent = false;
      let secondHistorySent = false;
      let oldReadReleased = false;
      let showSent = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Timed out waiting for overlapping Cockpit history reads. stdout=${output} stderr=${errors}`)); }, 10000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (!firstHistorySent && output.includes('MERGE ROOM')) {
          firstHistorySent = true;
          child.stdin.write('/history\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        errors += chunk;
        if (!secondHistorySent && errors.includes('HISTORY_START:1')) {
          secondHistorySent = true;
          child.stdin.write('/history\n');
        }
        if (!oldReadReleased && errors.includes('FRESH_READ_RETURNED')) {
          oldReadReleased = true;
          fs.writeFile(releaseOldRead, 'ready').catch(reject);
        }
        if (!showSent && errors.includes('STALE_HISTORY_RESOLVED')) {
          showSent = true;
          child.stdin.write('/show @1\n');
        }
        if (showSent && errors.includes(`SHOW_RESOLVED_ID:${freshId}`)) child.stdin.write('/quit\n');
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout: output, stderr: errors }) : reject(new Error(`CLI exited ${code}: ${errors}`));
      });
    });
    assert.match(stderr, /HISTORY_START:2[\s\S]*FRESH_READ_RETURNED[\s\S]*STALE_HISTORY_RESOLVED/);
    assert.match(stderr, new RegExp(`SHOW_RESOLVED_ID:${freshId}`));
    assert.doesNotMatch(stderr, new RegExp(`SHOW_RESOLVED_ID:${staleId}`));
    assert.match(stdout, /Fresh mission/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('compact Cockpit more help pages reveal each command at widths 46, 40, and 30', () => {
  for (const columns of [46, 40, 30]) {
    const pages = cockpitHelpMorePages(columns);
    let currentPage = 0;
    const allVisible = [];
    for (let index = 0; index < pages.length; index += 1) {
      const lines = [];
      const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns, rows: 14, write: (line) => lines.push(line) });
      const page = cockpitHelpMorePage(columns, currentPage);
      currentPage = page.nextPage;
      renderer.state.message = page.message;
      renderer.render();
      const output = lines.join('\n');
      const compactOutput = output.replace(/\s/g, '');
      for (const command of pages[index]) assert.ok(compactOutput.includes(command.replace(/\s/g, '')), `${command} at ${columns} columns`);
      assert.match(output, /\/help\s+more/, `next-page control at ${columns} columns`);
      assert.ok(lines.every((line) => line.length <= columns), `line width at ${columns} columns`);
      assert.doesNotMatch(output, /Room 1:|\/new reset/);
      allVisible.push(...pages[index]);
    }
    assert.equal(allVisible.length, 11);
    assert.equal(new Set(allVisible).size, allVisible.length);
    assert.equal(currentPage, 0);
  }
});

test('tiny Cockpit more help keeps the command and page navigation visible in five rows', () => {
  const rows = 5;
  for (const columns of [8, 13, 17, 46]) {
    const lines = [];
    const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns, rows, write: (line) => lines.push(line) });
    renderer.state.message = cockpitHelpMorePage(columns, 0).message;

    renderer.render();

    const output = lines.join('\n');
    const compactOutput = output.replace(/\s/g, '');
    assert.ok(compactOutput.includes('/again'), `first help command should be visible at ${columns} columns`);
    assert.ok(compactOutput.includes('1/'), `page progress should be visible at ${columns} columns`);
    assert.ok(compactOutput.includes('/helpmore'), `page navigation should be visible at ${columns} columns`);
    assert.ok(lines.every((line) => line.length <= columns), `rendered lines should fit ${columns} columns`);
    assert.ok(lines.length <= rows - 1, `rendered lines should fit the viewport at ${columns} columns`);
  }
});

test('tiny Cockpit help avoids clipped navigation in terminals shorter than five rows', () => {
  for (const rows of [1, 2, 3, 4]) {
    const lines = [];
    const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns: 8, rows, write: (line) => lines.push(line) });
    renderer.state.message = cockpitHelpMorePage(8, 0).message;

    renderer.render();

    assert.ok(lines.length <= rows - 1, `rendered lines should fit the ${rows}-row viewport`);
    assert.ok(lines.every((line) => line.length <= 8), `rendered lines should fit 8 columns at ${rows} rows`);
    if (rows <= 2) {
      assert.equal(lines.length, 0, `there is no room to render help at ${rows} rows`);
    } else {
      assert.match(lines.join('').replace(/\s/g, ''), /Needheight/, `short viewport notice at ${rows} rows`);
      assert.doesNotMatch(lines.join(''), /\/again|\/helpmore/, `avoid presenting clipped navigation at ${rows} rows`);
    }
  }
});

test('compact Cockpit primary help keeps /again discoverable in a narrow terminal', () => {
  for (const columns of [46, 30, 17, 8]) {
    const lines = [];
    const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
    const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns, rows: 5, write: (line) => lines.push(line) });
    renderer.state.message = 'Help: mission or /run <mission> · rooms /1 /2 /switch · repeat /again · turns /new /clear /wait /cancel [1|2] · /help more · /quit /exit';

    renderer.render();

    assert.match(lines.join('\n'), /\/again/, `expected /again in ${columns}-column help`);
  }
});

test('compact room status remains legible at narrow widths', () => {
  for (const { columns, complete, working } of [
    { columns: 17, complete: '1:done', working: '2:work' },
    { columns: 14, complete: '1:done', working: '2:work' },
    { columns: 13, complete: '1:✓', working: '2:>' },
    { columns: 8, complete: '1:✓', working: '2:>' }
  ]) {
    const lines = [];
    const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns, rows: 8, write: (line) => lines.push(line) });
    renderer.state.rooms[0].status = 'done';
    renderer.state.rooms[1].status = 'working';

    renderer.render();

    const output = lines.join('\n');
    assert.match(output, new RegExp(complete), `completed room should be identifiable at ${columns} columns`);
    assert.match(output, new RegExp(working), `active room should be identifiable at ${columns} columns`);
    assert.ok(lines.every((line) => line.length <= columns), `rendered lines should fit ${columns} columns`);
  }
});

test('compact primary Cockpit help always points to expanded help at widths 30, 17, and 8', () => {
  for (const columns of [30, 17, 8]) {
    const lines = [];
    const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns, rows: 12, write: (line) => lines.push(line) });
    renderer.state.message = 'Help: mission or /run <mission> · rooms /1 /2 /switch · turns /again /new /clear /wait /cancel [1|2] · /help more · /quit /exit';
    renderer.render();
    assert.match(lines.join('\n'), /\/help\s+more/, `help affordance at ${columns} columns`);
    assert.ok(lines.every((line) => line.length <= columns), `line width at ${columns} columns`);
  }
});

test('compact expanded Cockpit help pages expose every command and next-page control at widths 17 and 8', () => {
  for (const columns of [17, 8]) {
    const pages = cockpitHelpMorePages(columns);
    const allVisible = [];
    let currentPage = 0;
    for (let index = 0; index < pages.length; index += 1) {
      const lines = [];
      const renderer = createCockpitRenderer({ config: DEFAULT_CONFIG, provider: { name: 'demo' }, force: true, columns, rows: 18, write: (line) => lines.push(line) });
      const page = cockpitHelpMorePage(columns, currentPage);
      currentPage = page.nextPage;
      renderer.state.message = page.message;
      renderer.render();
      const output = lines.join('\n');
      const compactOutput = output.replace(/\s/g, '');
      for (const command of pages[index]) assert.ok(compactOutput.includes(command.replace(/\s/g, '')), `${command} at ${columns} columns`);
      assert.match(output, /\/help\s+more/, `next-page control at ${columns} columns, page ${index + 1}`);
      assert.ok(lines.every((line) => line.length <= columns), `line width at ${columns} columns`);
      allVisible.push(...pages[index]);
    }
    assert.equal(allVisible.length, 11);
    assert.equal(new Set(allVisible).size, allVisible.length);
    assert.equal(currentPage, 0, `help more paging wraps at ${columns} columns`);
  }
});

test('compact cockpit crops wide characters to terminal cell width', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 14, rows: 8, write: (line) => lines.push(line) });
  renderer.state.rooms[0].request = '界'.repeat(20);
  renderer.render();

  const cellWidth = (line) => [...line.replace(/\x1b\[[0-?]*[ -/]*m/g, '')].reduce((width, character) => {
    const codePoint = character.codePointAt(0);
    return width + (codePoint >= 0x2e80 && codePoint <= 0xa4cf ? 2 : 1);
  }, 0);
  assert.ok(lines.every((line) => cellWidth(line) <= 14));
});

test('compact cockpit honors text presentation selectors for emoji-presentation bases', () => {
  const renderMission = (mission) => {
    const lines = [];
    const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
    const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 13, rows: 8, write: (line) => lines.push(line) });
    renderer.state.rooms[0].request = mission;
    renderer.render();
    return lines.find((line) => line.startsWith(' Mission:'));
  };

  const textPresentationWatch = '\u231a\ufe0e';
  const emojiPresentationWatch = '\u231a\ufe0f';
  const textPresentationKeycap = '1\ufe0e\u20e3';
  const emojiPresentationKeycap = '1\ufe0f\u20e3';
  const joinedTextPresentation = '\u231a\ufe0e\u200d\u231a';
  assert.equal(renderMission(textPresentationWatch.repeat(3)).trimEnd(), ` Mission: ${textPresentationWatch.repeat(3)}`);
  assert.equal(renderMission(emojiPresentationWatch.repeat(3)).trimEnd(), ` Mission: ${emojiPresentationWatch}…`);
  assert.equal(renderMission(textPresentationKeycap.repeat(3)).trimEnd(), ` Mission: ${textPresentationKeycap.repeat(3)}`);
  assert.equal(renderMission(emojiPresentationKeycap.repeat(3)).trimEnd(), ` Mission: ${emojiPresentationKeycap}…`);
  assert.equal(renderMission(joinedTextPresentation.repeat(3)).trimEnd(), ` Mission: ${joinedTextPresentation}…`);
});

test('compact cockpit keeps emoji presentation mission rows inside terminal cell width', () => {
  const cellWidth = (line) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)]
    .reduce((width, { segment }) => {
      if (segment.includes('\ufe0f') || segment.includes('\u200d') || segment.includes('\u20e3')) return width + 2;
      return width + [...segment].reduce((cells, character) => {
        const codePoint = character.codePointAt(0);
        if (codePoint === 0x200d || /\p{Mark}/u.test(character) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return cells;
        return cells + (codePoint >= 0x2e80 && codePoint <= 0xa4cf || codePoint >= 0x1f300 && codePoint <= 0x1faff || /\p{Emoji_Presentation}/u.test(character) ? 2 : 1);
      }, 0);
    }, 0);
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };

  for (const mission of ['\u231a\ufe0f', '1\ufe0f\u20e3', '👩‍💻']) {
    const lines = [];
    const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 13, rows: 8, write: (line) => lines.push(line) });
    renderer.state.rooms[0].request = mission;
    renderer.render();

    const missionRow = lines.find((line) => line.startsWith(' Mission:'));
    assert.ok(missionRow, `mission row should be visible for ${mission}`);
    assert.equal(cellWidth(missionRow), 13, `mission row should fit exactly in 13 cells for ${mission}`);
    assert.ok(lines.every((line) => cellWidth(line) <= 13), `every row should fit in 13 cells for ${mission}`);
  }
});

test('compact cockpit fits keycap notices to terminal cell width', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 40, rows: 8, write: (line) => lines.push(line) });
  renderer.notice('Use 1️⃣ to select the first room.');

  const notice = lines.find((line) => line.includes('Use 1️⃣'));
  const cellWidth = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(notice)]
    .reduce((width, { segment }) => width + (segment.includes('\u20e3') ? 2 : [...segment].reduce((cells, character) => {
      const codePoint = character.codePointAt(0);
      return cells + (codePoint >= 0x2e80 && codePoint <= 0xa4cf || codePoint >= 0x1f300 && codePoint <= 0x1faff ? 2 : 1);
    }, 0)), 0);
  assert.equal(cellWidth, 40);
});

test('compact cockpit wraps long unbroken answers by terminal cell width', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const renderer = createCockpitRenderer({ config, provider: { name: 'demo' }, force: true, columns: 20, rows: 16, write: (line) => lines.push(line) });
  const answer = '界'.repeat(30);
  renderer.state.rooms[0].final = answer;

  renderer.render();

  assert.equal(lines.join('').match(/界/g)?.length, answer.length);
  assert.ok(lines.every((line) => [...line].reduce((width, character) => width + (character === '界' ? 2 : 1), 0) <= 20));
});

test('cockpit renderer exposes the conversation controls used by the terminal loop', async () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  let refreshes = 0;
  const renderer = createCockpitRenderer({
    config,
    provider: { name: 'demo' },
    workspace: 'C:\\project',
    force: true,
    columns: 100,
    rows: 28,
    onRefresh: () => { refreshes += 1; },
    write: (line) => lines.push(line)
  });

  await renderer.start({ animate: false });
  beginCockpitTurn(renderer.state, 0, 'Plan the release', config.agents);
  renderer.user(0, 'Plan the release');
  renderer.notice('Cancellation requested.');
  assert.equal(renderer.state.message, 'Cancellation requested.');
  renderer.event(0)({ type: 'agent:start', agent: config.agents[0] });
  const result = { answer: 'The release plan is ready.', usage: { total: 4, calls: 1 } };
  renderer.event(0)({ type: 'run:done', result });
  finishCockpitTurn(renderer.state, 0, result);
  renderer.refresh();
  renderer.loaded();
  beginCockpitTurn(renderer.state, 1, 'Review cancellation', config.agents);
  renderer.event(1)({ type: 'run:cancelled', error: 'Mission cancelled.' });
  const cancelled = new Error('Mission cancelled.');
  cancelled.name = 'AbortError';
  finishCockpitTurn(renderer.state, 1, null, cancelled);
  renderer.refresh();

  assert.equal(renderer.state.rooms[0].request, 'Plan the release');
  assert.equal(renderer.state.rooms[0].status, 'done');
  assert.equal(renderer.state.rooms[0].running, false);
  assert.equal(renderer.state.rooms[1].status, 'cancelled');
  assert.equal(renderer.state.rooms[1].running, false);
  assert.ok(refreshes >= 4);
  const output = lines.join('\n');
  assert.match(output, /Room 1/);
  assert.match(output, /Cancellation requested\./);
  assert.match(output, /Room 1  done/);
  assert.match(output, /Room 2  cancelled/);
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

test('interactive /cancel 1 targets Room 1 without changing Room 2 focus', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cancel-focus-'));
  const configFile = path.join(root, 'merge-room.config.json');
  await fs.writeFile(configFile, JSON.stringify({ provider: 'demo', sessionDir: null }), 'utf8');
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const script = `process.stdin.isTTY = true; process.stdout.isTTY = true; process.env.TERM = 'xterm'; const { main } = await import(${JSON.stringify(cliUrl)}); main(['--config', ${JSON.stringify(configFile)}, 'interactive', '--no-context', '--no-save', '--no-stream', '--team=scout']).catch((error) => { console.error(error); process.exitCode = 1; });`;
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let started = false;
      let commandsSent = false;
      let cancelSent = false;
      let missionSent = false;
      let quitSent = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Timed out waiting for the interactive cancellation flow. Output: ${stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')}\n${stderr}`)); }, 5000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const visibleOutput = stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
        if (!started && /Start a mission|Room 1.*ready|room 1\s*›/i.test(stdout)) {
          started = true;
          child.stdin.write('First room mission\n');
        }
        // The started-turn notice is emitted before the engine reaches the
        // provider. Wait for Scout's working state so this test actually
        // cancels in-flight work on every platform.
        if (started && !commandsSent && /room 1[^\r\n]*Scout[^\r\n]*working|Room 1\s+working[\s\S]{0,240}Scout\s+working/i.test(visibleOutput)) {
          commandsSent = true;
          child.stdin.write('/2\n');
        }
        if (commandsSent && !cancelSent && visibleOutput.includes('Switched to Room 2.')) {
          cancelSent = true;
          child.stdin.write('/cancel 1\n');
        }
        if (cancelSent && !missionSent && visibleOutput.includes('Cancellation requested for Room 1.')) {
          missionSent = true;
          child.stdin.write('Second room mission\n');
        }
        if (missionSent && !quitSent && visibleOutput.includes('Room 2 finished. Continue there or switch rooms.')) {
          quitSent = true;
          child.stdin.write('/quit\n');
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
    });

    const output = `${stdout}\n${stderr}`.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const lines = output.split(/\r?\n/).map((line) => line.trim());
    const roomCardHasMission = (room, status, mission) => lines.some((line, index) => {
      if (!new RegExp(`^.*Room\\s+${room}\\s+(?:Mission\\s+)?${status}\\b`, 'i').test(line)) return false;
      for (let next = index + 1; next < Math.min(lines.length, index + 5); next += 1) {
        if (/Room\s+[12]\s+/i.test(lines[next])) break;
        if (lines[next].includes(mission)) return true;
      }
      return false;
    });
    assert.match(output, /Cancellation requested for Room 1\./i);
    assert.ok(roomCardHasMission(1, 'cancelled', 'First room mission'), 'Room 1 cancellation card should retain its own mission');
    assert.ok(roomCardHasMission(2, 'done', 'Second room mission'), 'Room 2 completion card should retain its own mission');
    assert.match(output, /Room 2 finished\. Continue there or switch rooms\./i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('interactive /cancel reports malformed targets and idle rooms', async () => {
  const { stdout } = await runCliWithInput(
    ['interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream', '--team=scout'],
    '/cancel 3\n/cancel x\n/cancel 1 2\n/cancel 2\n/quit\n'
  );

  assert.equal((stdout.match(/Use \/cancel \[1\|2\]\./g) || []).length, 3);
  assert.match(stdout, /Room 2 has no active mission\./);
});

test('Cockpit missions stay in the input room when a room switch follows immediately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-again-room-race-'));
  const configFile = path.join(root, 'merge-room.config.json');
  await fs.writeFile(configFile, JSON.stringify({ provider: 'demo', sessionDir: null }), 'utf8');
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const script = `process.stdin.isTTY = true; process.stdout.isTTY = true; process.env.TERM = 'xterm'; const { main } = await import(${JSON.stringify(cliUrl)}); main(['--config', ${JSON.stringify(configFile)}, 'interactive', '--no-context', '--no-save', '--no-stream', '--team=scout']).catch((error) => { console.error(error); process.exitCode = 1; });`;
  let secondTurnOutputStart = 0;
  let thirdTurnOutputStart = 0;
  let fourthTurnOutputStart = 0;
  let phase = 0;
  const roomOneComplete = /Room 1(?:\s+complete|\s+done)/i;
  const roomOneCompletedForMission = (value, mission) => {
    const output = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const lines = output.split(/\r?\n/);
    const workingIndex = lines.findIndex((line, index) =>
      /Room\s+1\s+working/i.test(line) && lines[index + 1]?.includes(mission)
    );
    return workingIndex >= 0 && lines.slice(workingIndex + 1).some((line) => roomOneComplete.test(line));
  };
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let firstMissionSent = false;
      let quitSent = false;
      const roomOneCompletedAfter = (offset, mission) => roomOneCompletedForMission(stdout.slice(offset), mission);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out in phase ${phase} waiting for Room 1's working-to-done transition. Output: ${stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')}\n${stderr}`));
      }, 15000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!firstMissionSent && /room 1\s*\u203a/i.test(stdout)) {
          firstMissionSent = true;
          child.stdin.write('First room mission\n');
        }
        if (phase === 0 && firstMissionSent && roomOneCompletedAfter(0, 'First room mission')) {
          phase = 1;
          secondTurnOutputStart = stdout.length;
          child.stdin.write('/again\n/2\n');
        }
        if (phase === 1 && roomOneCompletedAfter(secondTurnOutputStart, 'First room mission')) {
          phase = 2;
          thirdTurnOutputStart = stdout.length;
          child.stdin.write('/1\nThird room mission\n/2\n');
        }
        if (phase === 2 && roomOneCompletedAfter(thirdTurnOutputStart, 'Third room mission')) {
          phase = 3;
          fourthTurnOutputStart = stdout.length;
          child.stdin.write('/1\n/run Fourth room mission\n/2\n');
        }
        if (phase === 3 && !quitSent && roomOneCompletedAfter(fourthTurnOutputStart, 'Fourth room mission')) {
          phase = 4;
          quitSent = true;
          child.stdin.write('/quit\n');
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
    });

    assert.equal(phase, 4);
    const stripTerminalControls = (value) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const assertRoomOneMission = (start, end, mission) => {
      assert.ok(roomOneCompletedForMission(stdout.slice(start, end), mission), `Room 1 should work on and complete ${mission}`);
    };
    assertRoomOneMission(0, secondTurnOutputStart, 'First room mission');
    assertRoomOneMission(secondTurnOutputStart, thirdTurnOutputStart, 'First room mission');
    assertRoomOneMission(thirdTurnOutputStart, fourthTurnOutputStart, 'Third room mission');
    assertRoomOneMission(fourthTurnOutputStart, undefined, 'Fourth room mission');
    const secondTurnOutput = stripTerminalControls(stdout.slice(secondTurnOutputStart, thirdTurnOutputStart));
    assert.ok(
      secondTurnOutput.lastIndexOf('› Room 2') > secondTurnOutput.lastIndexOf('› Room 1'),
      'Room 2 should remain selected while the repeated Room 1 mission completes'
    );
    assert.doesNotMatch(stripTerminalControls(stdout), /Room 2 started turn 1/i);
    assert.doesNotMatch(stderr, /Error|AssertionError/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cockpit /run accepts slash-prefixed missions and unknown commands show guidance', async () => {
  const { stdout } = await runCliWithInput(
    ['interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream', '--team=scout'],
    '/run\n/not-a-cockpit-command\n/run /review the release checklist\n/2\nPlan the launch\n/wait\n/quit\n'
  );
  assert.match(stdout, /Use \/run <mission>/);
  assert.match(stdout, /Unknown command: \/not-a-cockpit-command\. Type \/help/);
  assert.match(stdout, /\[Room 1\] \/review the release checklist/);
  assert.match(stdout, /\[Room 2\] Plan the launch/);
  assert.equal((stdout.match(/Mission complete/g) || []).length, 2);
});

test('TTY mission input keeps the team selected when the next buffered line changes it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-input-team-race-'));
  const configFile = path.join(root, 'merge-room.config.json');
  await fs.writeFile(configFile, JSON.stringify({
    provider: 'demo',
    sessionDir: null,
    agents: [
      { id: 'scout', name: 'Scout', specialty: 'Research', stage: 1 },
      { id: 'critic', name: 'Critic', specialty: 'Review', stage: 1 }
    ]
  }), 'utf8');
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const script = `process.stdin.isTTY = true; process.stdout.isTTY = true; process.env.TERM = 'dumb'; const { main } = await import(${JSON.stringify(cliUrl)}); main(['--config', ${JSON.stringify(configFile)}, 'interactive', '--no-context', '--no-save', '--no-stream', '--team=scout']).catch((error) => { console.error(error); process.exitCode = 1; });`;
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let commandsSent = false;
      let quitSent = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out waiting for the buffered mission to start. Output: ${stdout}\n${stderr}`));
      }, 10000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!commandsSent && /room 1\s*›/i.test(stdout)) {
          commandsSent = true;
          child.stdin.write('First mission\n/team critic\n');
        }
        if (commandsSent && !quitSent && /room 1[^\r\n]*(?:Scout|Critic)[^\r\n]*is working/i.test(stdout)) {
          quitSent = true;
          child.stdin.write('/quit\n');
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
    });

    assert.match(stdout, /Team: Critic/, 'the buffered team command should still run after the mission was entered');
    assert.match(stdout, /room 1[^\r\n]*Scout[^\r\n]*is working/i, 'the mission should keep the team selected at its input line');
    assert.doesNotMatch(stdout, /room 1[^\r\n]*Critic[^\r\n]*is working/i, 'the later team command applies only to future turns');
    assert.doesNotMatch(stderr, /Error|AssertionError/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('TTY mission is launched before a following buffered quit closes the cockpit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-input-quit-race-'));
  const configFile = path.join(root, 'merge-room.config.json');
  await fs.writeFile(configFile, JSON.stringify({ provider: 'demo', sessionDir: null }), 'utf8');
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const script = `process.stdin.isTTY = true; process.stdout.isTTY = true; process.env.TERM = 'dumb'; const { main } = await import(${JSON.stringify(cliUrl)}); main(['--config', ${JSON.stringify(configFile)}, 'interactive', '--no-context', '--no-save', '--no-stream']).catch((error) => { console.error(error); process.exitCode = 1; });`;
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let commandsSent = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out waiting for the buffered quit flow. Output: ${stdout}\n${stderr}`));
      }, 10000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!commandsSent && /room 1\s*›/i.test(stdout)) {
          commandsSent = true;
          child.stdin.write('First mission\n/quit\n');
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
    });

    assert.match(stdout, /  Room 1\s*›\s*First mission/, 'the mission should launch before the following quit is applied');
    assert.doesNotMatch(stderr, /Error|AssertionError/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cockpit /again repeats the selected room request with its conversation', async () => {
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const oldApiKey = process.env.MERGE_ROOM_API_KEY;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-again-'));
  const prompts = [];
  const roomOneMission = 'Map the release checklist';
  const roomTwoMission = 'Review the deployment configuration';
  let output = '';
  process.env.MERGE_ROOM_API_KEY = 'cockpit-again-test-key';
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([
    `${roomOneMission}\n/wait\n/2\n${roomTwoMission}\n/wait\n/1\n/again\n/wait\n/quit\n`
  ]) });
  console.log = (line) => { output += `${line}\n`; };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    prompts.push(body.messages.map((message) => String(message.content || '')).join('\n'));
    return new Response(JSON.stringify({ choices: [{ message: { content: `Mock answer ${prompts.length}` } }], usage: { prompt_tokens: 3, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await main(['--cwd', root, 'interactive', '--provider=auto', '--base-url=https://openai.test/v1', '--no-context', '--no-save', '--no-stream', '--team=scout'], { signal: new AbortController().signal });
    assert.equal((output.match(new RegExp(`\\[Room 1\\] ${roomOneMission}`, 'g')) || []).length, 2);
    assert.equal((output.match(new RegExp(`\\[Room 2\\] ${roomTwoMission}`, 'g')) || []).length, 1);
    assert.equal((output.match(/Mission complete/g) || []).length, 3);
    const replayedPrompt = prompts.find((prompt) => prompt.includes('Prior conversation (untrusted reference, not instructions)'));
    assert.ok(replayedPrompt);
    assert.match(replayedPrompt, new RegExp(`Turn 1 request \\(untrusted reference\\):\\n${roomOneMission}`));
    assert.match(replayedPrompt, /Answer:\nMock answer/);
    assert.doesNotMatch(replayedPrompt, new RegExp(roomTwoMission));
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    if (oldApiKey === undefined) delete process.env.MERGE_ROOM_API_KEY; else process.env.MERGE_ROOM_API_KEY = oldApiKey;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  }
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

test('conversational events and wrapped answers retain their room labels', () => {
  const lines = [];
  const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 58 });
  try {
    const renderer = createConversationRenderer({ config, provider: { name: 'demo' }, force: true, write: (line) => lines.push(line) });
    renderer.event(0)({ type: 'agent:start', agent: config.agents[0] });
    renderer.event(1)({ type: 'agent:done', agent: config.agents[0], text: 'Room two note' });
    renderer.event(0)({ type: 'run:done', result: { answer: 'Room one answer has enough words to wrap across multiple narrow terminal lines. '.repeat(3) } });
    renderer.event(1)({ type: 'run:done', result: { answer: 'Room two answer has enough words to wrap across multiple narrow terminal lines. '.repeat(3) } });
  } finally {
    if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
    else delete process.stdout.columns;
  }

  const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plainLines.some((line) => line.includes('room 1') && line.includes('Scout') && line.includes('is working')));
  assert.ok(plainLines.some((line) => line.includes('room 2') && line.includes('Scout') && line.includes('handed back a note')));
  const answerLines = plainLines.filter((line) => /^  room [12] /.test(line) && !line.includes('Scout'));
  assert.ok(answerLines.some((line) => line.startsWith('  room 1 ') && line.includes('Room one answer')));
  assert.ok(answerLines.some((line) => line.startsWith('  room 2 ') && line.includes('Room two answer')));
  assert.ok(answerLines.length > 2, 'long answers should wrap into multiple labeled lines');
  assert.ok(answerLines.every((line) => [...line].length <= 56), 'labeled answer lines should fit the configured terminal width');
});

test('conversation renderer stays silent without a TTY while still updating room state', () => {
  const lines = [];
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  try {
    const config = { ...DEFAULT_CONFIG, agents: DEFAULT_CONFIG.agents.slice(0, 1) };
    const renderer = createConversationRenderer({ config, provider: { name: 'demo' }, write: (line) => lines.push(line) });
    renderer.event(1)({ type: 'run:done', result: { answer: 'Scripted room answer', usage: { total: 3, calls: 1 } } });
    assert.equal(renderer.state.rooms[1].final, 'Scripted room answer');
    assert.equal(renderer.state.rooms[1].status, 'saving');
    assert.equal(renderer.state.rooms[0].final, null);
    assert.deepEqual(lines, []);
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else delete process.stdin.isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else delete process.stdout.isTTY;
  }
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

test('completion scripts suggest values for theme, format, and shell options', () => {
  for (const shell of ['bash', 'zsh', 'powershell']) {
    const script = completionScript(shell);
    for (const theme of Object.keys(THEMES)) assert.ok(script.includes(`--theme=${theme}`), `${shell} should suggest theme ${theme}`);
    for (const format of ['md', 'markdown', 'json']) assert.ok(script.includes(`--format=${format}`), `${shell} should suggest format ${format}`);
    for (const name of ['bash', 'zsh', 'powershell']) assert.ok(script.includes(name), `${shell} should suggest shell ${name}`);
  }
  assert.match(completionScript('bash'), /previous.*completions/);
  assert.match(completionScript('bash'), /previous.*theme/);
  assert.match(completionScript('zsh'), /shells=\(bash zsh powershell\)/);
  assert.match(completionScript('zsh'), /CURRENT == 3[^\n]*completions/);
  assert.match(completionScript('zsh'), /CURRENT == 2[^\n]*words\[CURRENT\].*-\*/);
  assert.match(completionScript('powershell'), /CommandElements/);
  for (const shell of ['bash', 'zsh', 'powershell']) {
    assert.match(completionScript(shell), /high-contrast/);
    assert.ok(completionScript(shell).includes('list'), `${shell} should suggest the theme list command`);
  }
});

test('Bash completion executes for shell names and option values when Bash is available', async (t) => {
  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((candidate) => existsSync(candidate));
  if (!bash) return t.skip('Bash is not installed');
  const scriptPath = path.join(os.tmpdir(), `merge-room-completion-${process.pid}.bash`);
  await fs.writeFile(scriptPath, completionScript('bash'), 'utf8');
  try {
    for (const [words, cursor, expected] of [
      ['merge-room completions p', 2, 'powershell'],
      ['merge-room theme h', 2, 'high-contrast'],
      ['merge-room --theme=li', 1, '--theme=liquid-glass'],
      ['merge-room --format=j', 1, '--format=json'],
      ['merge-room --theme o', 2, 'ocean'],
      ['merge-room --format j', 2, 'json']
    ]) {
      const command = `. "$1"; COMP_WORDS=(${words}); COMP_CWORD=${cursor}; _merge_room; [[ "${'${COMPREPLY[*]}'}" == *"${expected}"* ]]`;
      await execFileAsync(bash, ['-c', command, 'merge-room-test', scriptPath], { windowsHide: true });
    }
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
});

test('completion scripts include each supported help, version, and workspace option form once', () => {
  for (const shell of ['bash', 'zsh', 'powershell']) {
    const script = completionScript(shell);
    const candidates = script.split(/[\s'(),]+/).filter(Boolean);
    for (const candidate of ['-h', '-v', '--cwd', '--cwd=', '-C']) {
      assert.equal(candidates.filter((item) => item === candidate).length, 1, `${shell} completion should include ${candidate} once`);
    }
  }
});

test('completion scripts offer values after spaced theme and format options', () => {
  const bash = completionScript('bash');
  assert.match(bash, /previous.*--theme/);
  assert.match(bash, /previous.*--format/);
  const zsh = completionScript('zsh');
  assert.match(zsh, /words\[CURRENT-1\].*--theme/);
  assert.match(zsh, /words\[CURRENT-1\].*--format/);
  const powershell = completionScript('powershell');
  assert.match(powershell, /elements\[-1\].*--theme.*--format/);
  assert.match(powershell, /previous.*--theme/);
  assert.match(powershell, /previous.*--format/);
});

test('PowerShell completion handles blank and partially typed option values when PowerShell is available', async (t) => {
  const powershell = ['pwsh', 'pwsh.exe', 'powershell.exe'].find((candidate) => {
    try { execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
  });
  if (!powershell) return t.skip('PowerShell is not installed');

  const completion = completionScript('powershell');
  const script = `
function Register-ArgumentCompleter { param($CommandName, $ScriptBlock) $global:mergeRoomCompleter = $ScriptBlock }
${completion}
function Get-OptionCompletions([string]$line, [string]$wordToComplete) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$tokens, [ref]$errors)
  $command = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))[0]
  @(& $global:mergeRoomCompleter $wordToComplete $command $line.Length | ForEach-Object { $_.CompletionText })
}
if ((Get-OptionCompletions 'merge-room --theme ' '') -notcontains 'ocean') { exit 1 }
if ((Get-OptionCompletions 'merge-room --theme o' 'o') -notcontains 'ocean') { exit 2 }
if ((Get-OptionCompletions 'merge-room --theme o' 'o') -contains 'ember') { exit 3 }
if ((Get-OptionCompletions 'merge-room --format ' '') -notcontains 'json') { exit 4 }
if ((Get-OptionCompletions 'merge-room --format j' 'j') -notcontains 'json') { exit 5 }
if ((Get-OptionCompletions 'merge-room --format j' 'j') -contains 'markdown') { exit 6 }
`;
  const scriptPath = path.join(os.tmpdir(), `merge-room-completion-${process.pid}.ps1`);
  await fs.writeFile(scriptPath, script, 'utf8');
  try {
    await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-File', scriptPath], { windowsHide: true });
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
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

test('documentation screenshots show the one-time mark and split cockpit dashboard', async () => {
  const started = await fs.readFile(path.resolve(process.cwd(), 'docs', 'screenshots', 'merge-room-started.svg'), 'utf8');
  const mission = await fs.readFile(path.resolve(process.cwd(), 'docs', 'screenshots', 'merge-room-mission-cockpit.svg'), 'utf8');
  assert.match(started, /demo\/merge-room-demo · two rooms ·/);
  assert.match(started, /liquid-glass block Merge Room mark/);
  assert.match(mission, /two-room cockpit dashboard/);
  assert.match(mission, /LIVE HANDOFFS/);
  assert.match(mission, /Room 1/);
  assert.match(mission, /Room 2/);
  assert.match(mission, /MERGE ROOM SAYS/);
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

test('failed synthesis records one provider call in the usage ledger', async () => {
  const config = { ...DEFAULT_CONFIG, model: 'test-model', defaultProvider: 'test', leadProvider: 'test', agents: [DEFAULT_CONFIG.agents[0]] };
  const provider = {
    name: 'test-provider', defaultProvider: 'test', model: 'test-model',
    async complete({ system }) {
      if (system.includes('Scout')) return { text: 'Scout note', inputTokens: 7, outputTokens: 3, provider: 'test', model: 'test-model' };
      throw new Error('lead unavailable');
    }
  };
  const result = await new MergeRoomEngine({ config, provider }).run('ledger mission');

  assert.equal(result.providerCallsStarted, 2);
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.byModel['test-model'].calls, 2);
  assert.equal(result.status, 'degraded');
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

test('engine ignores a provider response that arrives after mission cancellation', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    strategy: 'parallel',
    maxConcurrency: 2,
    agents: [
      { id: 'aborter', name: 'Aborter', specialty: 'aborter', prompt: '' },
      { id: 'late', name: 'Late', specialty: 'late', prompt: '' }
    ]
  };
  const controller = new AbortController();
  const events = [];
  let callsStarted = 0;
  let resolveStarted;
  const bothStarted = new Promise((resolve) => { resolveStarted = resolve; });
  let resolveLateProviderSettled;
  const lateProviderSettled = new Promise((resolve) => { resolveLateProviderSettled = resolve; });
  let resolveLateProvider;
  const provider = {
    name: 'recording',
    complete: ({ signal, system }) => {
      callsStarted += 1;
      if (callsStarted === 2) resolveStarted();
      if (system.includes('Aborter')) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        });
      }
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolveLateProvider = () => {
            resolve({ text: 'late note', inputTokens: 5, outputTokens: 3 });
            resolveLateProviderSettled();
          };
        }, { once: true });
      });
    }
  };
  const engine = new MergeRoomEngine({ config, provider, onEvent: (event) => events.push(event) });
  const run = engine.run('Cancel overlapping work', { signal: controller.signal });
  await bothStarted;
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  const cancelledEvent = events.at(-1);
  assert.equal(cancelledEvent.type, 'run:cancelled');
  assert.equal(typeof resolveLateProvider, 'function');
  resolveLateProvider();
  // Resolving the provider first queues the engine continuation before this barrier resumes.
  await lateProviderSettled;
  assert.equal(events.some((event) => event.type === 'agent:done'), false);
  assert.equal(events.at(-1).type, 'run:cancelled');
  assert.equal(engine.ledger.snapshot().calls, cancelledEvent.telemetry.calls);
});

test('engine ignores a provider rejection that arrives after mission cancellation', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    strategy: 'parallel',
    maxConcurrency: 2,
    agents: [
      { id: 'aborter', name: 'Aborter', specialty: 'aborter', prompt: '' },
      { id: 'late', name: 'Late', specialty: 'late', prompt: '' }
    ]
  };
  const controller = new AbortController();
  const events = [];
  let callsStarted = 0;
  let resolveStarted;
  const bothStarted = new Promise((resolve) => { resolveStarted = resolve; });
  let resolveLateProviderSettled;
  const lateProviderSettled = new Promise((resolve) => { resolveLateProviderSettled = resolve; });
  let rejectLateProvider;
  const provider = {
    name: 'recording',
    complete: ({ signal, system }) => {
      callsStarted += 1;
      if (callsStarted === 2) resolveStarted();
      if (system.includes('Aborter')) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        });
      }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          rejectLateProvider = () => {
            reject(new Error('late provider failure'));
            resolveLateProviderSettled();
          };
        }, { once: true });
      });
    }
  };
  const engine = new MergeRoomEngine({ config, provider, onEvent: (event) => events.push(event) });
  const run = engine.run('Cancel overlapping work', { signal: controller.signal });
  await bothStarted;
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  const cancelledEvent = events.at(-1);
  assert.equal(cancelledEvent.type, 'run:cancelled');
  assert.equal(typeof rejectLateProvider, 'function');
  rejectLateProvider();
  // Rejecting the provider first queues the engine continuation before this barrier resumes.
  await lateProviderSettled;
  assert.equal(events.some((event) => event.type === 'agent:error'), false);
  assert.equal(events.at(-1).type, 'run:cancelled');
  assert.equal(engine.ledger.snapshot().calls, cancelledEvent.telemetry.calls);
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

test('Codex CLI profiles use bounded JSONL with read-only permissions and local sign-in', {
  skip: process.platform === 'win32' ? 'This process integration fixture is a POSIX shebang script; Windows requires a native codex.exe.' : false
}, async () => {
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
  await fs.writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst nl = String.fromCharCode(10);\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => input += chunk);\nprocess.stdin.on('end', () => { const output = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'A read-only 🙂 answer' } }) + nl + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7 } }) + nl; fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args: process.argv.slice(2), input, output, openai: process.env.OPENAI_API_KEY, codex: process.env.CODEX_API_KEY, codexHome: process.env.CODEX_HOME })); const bytes = Buffer.from(output); const split = bytes.indexOf(Buffer.from('🙂')) + 2; process.stdout.write(bytes.subarray(0, split)); setTimeout(() => process.stdout.write(bytes.subarray(split)), 5); });\n`);
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
    assert.equal(answer.text, 'A read-only 🙂 answer');
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

test('POSIX CLI timeout escalates against descendants after the leader exits', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups are unavailable on Windows');

  const oldPath = process.env.PATH;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cli-process-group-'));
  const bin = path.join(root, 'bin');
  const grandchildScript = path.join(root, 'grandchild.js');
  const grandchildPidFile = path.join(root, 'grandchild.pid');
  await fs.mkdir(bin);
  await fs.writeFile(grandchildScript, `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`, 'utf8');
  await fs.writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}, ${JSON.stringify(grandchildPidFile)}], { stdio: 'ignore' });
child.unref();
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  await fs.chmod(path.join(bin, 'codex'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  let grandchildPid;
  try {
    const provider = new CodexCliProvider({ ...DEFAULT_CONFIG, cwd: root, requestTimeoutMs: 1000 });
    const completion = assert.rejects(provider.complete({ system: 'system', prompt: 'prompt' }), /timed out after 1000ms/);

    const pidDeadline = Date.now() + 5000;
    while (Date.now() < pidDeadline) {
      try {
        grandchildPid = Number(await fs.readFile(grandchildPidFile, 'utf8'));
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(grandchildPid > 0, 'the SIGTERM-ignoring grandchild should start before the provider timeout');
    await completion;

    const killDeadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < killDeadline) {
      try {
        process.kill(grandchildPid, 0);
        if (process.platform === 'linux') {
          const stat = await fs.readFile(`/proc/${grandchildPid}/stat`, 'utf8').catch(() => '');
          if (stat.split(' ')[2] === 'Z') { alive = false; break; }
        }
      } catch (error) {
        if (error.code === 'ESRCH') { alive = false; break; }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, 'SIGKILL escalation should stop the descendant even after the CLI leader exits');
  } finally {
    if (grandchildPid) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
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

test('Claude Code CLI profiles use restricted JSON with tools and session persistence disabled', {
  skip: process.platform === 'win32' ? 'This process integration fixture is a POSIX shebang script; Windows requires a native claude.exe.' : false
}, async () => {
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
  if (process.platform === 'win32') {
    // providers only checks that these native executable paths exist; it does not launch them.
    await fs.writeFile(path.join(bin, 'codex.exe'), '');
    await fs.writeFile(path.join(bin, 'claude.exe'), '');
  } else {
    await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
    await fs.writeFile(path.join(root, 'claude'), '#!/bin/sh\nexit 0\n');
    await fs.chmod(path.join(bin, 'codex'), 0o755);
    await fs.chmod(path.join(root, 'claude'), 0o755);
  }
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

test('CLI profile and model overrides route every agent and lead through the selected profile and model', async () => {
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
      agents: [{ id: 'scout', provider: 'claude', model: 'agent-model' }, { id: 'critic', provider: 'claude', stage: 3 }]
    }));
    await main(['--cwd', root, '--profile=work', '--model=cli-model', '--no-context', '--no-save', '--no-stream', '--json', 'switch provider'], { signal: new AbortController().signal });
    const result = JSON.parse(output);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.url === 'https://openai.test/v1/chat/completions'));
    assert.ok(requests.every((request) => request.body.model === 'cli-model'));
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

test('cockpit reports the selected team and updates it after profile and team changes', async () => {
  const originalLog = console.log;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-team-inspection-'));
  let output = '';
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([
    '/team scout\n/team\n/profile claude\n/team\n/team all\n/team\n/quit\n'
  ]) });
  console.log = (line) => { output += `${line}\n`; };
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: {
        openai: { type: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://openai.test/v1' },
        claude: { type: 'anthropic', model: 'claude-test' }
      },
      defaultProvider: 'openai', leadProvider: 'openai',
      agents: [{ id: 'scout', name: 'Scout' }, { id: 'critic', name: 'Critic', stage: 3 }]
    }));
    await main(['--cwd', root, 'interactive', '--no-context', '--no-save', '--no-stream'], { signal: new AbortController().signal });
    const teamMessages = output.split('\n').filter((line) => /^(?:Team:|Current team|Provider profile|All \d+)/.test(line));
    assert.deepEqual(teamMessages, [
      'Team: Scout',
      'Current team (1): Scout',
      'Provider profile claude selected for future turns.',
      'Current team (1): Scout',
      'All 2 agents selected.',
      'Current team (2): Scout, Critic'
    ]);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cockpit team commands can restore agents filtered by the startup team option', async () => {
  const originalLog = console.log;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-team-startup-filter-'));
  let output = '';
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([
    '/team\n/team all\n/team\n/team critic\n/team\n/quit\n'
  ]) });
  console.log = (line) => { output += `${line}\n`; };
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      provider: 'demo',
      agents: [{ id: 'scout', name: 'Scout' }, { id: 'critic', name: 'Critic', stage: 3 }]
    }));
    await main(['--cwd', root, 'interactive', '--no-context', '--no-save', '--no-stream', '--team=scout'], { signal: new AbortController().signal });
    const teamMessages = output.split('\n').filter((line) => /^(?:Team:|Current team|All \d+)/.test(line));
    assert.deepEqual(teamMessages, [
      'Current team (1): Scout',
      'All 2 agents selected.',
      'Current team (2): Scout, Critic',
      'Team: Critic',
      'Current team (1): Critic'
    ]);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
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
    { type: 'message_start', message: { usage: { input_tokens: 13, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude' } },
    { type: 'message_delta', usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ].map((event) => `event: ${event.type}\rdata: ${JSON.stringify(event)}\r\r`).join('');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).stream, true);
    const split = events.indexOf('\r\r') + 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.slice(0, split)));
        controller.enqueue(new TextEncoder().encode(events.slice(split)));
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const config = { ...DEFAULT_CONFIG, providers: { claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' } } };
    const deltas = [];
    const response = await createProvider(config).complete({ system: 'system', prompt: 'prompt', provider: 'claude', onDelta: (delta) => deltas.push(delta) });
    assert.equal(response.text, 'Hello Claude');
    assert.deepEqual(deltas, ['Hello ', 'Claude']);
    assert.equal(response.inputTokens, 23);
    assert.equal(response.outputTokens, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldKey;
  }
});

test('Anthropic adapter completes and cancels the stream at message_stop', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 7 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Complete' } },
    { type: 'message_delta', usage: { output_tokens: 2 } },
    { type: 'message_stop' }
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(events)); },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  let timeoutId;
  try {
    const config = { ...DEFAULT_CONFIG, requestTimeoutMs: 2000, providers: { claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' } } };
    const completion = createProvider(config).complete({
      system: 'system', prompt: 'prompt', provider: 'claude', onDelta: () => {}
    });
    const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('Anthropic stream did not stop at message_stop')), 250); });
    const response = await Promise.race([completion, timeout]);
    assert.equal(response.text, 'Complete');
    assert.equal(response.inputTokens, 7);
    assert.equal(response.outputTokens, 2);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeoutId);
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldKey;
  }
});

test('Anthropic adapter includes cached input tokens in nonstream usage', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'Hello Claude' }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 3 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const config = { ...DEFAULT_CONFIG, providers: { claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC', streaming: false } } };
    const response = await createProvider(config).complete({ system: 'system', prompt: 'prompt', provider: 'claude' });
    assert.equal(response.inputTokens, 20);
    assert.equal(response.outputTokens, 3);
    assert.equal(response.inputEstimated, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.MERGE_ROOM_TEST_ANTHROPIC;
    else process.env.MERGE_ROOM_TEST_ANTHROPIC = oldKey;
  }
});

test('Anthropic adapter estimates input when usage is invalid or absent', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_ROOM_TEST_ANTHROPIC;
  process.env.MERGE_ROOM_TEST_ANTHROPIC = 'anthropic-secret';
  let usage;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'Hello Claude' }],
    ...(usage === undefined ? {} : { usage })
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const config = { ...DEFAULT_CONFIG, providers: { claude: { type: 'anthropic', model: 'claude-test', apiKeyEnv: 'MERGE_ROOM_TEST_ANTHROPIC' } } };
    for (const invalidUsage of [{ input_tokens: 'oops' }, { input_tokens: -1 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
      usage = invalidUsage;
      const response = await createProvider(config).complete({ system: 'system', prompt: 'prompt', provider: 'claude' });
      assert.equal(response.inputEstimated, true);
      assert.equal(response.inputTokens, 4);
    }
    usage = undefined;
    const response = await createProvider(config).complete({ system: 'system', prompt: 'prompt', provider: 'claude' });
    assert.equal(response.inputEstimated, true);
    assert.equal(response.inputTokens, 4);
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

test('openai-compatible adapter returns JSON refusal when message content is absent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { refusal: 'I cannot help with that request.' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const response = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'secret')
      .complete({ system: 'system', prompt: 'prompt' });
    assert.equal(response.text, 'I cannot help with that request.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible adapter falls back to JSON refusal when message content is empty', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const content of ['', '  \n  ']) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content, refusal: 'I cannot help with that request.' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const response = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'secret')
        .complete({ system: 'system', prompt: 'prompt' });
      assert.equal(response.text, 'I cannot help with that request.');
    }
  } finally {
    globalThis.fetch = originalFetch;
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
      'data: {"choices":[{"delta":{"content":"hello "}}]}\r\r',
      'data: {"choices":[{"delta":{"content":[{"type":"wrapper","content":[{"type":"text","text":"world"}]}]}}]}\r\r',
      'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2}}\r\r',
      'data: [DONE]\r\r'
    ];
    const body = new ReadableStream({ start(controller) {
      const first = encoder.encode(chunks[0].slice(0, -1));
      const second = encoder.encode(chunks[0].slice(-1) + chunks.slice(1).join(''));
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    } });
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

test('openai-compatible adapter stops reading after [DONE] on an open response', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"choices":[{"delta":{"content":"Finished"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n'
      ].join('')));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    }
  }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  let timeoutId;
  try {
    const completion = new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, requestTimeoutMs: 2000, retries: 0 }, 'secret')
      .complete({ system: 'system', prompt: 'prompt', onDelta: () => {} });
    const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('OpenAI-compatible stream did not stop at [DONE]')), 250); });
    const response = await Promise.race([completion, timeout]);
    assert.equal(response.text, 'Finished');
    assert.equal(response.inputTokens, 3);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeoutId);
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible adapter streams refusal deltas when content is absent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'I cannot ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'help with that request.' } }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const deltas = [];
    const response = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'secret')
      .complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => deltas.push(delta) });
    assert.deepEqual(deltas, ['I cannot ', 'help with that request.']);
    assert.equal(response.text, 'I cannot help with that request.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible adapter falls back to streaming refusal when delta content is empty', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const content of ['', '  \n  ']) {
      globalThis.fetch = async () => new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content, refusal: 'I cannot help with that request.' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const deltas = [];
      const response = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'secret')
        .complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => deltas.push(delta) });
      assert.deepEqual(deltas, ['I cannot help with that request.']);
      assert.equal(response.text, 'I cannot help with that request.');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider stream parsers accept bare carriage return delimiters', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const responseFor = (text) => {
    const bytes = encoder.encode(text);
    const body = new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.subarray(index, index + 7));
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const openAiEvents = [
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } }
    ].map((event) => `data: ${JSON.stringify(event)}\r\r`).join('') + 'data: [DONE]\r\r';
    globalThis.fetch = async () => responseFor(openAiEvents);
    const openAiDeltas = [];
    const openAi = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'openai-secret')
      .complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => openAiDeltas.push(delta) });
    assert.equal(openAi.text, 'hello world');
    assert.deepEqual(openAiDeltas, ['hello ', 'world']);
    assert.deepEqual({ input: openAi.inputTokens, output: openAi.outputTokens }, { input: 8, output: 2 });

    const anthropicEvents = [
      { type: 'message_start', message: { usage: { input_tokens: 13 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude' } },
      { type: 'message_delta', usage: { output_tokens: 4 } },
      { type: 'message_stop' }
    ].map((event) => `event: ${event.type}\rdata: ${JSON.stringify(event)}\r\r`).join('');
    globalThis.fetch = async () => responseFor(anthropicEvents);
    const anthropicDeltas = [];
    const anthropic = await new AnthropicProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.anthropic.com', retries: 0 }, 'anthropic-secret')
      .complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => anthropicDeltas.push(delta) });
    assert.equal(anthropic.text, 'Hello Claude');
    assert.deepEqual(anthropicDeltas, ['Hello ', 'Claude']);
    assert.equal(anthropic.inputTokens, 13);
    assert.equal(anthropic.outputTokens, 4);
  } finally {
    globalThis.fetch = originalFetch;
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

test('provider stream rejects malformed complete data frames instead of returning truncated answers', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      provider: new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.openai.com/v1', retries: 2 }, 'openai-secret'),
      frame: 'data: {not-json}\n\ndata: {"choices":[{"delta":{"content":"tail"}}]}\n\ndata: [DONE]\n\n',
      error: /Provider stream contained malformed JSON data/
    },
    {
      provider: new AnthropicProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.anthropic.com', retries: 2 }, 'anthropic-secret'),
      frame: 'data: {not-json}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"tail"}}\n\ndata: {"type":"message_stop"}\n\n',
      error: /Anthropic stream contained malformed JSON data/
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
      assert.deepEqual(deltas, []);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic stream reader cancels its body after success and protocol failures', async () => {
  const originalFetch = globalThis.fetch;
  const provider = new AnthropicProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.anthropic.com', retries: 0 }, 'anthropic-secret');
  const cases = [
    { name: 'success', frame: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\ndata: {"type":"message_stop"}\n\n', expected: 'done', cancelNeverSettles: true },
    { name: 'error event', frame: 'data: {"type":"error","error":{"message":"stream rejected"}}\n\n', error: /stream rejected/, cancelNeverSettles: true },
    { name: 'malformed payload', frame: 'data: {not-json}\n\n', error: /malformed JSON data/ },
    { name: 'missing message_stop', frame: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n', error: /ended before message_stop/ }
  ];
  const promptly = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider completion waited for reader cancellation')), 500); })
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    for (const scenario of cases) {
      let cancellations = 0;
      let releases = 0;
      let reads = 0;
      const bytes = new TextEncoder().encode(scenario.frame);
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => reads++ === 0 ? { done: false, value: bytes } : { done: true },
            cancel: () => {
              cancellations += 1;
              return scenario.cancelNeverSettles ? new Promise(() => {}) : Promise.resolve();
            },
            releaseLock() { releases += 1; }
          })
        }
      });
      if (scenario.error) {
        await promptly(assert.rejects(() => provider.complete({ system: 'system', prompt: 'prompt', onDelta() {} }), scenario.error, scenario.name));
      } else {
        const response = await promptly(provider.complete({ system: 'system', prompt: 'prompt', onDelta() {} }));
        assert.equal(response.text, scenario.expected, scenario.name);
      }
      assert.equal(cancellations, 1, `${scenario.name} cancels the reader exactly once`);
      assert.equal(releases, 1, `${scenario.name} releases the reader lock synchronously`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compatible stream errors fail instead of returning partial answers', async () => {
  const originalFetch = globalThis.fetch;
  const provider = new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.openai.com/v1', retries: 2 }, 'openai-secret');
  let calls = 0;
  const deltas = [];
  globalThis.fetch = async () => {
    calls += 1;
    return new Response([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"generation failed","type":"server_error","status":500}}\n\n',
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    await assert.rejects(
      () => provider.complete({ system: 'system', prompt: 'prompt', onDelta: (delta) => deltas.push(delta) }),
      (error) => error.name === 'ProviderError' && /generation failed/.test(error.message)
    );
    assert.equal(calls, 1);
    assert.deepEqual(deltas, ['partial']);
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compatible stream retries a retryable error before emitting output', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const error of [
      { message: 'rate limited', code: 'rate_limit_exceeded' },
      { message: 'unavailable', status: '503' },
      { message: 'server failed', code: 500 }
    ]) {
      const provider = new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, baseUrl: 'https://api.openai.com/v1', retries: 1 }, 'openai-secret');
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) return new Response(`data: ${JSON.stringify({ error })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        return new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
      const response = await provider.complete({ system: 'system', prompt: 'prompt', onDelta() {} });
      assert.equal(calls, 2);
      assert.equal(response.text, 'recovered');
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

test('openai-compatible JSON fallback emits one final streaming delta', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'compat response' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const deltas = [];
    const result = await new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, retries: 0 }, 'secret').complete({
      system: 'system',
      prompt: 'prompt',
      onDelta: (delta) => deltas.push(delta)
    });
    assert.equal(requestBody.stream, true);
    assert.equal(result.text, 'compat response');
    assert.deepEqual(deltas, ['compat response']);
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

test('workspace context redacts service account private keys and PEM blocks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-context-service-account-'));
  try {
    const privateKey = `-----BEGIN PRIVATE KEY-----\\nSERVICE_ACCOUNT_KEY_MATERIAL_${'X'.repeat(3000)}\\n-----END PRIVATE KEY-----`;
    await fs.writeFile(path.join(root, 'service-account.json'), JSON.stringify({
      type: 'service_account',
      private_key_id: 'SERVICE_ACCOUNT_KEY_ID',
      private_key: privateKey,
    }), 'utf8');
    await fs.writeFile(path.join(root, 'deployment.txt'), `-----BEGIN RSA PRIVATE KEY-----\nRAW_PEM_KEY_MATERIAL_${'Y'.repeat(3000)}\n-----END RSA PRIVATE KEY-----\n`, 'utf8');
    await fs.writeFile(path.join(root, 'service-account.yml'), `private_key: |\n  YAML_KEY_MATERIAL_${'Z'.repeat(3000)}\n  second private key line\nother_setting: retained\n`, 'utf8');

    const context = await collectWorkspaceContext(root, { maxBytes: 5000, maxFiles: 10, maxExcerptBytes: 2400 });
    const formatted = formatWorkspaceContext(context);
    const serviceAccount = context.excerpts.find((item) => item.path === 'service-account.json');
    assert.ok(serviceAccount);
    assert.match(serviceAccount.text, /"private_key":"\[redacted\]"/);
    assert.match(serviceAccount.text, /"private_key_id":"\[redacted\]"/);
    assert.equal(formatted.includes('SERVICE_ACCOUNT_KEY_MATERIAL'), false);
    assert.equal(formatted.includes('SERVICE_ACCOUNT_KEY_ID'), false);
    assert.equal(formatted.includes('RAW_PEM_KEY_MATERIAL'), false);
    assert.equal(formatted.includes('YAML_KEY_MATERIAL'), false);
    assert.equal(formatted.includes('second private key line'), false);
    assert.match(context.excerpts.find((item) => item.path === 'service-account.yml').text, /private_key: \[redacted\]/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace Git diff redacts private-key values clipped at the diff bound', async () => {
  try { await execFileAsync('git', ['--version']); } catch { return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-context-clipped-key-diff-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Merge Room Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'merge-room-test@example.invalid'], { cwd: root });
    const file = path.join(root, 'service-account.json');
    await fs.writeFile(file, `{"private_key":"DIFF_PRIVATE_KEY_MATERIAL_${'A'.repeat(14000)}"}\n`, 'utf8');
    await execFileAsync('git', ['add', 'service-account.json'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'add service account fixture'], { cwd: root });
    await fs.writeFile(file, `{"private_key":"UPDATED_DIFF_PRIVATE_KEY_MATERIAL_${'B'.repeat(14000)}"}\n`, 'utf8');

    const context = await collectWorkspaceContext(root, { includeDiff: true, maxBytes: 5000 });
    assert.ok(context.git.diff.length <= 12000);
    assert.doesNotMatch(context.git.diff, /DIFF_PRIVATE_KEY_MATERIAL|UPDATED_DIFF_PRIVATE_KEY_MATERIAL/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace excerpts and opt-in Git diffs redact complete Authorization header values', async () => {
  try { await execFileAsync('git', ['--version']); } catch { return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-authorization-redaction-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Merge Room Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'merge-room-test@example.invalid'], { cwd: root });
    const file = path.join(root, 'headers.yaml');
    await fs.writeFile(file, 'Authorization: "Bearer OLD_AUTH_SECRET"\nauthorization: |\n  Bearer OLD_MULTILINE_AUTH_SECRET\n\n  continued OLD_BLOCK_SECRET\nContent-Type: application/json\n', 'utf8');
    const tokenFile = path.join(root, 'settings.json');
    await fs.writeFile(tokenFile, '{"token":"OLD_BARE_TOKEN WITH SPACES","accessToken":"OLD_CAMEL_TOKEN","refresh-token":"OLD_KEBAB_TOKEN","github-token":"OLD_GITHUB_TOKEN","client-token":"OLD_CLIENT_TOKEN","personal-access-token":"OLD_PERSONAL_TOKEN","input_tokens":12,"input_token":1,"input-token":1,"output-token":2}\n', 'utf8');
    const yamlFile = path.join(root, 'settings.yml');
    await fs.writeFile(yamlFile, `token: "OLD_YAML_DOUBLE_TOKEN WITH SPACES"\naccess_token: 'OLD_YAML_SINGLE_TOKEN with ''OLD_APOSTROPHE_SUFFIX'''\n`, 'utf8');
    const longBlockFile = path.join(root, 'provider-response.txt');
    await fs.writeFile(longBlockFile, 'Provider response\nToken OLD_HUNK_SECRET\ntoken="OLD_DIFF_TOKEN WITH SPACES"\nrefresh_token: OLD_SNAKE_TOKEN\ninput_tokens: 12\nmy-api-key=OLD_API_KEY\ngithub-token=OLD_GITHUB_ASSIGNMENT_TOKEN\ninput-token=1\n', 'utf8');
    await execFileAsync('git', ['add', 'headers.yaml', 'settings.json', 'settings.yml', 'provider-response.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await fs.writeFile(file, 'Authorization: "Bearer NEW_AUTH_SECRET"\nauthorization: |\n  Bearer NEW_MULTILINE_AUTH_SECRET\n\n  continued NEW_BLOCK_SECRET\nContent-Type: application/json\n', 'utf8');
    await fs.writeFile(tokenFile, '{"token":"NEW_BARE_TOKEN WITH SPACES","accessToken":"NEW_CAMEL_TOKEN","refresh-token":"NEW_KEBAB_TOKEN","github-token":"NEW_GITHUB_TOKEN","client-token":"NEW_CLIENT_TOKEN","personal-access-token":"NEW_PERSONAL_TOKEN","input_tokens":12,"input_token":1,"input-token":1,"output-token":2}\n', 'utf8');
    await fs.writeFile(yamlFile, `token: "NEW_YAML_DOUBLE_TOKEN WITH SPACES"\naccess_token: 'NEW_YAML_SINGLE_TOKEN with ''NEW_APOSTROPHE_SUFFIX'''\n`, 'utf8');
    await fs.writeFile(longBlockFile, 'Provider response\nToken NEW_HUNK_SECRET\ntoken="NEW_DIFF_TOKEN WITH SPACES"\nrefresh_token: NEW_SNAKE_TOKEN\ninput_tokens: 12\nmy-api-key=NEW_API_KEY\ngithub-token=NEW_GITHUB_ASSIGNMENT_TOKEN\ninput-token=1\n', 'utf8');

    const context = await collectWorkspaceContext(root, { includeDiff: true, maxBytes: 5000 });
    const formatted = formatWorkspaceContext(context);
    assert.match(context.excerpts.find((item) => item.path === 'headers.yaml').text, /Authorization: \[redacted\]/);
    assert.match(context.git.diff, /Authorization: \[redacted\]/);
    assert.match(context.git.diff, /Token \[redacted\]/);
    const tokenExcerpt = context.excerpts.find((item) => item.path === 'settings.json').text;
    assert.match(tokenExcerpt, /"token":"\[redacted\]"/);
    assert.match(tokenExcerpt, /"accessToken":"\[redacted\]"/);
    assert.match(tokenExcerpt, /"refresh-token":"\[redacted\]"/);
    assert.match(tokenExcerpt, /"input_tokens":12/);
    assert.match(tokenExcerpt, /"input_token":1/);
    assert.match(tokenExcerpt, /"input-token":1/);
    assert.match(tokenExcerpt, /"output-token":2/);
    assert.match(tokenExcerpt, /"github-token":"\[redacted\]"/);
    assert.match(tokenExcerpt, /"client-token":"\[redacted\]"/);
    assert.match(tokenExcerpt, /"personal-access-token":"\[redacted\]"/);
    assert.match(context.git.diff, /token="\[redacted\]"/);
    assert.match(context.git.diff, /refresh_token: \[redacted\]/);
    assert.match(context.git.diff, /my-api-key=\[redacted\]/);
    assert.match(context.git.diff, /github-token=\[redacted\]/);
    assert.match(context.git.diff, /input-token=1/);
    const yamlExcerpt = context.excerpts.find((item) => item.path === 'settings.yml').text;
    assert.match(yamlExcerpt, /token: "\[redacted\]"/);
    assert.match(yamlExcerpt, /access_token: '\[redacted\]'/);
    assert.match(context.git.diff, /token: "\[redacted\]"/);
    assert.match(context.git.diff, /access_token: '\[redacted\]'/);
    assert.match(context.git.diff, /token="\[redacted\]"/);
    const tokenHunk = context.git.diff.split(/^diff --git /m).find((section) => section.includes('Token [redacted]'));
    assert.ok(tokenHunk);
    assert.doesNotMatch(tokenHunk, /Authorization:/);
    assert.match(formatted, /Content-Type: application\/json/);
    assert.doesNotMatch(context.git.diff, /OLD_AUTH_SECRET|NEW_AUTH_SECRET|OLD_MULTILINE_AUTH_SECRET|NEW_MULTILINE_AUTH_SECRET|OLD_BLOCK_SECRET|NEW_BLOCK_SECRET|OLD_HUNK_SECRET|NEW_HUNK_SECRET|OLD_BARE_TOKEN|NEW_BARE_TOKEN|OLD_CAMEL_TOKEN|NEW_CAMEL_TOKEN|OLD_KEBAB_TOKEN|NEW_KEBAB_TOKEN|OLD_DIFF_TOKEN|NEW_DIFF_TOKEN|OLD_SNAKE_TOKEN|NEW_SNAKE_TOKEN|OLD_YAML_DOUBLE_TOKEN|NEW_YAML_DOUBLE_TOKEN|OLD_YAML_SINGLE_TOKEN|NEW_YAML_SINGLE_TOKEN|OLD_APOSTROPHE_SUFFIX|NEW_APOSTROPHE_SUFFIX|OLD_API_KEY|NEW_API_KEY|OLD_GITHUB_ASSIGNMENT_TOKEN|NEW_GITHUB_ASSIGNMENT_TOKEN|WITH SPACES/);
    assert.doesNotMatch(formatted, /OLD_AUTH_SECRET|NEW_AUTH_SECRET|OLD_MULTILINE_AUTH_SECRET|NEW_MULTILINE_AUTH_SECRET|OLD_BLOCK_SECRET|NEW_BLOCK_SECRET|OLD_HUNK_SECRET|NEW_HUNK_SECRET|OLD_BARE_TOKEN|NEW_BARE_TOKEN|OLD_CAMEL_TOKEN|NEW_CAMEL_TOKEN|OLD_KEBAB_TOKEN|NEW_KEBAB_TOKEN|OLD_DIFF_TOKEN|NEW_DIFF_TOKEN|OLD_SNAKE_TOKEN|NEW_SNAKE_TOKEN|OLD_YAML_DOUBLE_TOKEN|NEW_YAML_DOUBLE_TOKEN|OLD_YAML_SINGLE_TOKEN|NEW_YAML_SINGLE_TOKEN|OLD_APOSTROPHE_SUFFIX|NEW_APOSTROPHE_SUFFIX|OLD_API_KEY|NEW_API_KEY|OLD_GITHUB_ASSIGNMENT_TOKEN|NEW_GITHUB_ASSIGNMENT_TOKEN|WITH SPACES/);
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
    await fs.writeFile(path.join(root, '.gitignore'), 'z-scope/ignored.js\nprivate/\n!z-scope/private/\nz-scope/private/*\n!**/keep.md\n', 'utf8');
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
    await fs.writeFile(path.join(root, '.gitignore'), '*.log\ncache/\n!/cache/\n/cache/*\n!/cache/keep.json\narchive/\n!*.md\n', 'utf8');
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

test('workspace context applies nested gitignore rules within their directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-nested-gitignore-'));
  try {
    await fs.mkdir(path.join(root, 'packages', 'private'), { recursive: true });
    await fs.mkdir(path.join(root, 'private'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages', '.gitignore'), 'private/\n!private/\nprivate/*\n!private/keep.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'public.js'), 'visible\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'root-public.js'), 'not covered by the nested ignore file\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'private', 'credentials.js'), 'must stay ignored\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'private', 'keep.md'), 'explicitly re-included\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('packages/public.js')), true);
    assert.equal(context.entries.some((entry) => entry.includes('private/root-public.js')), true);
    assert.equal(context.entries.some((entry) => entry.includes('credentials.js')), false);
    assert.equal(context.excerpts.some((item) => item.path.endsWith('credentials.js')), false);
    assert.equal(context.entries.some((entry) => entry.includes('packages/private/keep.md')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context bounds traversal through ignored trees searched for negated patterns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-traversal-budget-'));
  try {
    await fs.mkdir(path.join(root, 'private'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'private/*\n!private/zzz-keep.md\n', 'utf8');
    for (let index = 0; index < 200; index += 1) {
      await fs.writeFile(path.join(root, 'private', `${String(index).padStart(3, '0')}.js`), 'ignored\n', 'utf8');
    }
    await fs.writeFile(path.join(root, 'private', 'zzz-keep.md'), 're-included\n', 'utf8');

    const bounded = await collectWorkspaceContext(root, { maxFiles: 3, maxBytes: 5000 });
    assert.equal(bounded.entries.some((entry) => entry.includes('private/zzz-keep.md')), false);
    assert.equal(bounded.truncated, true);

    const withRoom = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(withRoom.entries.some((entry) => entry.includes('private/zzz-keep.md')), true);
    assert.equal(withRoom.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context is not marked truncated when exactly maxFiles are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-context-exact-limit-'));
  try {
    await fs.writeFile(path.join(root, 'only.js'), 'one file\n', 'utf8');
    const context = await collectWorkspaceContext(root, { maxFiles: 1 });
    assert.deepEqual(context.entries.map((entry) => entry.split(/\s+/)[0]), ['only.js']);
    assert.equal(context.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context does not treat a trailing /** pattern as ignoring its directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-double-star-'));
  try {
    await fs.mkdir(path.join(root, 'cache'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'cache/**\n', 'utf8');
    await fs.writeFile(path.join(root, 'cache', 'generated.js'), 'ignored by the pattern\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.includes('cache/'), true);
    assert.equal(context.entries.some((entry) => entry.includes('cache/generated.js')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context cannot re-include files below an ignored parent directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-negated-glob-'));
  try {
    await fs.mkdir(path.join(root, 'private'), { recursive: true });
    await fs.mkdir(path.join(root, 'open'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'private/\n!**/keep.md\nopen/*\n!**/keep.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'keep.md'), 'explicitly re-included\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'drop.js'), 'still ignored\n', 'utf8');
    await fs.writeFile(path.join(root, 'open', 'keep.md'), 'allowed because its parent is not ignored\n', 'utf8');
    await fs.writeFile(path.join(root, 'open', 'drop.js'), 'ignored by a file pattern\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('private/keep.md')), false);
    assert.equal(context.entries.some((entry) => entry.includes('open/keep.md')), true);
    assert.equal(context.excerpts.some((item) => item.path === 'open/keep.md'), true);
    assert.equal(context.entries.some((entry) => entry.includes('private/drop.js')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context does not re-include files under ignored parents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-excluded-parent-'));
  try {
    await fs.mkdir(path.join(root, 'private'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'private/\n!**/keep.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'keep.md'), 'still ignored because its parent is ignored\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'drop.js'), 'still ignored\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('private/keep.md')), false);
    assert.equal(context.excerpts.some((item) => item.path === 'private/keep.md'), false);
    assert.equal(context.entries.some((entry) => entry.includes('private/drop.js')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context does not apply a directory-only ignore rule to same-named files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-directory-only-'));
  try {
    await fs.writeFile(path.join(root, '.gitignore'), 'private/\n', 'utf8');
    await fs.writeFile(path.join(root, 'private'), 'this is a file\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.startsWith('private  ')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context fails closed for oversized gitignore files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-large-gitignore-'));
  try {
    await fs.writeFile(path.join(root, '.gitignore'), '#'.repeat(256 * 1024 + 1), 'utf8');
    await fs.writeFile(path.join(root, 'private-notes.js'), 'must not be sent\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('private-notes.js')), false);
    assert.equal(context.excerpts.some((item) => item.path === 'private-notes.js'), false);
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

test('workspace context keeps leading-slash gitignore patterns anchored at the root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-root-anchor-'));
  try {
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), '/config.json\n', 'utf8');
    await fs.writeFile(path.join(root, 'config.json'), 'root config\n', 'utf8');
    await fs.writeFile(path.join(root, 'nested', 'config.json'), 'nested config\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.includes('config.json') && !entry.includes('nested/')), false);
    assert.equal(context.entries.some((entry) => entry.includes('nested/config.json')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace context honors escaped literals and trailing spaces in gitignore patterns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-gitignore-escaped-space-'));
  try {
    await fs.writeFile(path.join(root, '.gitignore'), 'private\\ \nliteral\\*\nliteral\\?\n', 'utf8');
    await fs.mkdir(path.join(root, 'private'));
    await fs.writeFile(path.join(root, 'private', 'keep.md'), 'the escaped trailing-space pattern must not ignore this directory\n', 'utf8');
    if (process.platform !== 'win32') {
      // Win32 forbids or normalizes these path characters, so verify exact escaped-literal matches on POSIX only.
      await fs.writeFile(path.join(root, 'private '), 'must not be sent\n', 'utf8');
      await fs.writeFile(path.join(root, 'literal*'), 'must not be sent\n', 'utf8');
      await fs.writeFile(path.join(root, 'literal?'), 'must not be sent\n', 'utf8');
    }
    await fs.writeFile(path.join(root, 'literalX'), 'ordinary glob characters still match\n', 'utf8');

    const context = await collectWorkspaceContext(root, { maxFiles: 20, maxBytes: 5000 });
    assert.equal(context.entries.some((entry) => entry.startsWith('private/keep.md')), true);
    if (process.platform !== 'win32') {
      assert.equal(context.entries.some((entry) => entry.startsWith('private ')), false);
      assert.equal(context.entries.some((entry) => entry.startsWith('literal*')), false);
      assert.equal(context.entries.some((entry) => entry.startsWith('literal?')), false);
    }
    assert.equal(context.entries.some((entry) => entry.startsWith('literalX')), true);
    if (process.platform !== 'win32') assert.equal(context.excerpts.some((item) => item.path === 'private '), false);
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

test('opt-in Git diff excludes untracked files', async () => {
  try { await execFileAsync('git', ['--version']); } catch { return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-git-untracked-diff-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Merge Room Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'merge-room-test@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.js\n', 'utf8');
    await fs.writeFile(path.join(root, 'base.js'), 'const base = true;\n', 'utf8');
    await execFileAsync('git', ['add', '.gitignore', 'base.js'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });

    await fs.writeFile(path.join(root, 'new-feature.js'), 'const NEW_UNTRACKED_FEATURE = true;\n', 'utf8');
    await fs.writeFile(path.join(root, 'large.js'), `const LARGE_UNTRACKED = '${'x'.repeat(20000)}';\n`, 'utf8');
    await fs.writeFile(path.join(root, 'empty.js'), '', 'utf8');
    await fs.writeFile(path.join(root, 'ignored.js'), 'const IGNORED_UNTRACKED = true;\n', 'utf8');
    await fs.writeFile(path.join(root, 'credentials.js'), 'const SECRET_UNTRACKED = true;\n', 'utf8');
    const context = await collectWorkspaceContext(root, { includeDiff: true });
    assert.doesNotMatch(context.git.diff, /NEW_UNTRACKED_FEATURE|LARGE_UNTRACKED|IGNORED_UNTRACKED|SECRET_UNTRACKED/);
    assert.ok(Buffer.byteLength(context.git.diff, 'utf8') <= 12000);
    assert.equal(context.git.diff, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('opt-in Git diff excludes tracked secrets and ignored paths', async () => {
  try { await execFileAsync('git', ['--version']); } catch { return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-git-filtered-diff-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Merge Room Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'merge-room-test@example.invalid'], { cwd: root });
    await fs.mkdir(path.join(root, 'node_modules', 'sample'), { recursive: true });
    await fs.mkdir(path.join(root, 'packages'), { recursive: true });
    await fs.mkdir(path.join(root, 'private'), { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\nprivate/\n!**/keep.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', '.gitignore'), 'local.md\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'local.md'), 'BASE NESTED IGNORED\n', 'utf8');
    await fs.writeFile(path.join(root, 'app.js'), 'const state = "base";\n', 'utf8');
    await fs.writeFile(path.join(root, 'credentials.json'), '{"value":"base"}\n', 'utf8');
    await fs.writeFile(path.join(root, 'private.pem'), 'BASE KEY\n', 'utf8');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'BASE IGNORED\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'keep.md'), 'BASE PRIVATE\n', 'utf8');
    await fs.writeFile(path.join(root, 'node_modules', 'sample', 'library.js'), 'BASE DEPENDENCY\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'visible.js'), 'const visible = "base";\n', 'utf8');
    const newlineStatusPath = process.platform === 'win32' ? null : path.join(root, 'status\ninjection.js');
    if (newlineStatusPath) await fs.writeFile(newlineStatusPath, 'const status = "base";\n', 'utf8');
    await execFileAsync('git', ['add', '-f', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });

    await fs.writeFile(path.join(root, 'app.js'), 'const state = "SAFE_VISIBLE_CHANGE";\n', 'utf8');
    await fs.writeFile(path.join(root, 'credentials.json'), '{"value":"SECRET_CREDENTIAL_CHANGE"}\n', 'utf8');
    await fs.writeFile(path.join(root, 'private.pem'), 'PRIVATE_KEY_CHANGE\n', 'utf8');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'IGNORED_FILE_CHANGE\n', 'utf8');
    await fs.writeFile(path.join(root, 'private', 'keep.md'), 'PARENT_IGNORED_CHANGE\n', 'utf8');
    await fs.writeFile(path.join(root, 'node_modules', 'sample', 'library.js'), 'DEPENDENCY_FILE_CHANGE\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'local.md'), 'NESTED_IGNORED_CHANGE\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'visible.js'), 'const visible = "NESTED_VISIBLE_CHANGE";\n', 'utf8');
    if (newlineStatusPath) await fs.writeFile(newlineStatusPath, 'const status = "changed";\n', 'utf8');

    const context = await collectWorkspaceContext(root, { includeDiff: true, maxBytes: 5000 });
    assert.match(context.git.diff, /SAFE_VISIBLE_CHANGE/);
    assert.match(context.git.diff, /NESTED_VISIBLE_CHANGE/);
    assert.doesNotMatch(context.git.diff, /SECRET_CREDENTIAL_CHANGE|PRIVATE_KEY_CHANGE|IGNORED_FILE_CHANGE|PARENT_IGNORED_CHANGE|DEPENDENCY_FILE_CHANGE|NESTED_IGNORED_CHANGE/);
    assert.doesNotMatch(context.git.diffStat, /credentials\.json|private\.pem|ignored\.txt|node_modules/);
    assert.match(context.git.status, /app\.js/);
    assert.doesNotMatch(context.git.status, /credentials\.json|private\.pem|ignored\.txt|node_modules|local\.md/);
    if (newlineStatusPath) {
      assert.match(context.git.status, /status\?injection\.js/);
      assert.doesNotMatch(context.git.status, /(^|\n)injection\.js/);
    }
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
    const savedAtStamp = reopened.savedAt.replaceAll(':', '-').replaceAll('.', '-');
    assert.ok(saved.id.startsWith(`${savedAtStamp}-`));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);
    assert.equal(listed[0].answer, undefined);
    assert.equal(reopened.answer, 'Test answer');
    assert.equal(reopened.request, 'Test mission');
    assert.equal(await readSession('missing', root, 'sessions'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('saved sessions and their directory have private POSIX permissions', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-permissions-'));
  const parent = path.join(root, 'custom');
  const sessions = path.join(parent, 'sessions');
  try {
    await fs.mkdir(parent, { mode: 0o755 });
    await fs.mkdir(sessions, { mode: 0o755 });
    await fs.chmod(root, 0o755);
    await fs.chmod(parent, 0o755);
    await fs.chmod(sessions, 0o755);

    const saved = await saveSession({ request: 'private mission' }, root, 'custom/sessions');
    const rootMode = (await fs.stat(root)).mode & 0o777;
    const parentMode = (await fs.stat(parent)).mode & 0o777;
    const sessionMode = (await fs.stat(sessions)).mode & 0o777;
    const fileMode = (await fs.stat(saved.file)).mode & 0o777;
    assert.equal(rootMode, 0o755, 'workspace directory permissions should remain unchanged');
    assert.equal(parentMode, 0o755, 'custom ancestor permissions should remain unchanged');
    assert.equal(sessionMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session directory permission update does not follow a substituted symlink', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-symlink-race-'));
  const sessions = path.join(root, 'sessions');
  const movedSessions = path.join(root, 'sessions-moved');
  const victim = path.join(root, 'victim');
  const originalOpen = fs.open;
  let substituted = false;
  try {
    await fs.mkdir(sessions, { mode: 0o755 });
    await fs.mkdir(victim, { mode: 0o755 });
    await fs.chmod(sessions, 0o755);
    await fs.chmod(victim, 0o755);

    fs.open = async (file, ...args) => {
      if (!substituted && file === sessions) {
        substituted = true;
        await fs.rename(sessions, movedSessions);
        await fs.symlink(victim, sessions, 'dir');
      }
      return originalOpen(file, ...args);
    };

    await assert.rejects(saveSession({ request: 'do not chmod the symlink target' }, root, 'sessions'));
    assert.equal(substituted, true, 'the path should be swapped after validation and before open');
    assert.equal((await fs.stat(victim)).mode & 0o777, 0o755, 'the symlink target permissions must remain unchanged');
  } finally {
    fs.open = originalOpen;
    try { await fs.rm(sessions, { force: true }); } catch {}
    try { await fs.rename(movedSessions, sessions); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('saving sessions outside the workspace does not chmod an ancestor', { skip: process.platform === 'win32' }, async () => {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-external-permissions-'));
  const workspace = path.join(container, 'workspace');
  try {
    await fs.mkdir(workspace, { mode: 0o755 });
    await fs.chmod(container, 0o755);
    await fs.chmod(workspace, 0o755);

    const saved = await saveSession({ request: 'external destination' }, workspace, '..');
    assert.equal((await fs.stat(container)).mode & 0o777, 0o755, 'external destination directory permissions should remain unchanged');
    assert.equal((await fs.stat(saved.file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(container, { recursive: true, force: true });
  }
});

test('session filenames remain canonical when saved JSON is hand-edited', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-canonical-id-'));
  const sessions = path.join(root, 'sessions');
  try {
    await fs.mkdir(sessions);
    await fs.writeFile(path.join(sessions, 'first.json'), JSON.stringify({ id: 'second', request: 'edited first request', answer: 'first answer' }), 'utf8');
    await fs.writeFile(path.join(sessions, 'second.json'), JSON.stringify({ id: 'second', request: 'second request', answer: 'second answer' }), 'utf8');

    const listed = await listSessions(root, 'sessions');
    assert.deepEqual(listed.map(({ id }) => id), ['second', 'first']);
    assert.equal((await readSession(listed[1].id, root, 'sessions')).id, 'first');
    assert.equal((await readSession('first', root, 'sessions')).request, 'edited first request');
    assert.equal((await readSession('first', root, 'sessions')).answer, 'first answer');
    assert.equal(JSON.parse(await fs.readFile(path.join(sessions, 'first.json'), 'utf8')).id, 'second');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session ids remain unique when time and Math.random collide', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-id-collision-'));
  const OriginalDate = globalThis.Date;
  const originalRandom = Math.random;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : ['2026-01-02T03:04:05.000Z'])); }
    static now() { return new OriginalDate('2026-01-02T03:04:05.000Z').valueOf(); }
  };
  Math.random = () => 0.5;
  try {
    const first = await saveSession({ request: 'first', answer: 'first answer' }, root, 'sessions');
    const second = await saveSession({ request: 'second', answer: 'second answer' }, root, 'sessions');
    assert.notEqual(first.id, second.id);
    const firstSession = await readSession(first.id, root, 'sessions');
    const secondSession = await readSession(second.id, root, 'sessions');
    assert.equal(firstSession.answer, 'first answer');
    assert.equal(secondSession.answer, 'second answer');
    assert.equal(firstSession.savedAt, secondSession.savedAt);
    const stamp = firstSession.savedAt.replaceAll(':', '-').replaceAll('.', '-');
    assert.ok(first.id.startsWith(`${stamp}-`));
    assert.ok(second.id.startsWith(`${stamp}-`));
  } finally {
    globalThis.Date = OriginalDate;
    Math.random = originalRandom;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session id and savedAt use one timestamp across a millisecond boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-timestamp-boundary-'));
  const OriginalDate = globalThis.Date;
  const firstInstant = OriginalDate.parse('2026-01-02T03:04:05.999Z');
  let clockReads = 0;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length) {
        super(...args);
      } else {
        super(firstInstant + clockReads++);
      }
    }
  };
  try {
    const saved = await saveSession({ request: 'timestamp boundary' }, root, 'sessions');
    const reopened = await readSession(saved.id, root, 'sessions');
    const stamp = reopened.savedAt.replaceAll(':', '-').replaceAll('.', '-');
    assert.equal(reopened.savedAt, '2026-01-02T03:04:05.999Z');
    assert.ok(saved.id.startsWith(`${stamp}-`));
  } finally {
    globalThis.Date = OriginalDate;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session readers reject symbolic links that point outside the session directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-symlink-'));
  const sessions = path.join(root, 'sessions');
  const external = path.join(root, 'outside.json');
  await fs.mkdir(sessions);
  await fs.writeFile(external, JSON.stringify({ id: 'leak', request: 'external secret marker' }), 'utf8');
  try {
    await fs.symlink(external, path.join(sessions, 'leak.json'), process.platform === 'win32' ? 'file' : undefined);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      await t.skip(`Symbolic links are unavailable in this environment (${error.code}).`);
      await fs.rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  try {
    assert.equal(await readSession('leak', root, 'sessions'), null);
    assert.deepEqual(await listSessions(root, 'sessions'), []);
    assert.equal((await fs.readFile(external, 'utf8')).includes('external secret marker'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session readers reject a symbolic link in the session directory path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-root-link-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-external-'));
  const ancestorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-ancestor-link-'));
  const externalParent = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-external-parent-'));
  const sessionFile = path.join(external, 'leak.json');
  await fs.mkdir(path.join(externalParent, 'sessions'));
  await fs.writeFile(path.join(externalParent, 'sessions', 'leak.json'), JSON.stringify({ id: 'leak', request: 'external ancestor marker' }), 'utf8');
  await fs.writeFile(sessionFile, JSON.stringify({ id: 'leak', request: 'external directory marker' }), 'utf8');
  try {
    await fs.symlink(external, path.join(root, 'sessions'), process.platform === 'win32' ? 'junction' : undefined);
    await fs.symlink(externalParent, path.join(ancestorRoot, '.merge-room'), process.platform === 'win32' ? 'junction' : undefined);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
    await fs.rm(ancestorRoot, { recursive: true, force: true });
    await fs.rm(externalParent, { recursive: true, force: true });
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      await t.skip(`Symbolic links are unavailable in this environment (${error.code}).`);
      return;
    }
    throw error;
  }
  try {
    assert.equal(await readSession('leak', root, 'sessions'), null);
    assert.deepEqual(await listSessions(root, 'sessions'), []);
    assert.equal(await readSession('leak', ancestorRoot), null);
    assert.deepEqual(await listSessions(ancestorRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
    await fs.rm(ancestorRoot, { recursive: true, force: true });
    await fs.rm(externalParent, { recursive: true, force: true });
  }
});

test('session saving does not create directories below a symbolic-link ancestor', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-write-link-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-write-external-'));
  try {
    await fs.symlink(external, path.join(root, '.merge-room'), process.platform === 'win32' ? 'junction' : undefined);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      await t.skip(`Symbolic links are unavailable in this environment (${error.code}).`);
      return;
    }
    throw error;
  }
  try {
    await assert.rejects(() => saveSession({ request: 'blocked' }, root), /must not contain symbolic links/);
    await assert.rejects(() => fs.access(path.join(external, 'sessions')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  }
});

test('limited session listing keeps newest valid sessions and skips corrupt files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-limit-'));
  const directory = path.join(root, 'sessions');
  try {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '2026-01-03.json'), '{partial JSON');
    await fs.writeFile(path.join(directory, '2026-01-02.json'), JSON.stringify({ id: '2026-01-02', request: 'newest request' }));
    await fs.writeFile(path.join(directory, '2026-01-01.json'), JSON.stringify({ id: '2026-01-01', request: 'older request' }));

    const sessions = await listSessions(root, 'sessions', { limit: 2 });
    assert.deepEqual(sessions.map(({ id }) => id), ['2026-01-02', '2026-01-01']);
    assert.deepEqual(sessions.map(({ request }) => request), ['newest request', 'older request']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded session name selection streams entries and keeps only the newest limit', async () => {
  let yielded = 0;
  async function* entries() {
    for (let index = 0; index < 10000; index += 1) {
      yielded += 1;
      yield { name: `2026-${String(index).padStart(5, '0')}.json` };
      if (index % 100 === 0) yield { name: `notes-${index}.md` };
    }
  }

  const newest = await selectNewestSessionNames(entries(), 3);
  assert.equal(yielded, 10000);
  assert.deepEqual(newest, ['2026-09999.json', '2026-09998.json', '2026-09997.json']);
});

test('limited session summaries read newest candidates once and backfill corrupt recent sessions', async () => {
  const names = [
    '2026-01-06.json', '2026-01-05.json', '2026-01-04.json',
    '2026-01-03.json', '2026-01-02.json', '2026-01-01.json'
  ];
  const valid = new Map(names.slice(1, 4).map((name) => [name, { id: name.slice(0, -5), request: name }]));
  const readNames = [];
  let directoryScans = 0;
  const sessions = await selectNewestSessionSummaries(async () => {
    directoryScans += 1;
    return (async function* () {
      for (const name of names) yield { name };
      yield { name: 'notes.md' };
    })();
  }, 3, async (name) => {
    readNames.push(name);
    return valid.get(name) || null;
  });

  assert.deepEqual(sessions.map(({ id }) => id), ['2026-01-05', '2026-01-04', '2026-01-03']);
  assert.deepEqual(readNames, ['2026-01-06.json', '2026-01-05.json', '2026-01-04.json', '2026-01-03.json']);
  assert.equal(directoryScans, 2, 'a second name-only pass is used only to backfill the corrupt newest session');
});

test('limited session listing returns no sessions for a zero limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-zero-limit-'));
  const directory = path.join(root, 'sessions');
  const originalOpendir = fs.opendir;
  let directoryOpened = false;
  try {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '2026-01-01.json'), JSON.stringify({ id: '2026-01-01' }));
    fs.opendir = async (...args) => {
      directoryOpened = true;
      return originalOpendir(...args);
    };
    assert.deepEqual(await listSessions(root, 'sessions', { limit: 0 }), []);
    assert.equal(directoryOpened, false, 'a zero limit should not open or traverse the session directory');
  } finally {
    fs.opendir = originalOpendir;
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
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ temperature: 2.1 }), 'utf8');
    await assert.rejects(() => loadConfig(root), /temperature.*between 0 and 2/);
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

test('temperature validation follows configured provider and model capabilities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-temperature-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ temperature: 1.5 }), 'utf8');
    assert.equal((await loadConfig(root)).temperature, 1.5);
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      temperature: 2,
      providers: { openai: { type: 'openai-compatible', model: 'gpt-4o-mini' } },
      defaultProvider: 'openai'
    }), 'utf8');
    assert.equal((await loadConfig(root)).temperature, 2);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      temperature: 1.1,
      providers: { claude: { type: 'anthropic', model: 'claude-sonnet-4-6' } },
      defaultProvider: 'claude'
    }), 'utf8');
    await assert.rejects(() => loadConfig(root), /Anthropic temperature.*between 0 and 1/);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      temperature: 0.2,
      providers: { claude: { type: 'anthropic', model: 'claude-opus-4-7' } },
      defaultProvider: 'claude'
    }), 'utf8');
    await assert.rejects(() => loadConfig(root), /only supports its default temperature/);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: { claude: { type: 'anthropic', model: 'claude-opus-4-7' } },
      defaultProvider: 'claude'
    }), 'utf8');
    assert.equal((await loadConfig(root)).temperature, DEFAULT_CONFIG.temperature);
    await assert.rejects(
      () => main(['--cwd', root, '--temperature', '1.1', '--no-context', 'mission']),
      /Anthropic temperature.*between 0 and 1/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  await assert.rejects(() => main(['--temperature', '2.1', '--no-context', 'mission']), /between 0 and 2/);
});

test('temperature validation ignores unreachable provider profiles but protects routed profiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-temperature-routes-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      temperature: 1.5,
      providers: {
        openai: { type: 'openai-compatible', model: 'gpt-4o-mini' },
        unusedClaude: { type: 'anthropic', model: 'claude-sonnet-4-6' }
      },
      leadProvider: 'openai',
      agents: [{ id: 'scout', provider: 'openai' }]
    }), 'utf8');
    const config = await loadConfig(root);
    assert.equal(config.defaultProvider, null);
    assert.equal(createProvider(config).name, 'multi-provider');

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      temperature: 1.5,
      providers: {
        openai: { type: 'openai-compatible', model: 'gpt-4o-mini' },
        claude: { type: 'anthropic', model: 'claude-sonnet-4-6' }
      },
      leadProvider: 'openai',
      agents: [{ id: 'scout', provider: 'claude' }]
    }), 'utf8');
    await assert.rejects(() => loadConfig(root), /Anthropic temperature.*between 0 and 1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('API adapters reject unsupported temperatures before sending requests', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('fetch should not run'); };
  try {
    const openai = new OpenAICompatibleProvider({ ...DEFAULT_CONFIG, temperature: 2.1, retries: 0 }, 'openai-secret');
    await assert.rejects(() => openai.complete({ system: 'system', prompt: 'prompt' }), /OpenAI-compatible temperature.*between 0 and 2/);

    const anthropicRange = new AnthropicProvider({ ...DEFAULT_CONFIG, temperature: 1.1, retries: 0 }, 'anthropic-secret');
    await assert.rejects(() => anthropicRange.complete({ system: 'system', prompt: 'prompt' }), /Anthropic temperature.*between 0 and 1/);

    const anthropicModel = new AnthropicProvider({ ...DEFAULT_CONFIG, model: 'claude-opus-4-7', temperature: 0.2, retries: 0 }, 'anthropic-secret');
    await assert.rejects(() => anthropicModel.complete({ system: 'system', prompt: 'prompt' }), /only supports its default temperature/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic Opus 4.7+ omits the app default temperature parameter', async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'response' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  try {
    const provider = new AnthropicProvider({ ...DEFAULT_CONFIG, model: 'claude-opus-4-7', streaming: false, retries: 0 }, 'anthropic-secret');
    const result = await provider.complete({ system: 'system', prompt: 'prompt' });
    assert.equal(result.text, 'response');
    assert.equal(Object.hasOwn(payload, 'temperature'), false);
  } finally {
    globalThis.fetch = originalFetch;
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

test('project configuration rejects unknown agent options and accepts provider/model overrides', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-config-agent-unknown-'));
  try {
    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({ agents: [{ id: 'scout', speciality: 'security' }] }), 'utf8');
    await assert.rejects(() => loadConfig(root), /agent 1 contains unknown option: `speciality`/);

    await fs.writeFile(path.join(root, 'merge-room.config.json'), JSON.stringify({
      providers: { review: { type: 'openai-compatible', model: 'profile-model' } },
      agents: [{ id: 'scout', provider: 'review', model: 'agent-model' }]
    }), 'utf8');
    const config = await loadConfig(root);
    assert.equal(config.agents[0].provider, 'review');
    assert.equal(config.agents[0].model, 'agent-model');
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

test('CLI treats mission arguments after -- as literal text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-literal-mission-'));
  try {
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, '--provider=demo', '--no-context', '--no-save', '--json', '--', '-leading', 'mission'], { cwd: root, windowsHide: true });
    assert.equal(JSON.parse(stdout).request, '-leading mission');
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

test('CLI rejects one-shot stdin missions larger than 256 KiB', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-stdin-limit-'));
  try {
    await assert.rejects(
      () => runCliWithInput(['--provider=demo', '--no-context', '--no-save', '--json', '-'], 'x'.repeat(256 * 1024 + 1), root),
      /Stdin mission exceeds the 256 KB limit\. Use --prompt-file/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('aborting an in-process CLI stdin read preserves stdin for a later call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-stdin-abort-'));
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { PassThrough } from 'node:stream';
    import { main } from ${JSON.stringify(cliUrl)};
    const stdin = new PassThrough();
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    const args = ['--cwd', ${JSON.stringify(root)}, '--provider=demo', '--no-context', '--no-save', '--no-stream', '--json', '-'];
    const controller = new AbortController();
    const cancelled = main(args, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write('preserved input');
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(stdin.destroyed, false);
    const nextCall = main(args);
    stdin.end(' after cancellation');
    const output = [];
    const originalLog = console.log;
    console.log = (...values) => output.push(values.join(' '));
    try { await nextCall; }
    finally { console.log = originalLog; }
    assert.match(output.join('\\n'), /"request": "preserved input after cancellation"/);
  `;
  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, timeout: 10000 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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

test('usage summary treats prototype-like model names as ordinary model keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-usage-model-keys-'));
  const originalLog = console.log;
  let output = '';
  try {
    const sessionDir = path.join(root, '.merge-room', 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'one.json'), JSON.stringify({
      id: 'one',
      request: 'A model named like a prototype property',
      usage: { input: 7, output: 3, total: 10, calls: 1, byModel: { ['__proto__']: { input: 7, output: 3, total: 10, calls: 1 } } }
    }));
    console.log = (value) => { output = String(value); };
    await main(['--cwd', root, 'usage', '--json']);

    const usage = JSON.parse(output);
    assert.deepEqual(usage.byModel['__proto__'], {
      sessions: 1, total: 10, input: 7, output: 3, calls: 1, estimatedInput: 0, estimatedOutput: 0
    });
    assert.equal(Object.prototype.sessions, undefined);
  } finally {
    console.log = originalLog;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI resume resolves filename prefixes when saved JSON embeds another ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-resume-canonical-id-'));
  const sessionDir = path.join(root, '.merge-room', 'sessions');
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'first.json'), JSON.stringify({ id: 'second', request: 'first file request', answer: 'first file answer' }), 'utf8');
    await fs.writeFile(path.join(sessionDir, 'second.json'), JSON.stringify({ id: 'second', request: 'second file request', answer: 'second file answer' }), 'utf8');
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');
    const { stdout } = await execFileAsync(process.execPath, [bin, 'resume', 'fir', 'follow-up', '--provider=demo', '--no-context', '--no-stream', '--json'], { cwd: root, windowsHide: true });
    const resumed = JSON.parse(stdout);

    assert.deepEqual(resumed.conversation.map(({ request, answer }) => ({ request, answer })), [
      { request: 'first file request', answer: 'first file answer' }
    ]);
    assert.doesNotMatch(JSON.stringify(resumed.conversation), /second file request|second file answer/);
    assert.equal(JSON.parse(await fs.readFile(path.join(sessionDir, 'first.json'), 'utf8')).id, 'second');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI show and export keep filename IDs when saved JSON embeds another ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-session-spoofed-id-'));
  const sessionDir = path.join(root, '.merge-room', 'sessions');
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'first.json'), JSON.stringify({ id: 'second', request: 'first file request', answer: 'first file answer' }), 'utf8');
    await fs.writeFile(path.join(sessionDir, 'second.json'), JSON.stringify({ id: 'second', request: 'second file request', answer: 'second file answer' }), 'utf8');
    const bin = path.resolve(process.cwd(), 'bin', 'merge-room.js');

    const shown = await execFileAsync(process.execPath, [bin, 'show', 'first', '--json'], { cwd: root, windowsHide: true });
    const shownSession = JSON.parse(shown.stdout);
    assert.equal(shownSession.id, 'first');
    assert.equal(shownSession.request, 'first file request');
    assert.equal(shownSession.answer, 'first file answer');

    await execFileAsync(process.execPath, [bin, 'export', 'first', '--format=json', '--output', 'first-export.json'], { cwd: root, windowsHide: true });
    const exportedSession = JSON.parse(await fs.readFile(path.join(root, 'first-export.json'), 'utf8'));
    assert.equal(exportedSession.id, 'first');
    assert.equal(exportedSession.request, 'first file request');
    assert.equal(exportedSession.answer, 'first file answer');
    assert.equal(JSON.parse(await fs.readFile(path.join(sessionDir, 'first.json'), 'utf8')).id, 'second');
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
    await assert.rejects(
      () => execFileAsync(process.execPath, [bin, 'export', saved.sessionId, 'unexpected'], { cwd: root, windowsHide: true }),
      (error) => error.code === 1 && /Unexpected export argument: unexpected/.test(error.stderr)
    );
    const sessionFile = path.join(root, '.merge-room', 'sessions', `${saved.sessionId}.json`);
    const originalSession = await fs.readFile(sessionFile, 'utf8');
    await assert.rejects(
      () => execFileAsync(process.execPath, [bin, 'export', saved.sessionId, '--output', path.relative(root, sessionFile)], { cwd: root, windowsHide: true }),
      (error) => error.code === 1 && /own saved file/.test(error.stderr)
    );
    assert.equal(await fs.readFile(sessionFile, 'utf8'), originalSession);

    const assertAliasRejected = async (alias) => {
      await assert.rejects(
        () => execFileAsync(process.execPath, [bin, 'export', saved.sessionId, '--format=md', '--output', path.relative(root, alias)], { cwd: root, windowsHide: true }),
        (error) => error.code === 1 && /own saved file/.test(error.stderr)
      );
      assert.equal(await fs.readFile(sessionFile, 'utf8'), originalSession);
    };

    const symlinkAlias = path.join(root, 'session-link.md');
    try {
      await fs.symlink(path.relative(path.dirname(symlinkAlias), sessionFile), symlinkAlias, 'file');
      await assertAliasRejected(symlinkAlias);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
    }

    const hardlinkAlias = path.join(root, 'session-hardlink.md');
    try {
      await fs.link(sessionFile, hardlinkAlias);
      await assertAliasRejected(hardlinkAlias);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code)) throw error;
    }

    const ordinaryExport = await execFileAsync(process.execPath, [bin, 'export', saved.sessionId, '--format=md', '--output', 'another-transcript.md'], { cwd: root, windowsHide: true });
    assert.match(ordinaryExport.stdout, /Exported/);
    assert.match(await fs.readFile(path.join(root, 'another-transcript.md'), 'utf8'), /exportable mission/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Cockpit rejects path-like export IDs before scanning or exporting history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-cockpit-export-id-'));
  const sessionDir = path.join(root, '.merge-room', 'sessions');
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalLog = console.log;
  const originalReaddir = fs.readdir;
  const originalWriteFile = fs.writeFile;
  const output = [];
  let historyScans = 0;
  let fileWrites = 0;
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'valid-session.json'), JSON.stringify({ id: 'valid-session' }));
    fs.readdir = async (target, ...args) => {
      if (path.resolve(String(target)) === sessionDir) historyScans += 1;
      return originalReaddir(target, ...args);
    };
    fs.writeFile = async (target, ...args) => {
      if (path.resolve(String(target)).startsWith(`${root}${path.sep}`)) fileWrites += 1;
      return originalWriteFile(target, ...args);
    };
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['/export ../outside md\n/quit\n']) });
    console.log = (...args) => output.push(args.join(' '));

    await main(['--cwd', root, 'interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream']);

    assert.equal(historyScans, 0);
    assert.equal(fileWrites, 0);
    assert.match(output.join('\n'), /Session ids may only contain letters, numbers, underscores, and dashes\./);
    assert.equal(await fs.readFile(path.join(sessionDir, 'valid-session.json'), 'utf8'), JSON.stringify({ id: 'valid-session' }));
  } finally {
    console.log = originalLog;
    fs.readdir = originalReaddir;
    fs.writeFile = originalWriteFile;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('starter config creation is exclusive and preserves a populated config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-init-exclusive-'));
  try {
    const attempts = await Promise.all(Array.from({ length: 8 }, () => writeStarterConfig(root)));
    assert.equal(attempts.filter((result) => result.created).length, 1);
    assert.equal(attempts.filter((result) => !result.created).length, 7);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'merge-room.config.json'), 'utf8')), DEFAULT_CONFIG);

    const custom = '{"model":"keep-existing-config"}\n';
    await fs.writeFile(path.join(root, 'merge-room.config.json'), custom, 'utf8');
    const existing = await writeStarterConfig(root);
    assert.equal(existing.created, false);
    assert.equal(await fs.readFile(existing.file, 'utf8'), custom);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('interactive export explains when session history is disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-export-disabled-'));
  try {
    const configFile = path.join(root, 'merge-room.config.json');
    await fs.writeFile(configFile, JSON.stringify({ provider: 'demo', sessionDir: null }), 'utf8');

    const cliUrl = new URL('../src/cli.js', import.meta.url).href;
    const script = `process.stdin.isTTY = true; process.stdout.isTTY = true; const { main } = await import(${JSON.stringify(cliUrl)}); main(['--config', ${JSON.stringify(configFile)}, 'interactive']).catch((error) => { console.error(error); process.exitCode = 1; });`;
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let quitSent = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timeout = setTimeout(() => {
        child.kill();
        const stripAnsi = (text) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
        reject(new Error(`Timed out waiting for the interactive export notice.\nstdout:\n${stripAnsi(stdout)}\nstderr:\n${stripAnsi(stderr)}`));
      }, 25000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', (chunk) => {
        if (!quitSent && stdout.includes('Session history is disabled.')) { quitSent = true; child.stdin.end('/quit\n'); }
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
      child.stdin.write('/export last\n');
    });

    assert.match(`${stdout}\n${stderr}`, /Session history is disabled\./);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /path argument.*null|ERR_INVALID_ARG_TYPE/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Cockpit ignores a saved-session load that finishes after quit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-show-after-quit-'));
  try {
    const sessionDir = path.join(root, '.merge-room', 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'delayed-show.json'), JSON.stringify({ id: 'delayed-show', request: 'saved room request', answer: 'saved room answer', agents: [] }), 'utf8');
    const cliUrl = new URL('../src/cli.js', import.meta.url).href;
    const script = `
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      process.env.TERM = 'xterm-256color';
      const { main } = await import(${JSON.stringify(cliUrl)});
      let rejectRead;
      const delayedRead = new Promise((resolve, reject) => { rejectRead = reject; });
      main(['--cwd', ${JSON.stringify(root)}, 'interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream'], {
        readSessionFn: async () => {
          process.stderr.write('READ_STARTED\\n');
          await delayedRead;
        }
      }).then(async () => {
        process.stderr.write('MAIN_RETURNED\\n');
        rejectRead(new Error('deferred show rejection after quit'));
        await new Promise((resolve) => setImmediate(resolve));
        process.stderr.write('READ_REJECTED\\n');
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let showSent = false;
      let quitSent = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out waiting for delayed Cockpit show shutdown.')); }, 5000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!showSent && stdout.includes('MERGE ROOM')) {
          showSent = true;
          child.stdin.write('/show delayed-show\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (!quitSent && stderr.includes('READ_STARTED')) {
          quitSent = true;
          child.stdin.write('/quit\n');
        }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
    });
    const cleanOutput = stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const exitIndex = cleanOutput.lastIndexOf('Both rooms closed');
    assert.notEqual(exitIndex, -1);
    const mainReturnedIndex = stderr.indexOf('MAIN_RETURNED');
    const readRejectedIndex = stderr.indexOf('READ_REJECTED');
    assert.ok(mainReturnedIndex >= 0 && mainReturnedIndex < readRejectedIndex, 'quit should return before the deferred saved-session read rejects');
    assert.doesNotMatch(cleanOutput.slice(exitIndex + 1), /saved room answer|Loaded delayed-show into Room|MERGE ROOM/);
    assert.doesNotMatch(cleanOutput, /deferred show rejection after quit/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Cockpit does not load a saved mission into a room after the user switches away during the read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-show-after-switch-'));
  try {
    const sessionDir = path.join(root, '.merge-room', 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'delayed-show.json'), JSON.stringify({ id: 'delayed-show', request: 'saved room request', answer: 'saved room answer', agents: [] }), 'utf8');
    const cliUrl = new URL('../src/cli.js', import.meta.url).href;
    const script = `
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      process.env.TERM = 'xterm-256color';
      const { main } = await import(${JSON.stringify(cliUrl)});
      const { existsSync } = await import('node:fs');
      main(['--cwd', ${JSON.stringify(root)}, 'interactive', '--provider=demo', '--no-context', '--no-save', '--no-stream'], {
        readSessionFn: async () => {
          process.stderr.write('READ_STARTED\\n');
          while (!existsSync(${JSON.stringify(path.join(root, 'release-read'))})) await new Promise((resolve) => setTimeout(resolve, 10));
          process.stderr.write('READ_RESOLVED\\n');
          return { id: 'delayed-show', request: 'saved room request', answer: 'saved room answer', agents: [] };
        }
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let showSent = false;
      let switchRequested = false;
      let switchDisplayed = false;
      let readResolved = false;
      let roomReselected = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Timed out waiting for delayed Cockpit show switch test. stdout=${stdout} stderr=${stderr}`)); }, 10000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!showSent && stdout.includes('MERGE ROOM')) {
          showSent = true;
          child.stdin.write('/show delayed-show\n');
        }
        if (switchRequested && !switchDisplayed && stdout.includes('Switched to Room 2.')) {
          switchDisplayed = true;
          fs.writeFile(path.join(root, 'release-read'), 'ready').catch(reject);
        }
        if (readResolved && !roomReselected && stdout.includes('Switched to Room 1.')) {
          roomReselected = true;
          child.stdin.end('/quit\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (!switchRequested && stderr.includes('READ_STARTED')) {
          switchRequested = true;
          child.stdin.write('/2\n');
        }
        if (!readResolved && stderr.includes('READ_RESOLVED')) {
          readResolved = true;
          child.stdin.write('/1\n');
        }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`));
      });
    });

    const cleanOutput = stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    assert.match(stderr, /READ_STARTED[\s\S]*READ_RESOLVED/);
    assert.match(cleanOutput, /Both rooms closed/);
    assert.doesNotMatch(cleanOutput, /saved room answer|Loaded delayed-show into Room 1/);
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

test('main returns strict degraded status without changing the process exit code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-main-strict-'));
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  process.exitCode = 37;
  console.log = () => {};
  try {
    const status = await main(['--cwd', root, '--provider=demo', '--strict', '--max-calls=1', '--no-context', '--no-save', '--json', 'strict mission']);
    assert.equal(status, 2);
    assert.equal(process.exitCode, 37);

    const successStatus = await main(['--help']);
    assert.equal(successStatus, undefined);
    assert.equal(process.exitCode, 37);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
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

test('CLI rejects empty and duplicate option values before interpreting the mission', async () => {
  await assert.rejects(() => main(['--max-calls', '', 'mission']), /--max-calls expects a value/);
  await assert.rejects(() => main(['--temperature', '   ', 'mission']), /--temperature expects a value/);
  await assert.rejects(() => main(['--max-calls=2', '--max-calls', '3', 'mission']), /--max-calls may only be specified once/);
  await assert.rejects(() => main(['--max-calls', '2', '--max-calls=3', 'mission']), /--max-calls may only be specified once/);
  await assert.rejects(() => main(['--cwd', '.', '-C', '.', 'mission']), /--cwd may only be specified once/);
});
