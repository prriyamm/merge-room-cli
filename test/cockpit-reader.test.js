import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { applyCockpitEvent, beginCockpitTurn, createCockpitState, loadCockpitSession, navigateCockpitReader, openCockpitReader, resetCockpitRoom, selectCockpitRoom } from '../src/cockpit.js';
import { cockpitReaderPage, createCockpitRenderer } from '../src/ui.js';
import { main } from '../src/cli.js';

test('answer reader keeps a room snapshot stable while synthesis continues', () => {
  const state = createCockpitState([{ id: 'scout', name: 'Scout' }]);
  beginCockpitTurn(state, 0, 'First mission', state.rooms[0].agents);
  applyCockpitEvent(state, 0, { type: 'synthesis:delta', delta: 'FIRST streamed paragraph.' });
  const snapshot = openCockpitReader(state, 'answer');
  applyCockpitEvent(state, 0, { type: 'synthesis:delta', delta: '\nSECOND streamed paragraph.' });
  applyCockpitEvent(state, 1, { type: 'synthesis:delta', delta: 'OTHER room.' });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.text, 'FIRST streamed paragraph.');
  assert.match(snapshot.title, /PARTIAL ANSWER.*LIVE SNAPSHOT/);
  assert.equal(state.rooms[1].reader, null);
  const refreshed = openCockpitReader(state, 'answer');
  assert.match(refreshed.text, /FIRST[\s\S]*SECOND/);
  assert.doesNotMatch(refreshed.text, /OTHER/);
});

test('reader closes on room selection, new turns, reset, and saved-session load', () => {
  const state = createCockpitState([{ id: 'scout', name: 'Scout' }]);
  const room = state.rooms[0];
  room.final = 'Existing answer';
  openCockpitReader(state, 'answer');
  selectCockpitRoom(state, 2);
  assert.equal(room.reader, null);
  selectCockpitRoom(state, 1);
  openCockpitReader(state, 'answer');
  beginCockpitTurn(state, 0, 'Next mission', room.agents);
  assert.equal(room.reader, null);
  room.running = false;
  room.final = 'New answer';
  openCockpitReader(state, 'answer');
  loadCockpitSession(room, { request: 'Saved', answer: 'Restored', agents: [] });
  assert.equal(room.reader, null);
  openCockpitReader(state, 'answer');
  resetCockpitRoom(state, 0);
  assert.equal(state.rooms[0].reader, null);
});

test('cancelled and failed answer snapshots retain their partial meaning and reason', () => {
  for (const status of ['cancelled', 'error']) {
    const state = createCockpitState();
    state.rooms[0].status = status;
    state.rooms[0].error = status === 'cancelled' ? 'Mission cancelled.' : 'Connection failed.';
    state.rooms[0].final = 'Useful partial answer.';
    const snapshot = openCockpitReader(state, 'answer');
    assert.match(snapshot.title, /PARTIAL ANSWER/);
    assert.match(snapshot.title, status === 'cancelled' ? /CANCELLED/ : /FAILED/);
    assert.equal(snapshot.text, `${state.rooms[0].error}\n\nUseful partial answer.`);
  }
});

test('handoff reader discovers captured room IDs and retains multiline notes', () => {
  const state = createCockpitState([{ id: 'old-specialist', name: 'Original' }]);
  const room = state.rooms[0];
  room.notes['old-specialist'] = 'First paragraph.\n\n- list item one\n- list item two';
  room.statuses['old-specialist'] = 'done';
  assert.match(openCockpitReader(state, 'notes').text, /Original \(old-specialist\).*done\nRead: \/notes old-specialist/);
  const snapshot = openCockpitReader(state, 'notes', 'old-specialist');
  assert.equal(snapshot.text, room.notes['old-specialist']);
  assert.throws(() => openCockpitReader(state, 'notes', 'future-specialist'), /No specialist.*Room 1/);
  const layout = cockpitReaderPage(room.reader, 80, 12);
  assert.deepEqual(layout.body.slice(0, 4), ['First paragraph.', '', '- list item one', '- list item two']);
});

