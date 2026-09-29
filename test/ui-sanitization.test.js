import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createConversationRenderer, stripUnsafeTerminalControls } from '../src/ui.js';

test('terminal output filtering strips OSC 52, cursor controls, bare ESC, and C1 controls', () => {
  const unsafe = [
    'before\x1b]52;c;clipboard payload\x07after',
    'up\x1b[2Aerase\x1b[2Jhome\x1b[Hdone',
    'bare\x1b7escape\x1bXsequence',
    'c1\x9b2Jand\x9d52;c;payload'
  ].join(' ');

  const safe = stripUnsafeTerminalControls(unsafe);
  assert.equal(safe.includes('\x1b]'), false);
  assert.equal(safe.includes('\x1b['), false);
  assert.equal(safe.includes('\x1b'), false);
  assert.equal(safe.includes('\x9b'), false);
  assert.equal(safe.includes('\x9d'), false);
  assert.match(safe, /beforeafter/);
  assert.match(safe, /uperasehomedone/);
});

test('terminal output filtering retains trusted SGR formatting', () => {
  const formatted = '\x1b[31mred\x1b[0m';
  assert.equal(stripUnsafeTerminalControls(formatted), formatted);
});

test('conversation history preserves paragraphs and list lines after sanitizing', () => {
  const lines = [];
  const renderer = createConversationRenderer({
    config: DEFAULT_CONFIG,
    provider: { name: 'demo' },
    force: true,
    write: (line) => lines.push(line)
  });

  renderer.loaded({
    request: 'Review output formatting',
    answer: 'First paragraph.\n\n- item one\n- item two'
  });

  assert.ok(lines.includes('  First paragraph.'));
  assert.ok(lines.includes('  - item one'));
  assert.ok(lines.includes('  - item two'));
});

test('forced cockpit renderer filters hostile dispatch labels and keeps theme styling', () => {
  const stageLabel = 'draft\x1b]52;c;clipboard payload\x07\x1b[2J\nreview';
  const script = `
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.env.TERM = 'xterm';
    delete process.env.NO_COLOR;
    const { createCockpitRenderer } = await import('./src/ui.js?renderer-sanitization-test');
    const writeResult = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    const lines = [];
    const renderer = createCockpitRenderer({
      config: { model: 'test', agents: [] },
      provider: { name: 'demo' },
      force: true,
      columns: 100,
      rows: 30,
      write: (line) => lines.push(line)
    });
    renderer.event(0)({ type: 'agents:dispatch', stageLabel: ${JSON.stringify(stageLabel)}, agentCount: 1 });
    writeResult(JSON.stringify(lines));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const lines = JSON.parse(output);
  const renderedDispatch = lines.find((line) => line.includes('draft review: 1 specialist dispatched'));

  assert.ok(renderedDispatch);
  assert.equal(lines.every((line) => !line.includes('\n')), true);
  assert.doesNotMatch(lines.join('\n'), /clipboard payload|\x1b\]52|\x1b\[2J/);
  assert.ok(lines.some((line) => /\x1b\[[0-?]*m/.test(line)), 'trusted theme SGR styling should remain');
});