test('reader pages reach the beginning, middle and end and clamp after resize', () => {
  const state = createCockpitState();
  state.rooms[0].final = Array.from({ length: 41 }, (_, index) => `line-${index + 1}`).join('\n');
  openCockpitReader(state, 'answer');
  const reader = state.rooms[0].reader;
  const seen = [];
  const first = cockpitReaderPage(reader, 60, 8);
  seen.push(...first.body);
  assert.equal(first.body[0], 'line-1');
  for (let page = 2; page <= first.pageCount; page += 1) {
    navigateCockpitReader(state, 1);
    seen.push(...cockpitReaderPage(reader, 60, 8).body);
  }
  assert.ok(seen.includes('line-21'));
  assert.ok(seen.includes('line-41'));
  navigateCockpitReader(state, 1);
  assert.equal(reader.page, first.pageCount);
  const enlarged = cockpitReaderPage(reader, 120, 70);
  assert.equal(enlarged.page, 1);
  assert.equal(enlarged.pageCount, 1);
  assert.ok(enlarged.body.includes('line-41'));
  navigateCockpitReader(state, -1);
  assert.equal(reader.page, 1);
});

test('small reader panes fit Unicode cells, expose navigation, and strip terminal controls', () => {
  const state = createCockpitState();
  state.rooms[0].answerDraft = '界界 e\u0301 👩‍💻\n\n- safe\x1b]52;c;secret\x07\x1b[2J item\nLAST';
  state.rooms[0].status = 'cancelled';
  openCockpitReader(state, 'answer');
  for (const [columns, rows] of [[8, 6], [8, 10], [18, 5], [30, 5], [60, 3], [1, 2]]) {
    const reader = state.rooms[0].reader;
    const layout = cockpitReaderPage(reader, columns, rows);
    assert.ok(layout.lines.length <= rows - 1, `${columns}×${rows} height`);
    for (const line of layout.lines) {
      const cells = line.replaceAll('👩‍💻', 'xx').replaceAll('e\u0301', 'e').replaceAll('界', 'xx').length;
      assert.ok(cells <= columns, `${columns}×${rows}: ${line}`);
      assert.doesNotMatch(line, /\x1b|secret/);
    }
    if (columns === 8 && rows === 10) {
      assert.ok(layout.lines.some((line) => line.includes('/prev')));
      assert.ok(layout.lines.some((line) => line.includes('/next')));
      assert.ok(layout.lines.some((line) => line.includes('/back')));
      assert.ok(layout.lines.some((line) => line.includes('PARTIAL')));
    }
  }
});

test('dashboard displays the reader snapshot instead of an omitted answer preview', () => {
  const lines = [];
  const renderer = createCockpitRenderer({ config: { agents: [] }, provider: { name: 'demo' }, force: true, columns: 100, rows: 24, write: (line) => lines.push(line) });
  renderer.state.rooms[0].final = 'FIRST answer paragraph.\n\n- A complete list item\nLAST answer paragraph.';
  openCockpitReader(renderer.state, 'answer');
  renderer.render();
  assert.match(lines.join('\n'), /FIRST answer paragraph\.[\s\S]*- A complete list item[\s\S]*LAST answer paragraph\./);
  assert.match(lines.at(-1), /1\/1.*\/prev \/next \/back/);
  assert.doesNotMatch(lines.join('\n'), /earlier.*omitted/);
});

test('scripted answer and handoff commands read complete unsaved text without artifacts', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-unsaved-reader-'));
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const oldKey = process.env.MERGE_ROOM_READER_TEST_KEY;
  let output = '';
  process.env.MERGE_ROOM_READER_TEST_KEY = 'test-key';
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['Mission\n/team critic\n/answer\n/notes\n/notes scout\n/next\n/answer zero\n/notes missing\n/back\n/quit\n']) });
  console.log = (...values) => { output += `${values.join(' ')}\n`; };
  const note = 'HANDOFF-FIRST\n\n- note list\nHANDOFF-LAST';
  const answer = ['ANSWER-FIRST', '', '- answer list', ...Array.from({ length: 50 }, (_, index) => `detail ${index + 1}`), 'ANSWER-LAST'].join('\n');
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: calls++ === 0 ? note : answer } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  try {
    await fs.writeFile(path.join(workspace, 'merge-room.config.json'), JSON.stringify({ providers: { test: { type: 'openai-compatible', baseUrl: 'https://reader.test/v1', apiKeyEnv: 'MERGE_ROOM_READER_TEST_KEY' } }, agents: [{ id: 'scout', name: 'Scout' }, { id: 'critic', name: 'Critic' }] }));
    await main(['--cwd', workspace, 'interactive', '--no-context', '--no-save', '--no-stream', '--team=scout']);
    const answerReader = output.slice(output.indexOf('Room 1 · ANSWER'));
    assert.match(answerReader, /ANSWER-FIRST\n\n- answer list[\s\S]*detail 25[\s\S]*ANSWER-LAST/);
    const noteReader = output.slice(output.indexOf('Room 1 · Scout (scout) · HANDOFF'));
    assert.match(noteReader, /HANDOFF-FIRST\n\n- note list\nHANDOFF-LAST/);
    assert.match(output, /Read: \/notes scout/);
    assert.match(output, /Open \/answer.*before using \/next/);
    assert.match(output, /Use \/answer \[page\]/);
    assert.match(output, /No specialist named missing/);
    assert.deepEqual((await fs.readdir(workspace)).sort(), ['merge-room.config.json']);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    if (oldKey === undefined) delete process.env.MERGE_ROOM_READER_TEST_KEY;
    else process.env.MERGE_ROOM_READER_TEST_KEY = oldKey;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('TTY reader commands navigate full answers and notes, then return to room controls', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-reader-tty-'));
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  await fs.writeFile(path.join(workspace, 'merge-room.config.json'), JSON.stringify({ streaming: false, providers: { test: { type: 'openai-compatible', baseUrl: 'https://reader.test/v1', apiKeyEnv: 'MERGE_ROOM_READER_TEST_KEY' } }, agents: [{ id: 'scout', name: 'Scout' }] }));
  const script = `
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    process.stdout.columns = 60; process.stdout.rows = 8;
    process.env.TERM = 'xterm'; process.env.NO_COLOR = '1'; process.env.MERGE_ROOM_NO_MOTION = '1';
    process.env.MERGE_ROOM_READER_TEST_KEY = 'test-key';
    let calls = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: Array.from({length:21}, (_,i) => (calls === 0 ? 'NOTE' : 'ANSWER') + '-ROW-' + (i+1)).join('\\n') } }], usage: {prompt_tokens:1, completion_tokens:1} }), {status:200});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { const value = await originalFetch(...args); calls++; return value; };
    const { main } = await import(${JSON.stringify(cliUrl)});
    await main(['--cwd', ${JSON.stringify(workspace)}, 'interactive', '--no-context', '--no-save', '--no-stream']);
  `;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      let phase = 0;
      let boundary = 0;
      const steps = [
        [/Start a mission in either room/, 'Mission\n'],
        [/Room 1 finished/, '/answer 2\n'],
        [/2\/5 · snapshot.*\/prev \/next \/back/, '/next\n'],
        [/3\/5 · snapshot.*\/prev \/next \/back/, '/prev\n'],
        [/2\/5 · snapshot.*\/prev \/next \/back/, '/notes\n'],
        [/Read: \/notes scout/, '/notes scout 2\n'],
        [/NOTE-ROW-7[\s\S]*2\/5 · snapshot/, '/back\n'],
        [/Returned to the room dashboard/, '/answer\n'],
        [/ANSWER-ROW-1[\s\S]*1\/5 · snapshot/, '/2\n'],
        [/Switched to Room 2/, '/answer\n'],
        [/Room 2 has no answer yet/, '/1\n'],
        [/Switched to Room 1/, '/answer\n'],
        [/ANSWER-ROW-1[\s\S]*1\/5 · snapshot/, '/new\n'],
        [/Room 1 is ready for a new session/, '/answer\n'],
        [/Room 1 has no answer yet/, '/quit\n']
      ];
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`TTY reader timed out at phase ${phase}: ${output}\n${stderr}`)); }, 10000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const recent = output.slice(boundary).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        if (phase < steps.length && steps[phase][0].test(recent)) {
          const command = steps[phase++][1];
          boundary = output.length;
          child.stdin.write(command);
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0 || phase !== steps.length) reject(new Error(`TTY reader exited ${code} at phase ${phase}: ${stderr}`));
        else resolve(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
      });
    });
    assert.match(output, /ANSWER-ROW-13/);
    assert.match(output, /NOTE-ROW-7/);
    assert.deepEqual((await fs.readdir(workspace)).sort(), ['merge-room.config.json']);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('TTY answer snapshot stays still while streaming completes and refreshes when reopened', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-reader-stream-'));
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  await fs.writeFile(path.join(workspace, 'merge-room.config.json'), JSON.stringify({ providers: { test: { type: 'openai-compatible', baseUrl: 'https://reader.test/v1', apiKeyEnv: 'MERGE_ROOM_READER_TEST_KEY' } }, agents: [{ id: 'scout' }] }));
  const script = `
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    process.stdout.columns = 60; process.stdout.rows = 10;
    process.env.TERM = 'xterm'; process.env.NO_COLOR = '1'; process.env.MERGE_ROOM_NO_MOTION = '1';
    process.env.MERGE_ROOM_READER_TEST_KEY = 'test-key';
    let controller; let released = false;
    const encodeDelta = (text) => new TextEncoder().encode('data: ' + JSON.stringify({choices:[{delta:{content:text}}]}) + '\\n\\n');
    globalThis.fetch = async (url, options) => {
      if (!JSON.parse(options.body).stream) return new Response(JSON.stringify({choices:[{message:{content:'Specialist note'}}]}), {status:200});
      return new Response(new ReadableStream({start(stream) {controller=stream; setTimeout(() => stream.enqueue(encodeDelta('EARLY-STREAM\\n')), 120);}}), {status:200,headers:{'content-type':'text/event-stream'}});
    };
    process.stdin.on('data', (chunk) => {
      if (controller && !released && chunk.toString().includes('/answer')) {
        released=true;
        setTimeout(() => {controller.enqueue(encodeDelta('LATE-STREAM')); controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n')); controller.close(); process.stderr.write('PROVIDER-DONE\\n');}, 100);
      }
    });
    const {main} = await import(${JSON.stringify(cliUrl)});
    await main(['--cwd', ${JSON.stringify(workspace)}, 'interactive', '--no-context', '--no-save']);
  `;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      let phase = 0;
      let readerBoundary = 0;
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Streaming reader timed out at ${phase}: ${output}\n${stderr}`)); }, 5000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        if (phase === 0 && output.includes('Start a mission')) { phase = 1; child.stdin.write('Mission\n'); }
        else if (phase === 1 && output.includes('EARLY-STREAM')) { phase = 2; readerBoundary = output.length; child.stdin.write('/answer\n'); }
        else if (phase === 3 && output.slice(readerBoundary).includes('LATE-STREAM')) { phase = 4; child.stdin.write('/quit\n'); }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (phase === 2 && stderr.includes('PROVIDER-DONE')) {
          try {
            assert.match(output.slice(readerBoundary), /PARTIAL ANSWER.*LIVE SNAPSHOT[\s\S]*EARLY-STREAM/);
            assert.doesNotMatch(output.slice(readerBoundary), /LATE-STREAM/);
            phase = 3;
            readerBoundary = output.length;
            child.stdin.write('/answer\n');
          } catch (error) { child.kill(); clearTimeout(timeout); reject(error); }
        }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0 || phase !== 4) reject(new Error(`Streaming reader exited ${code} at ${phase}: ${stderr}`));
        else resolve();
      });
    });
    assert.deepEqual((await fs.readdir(workspace)).sort(), ['merge-room.config.json']);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
