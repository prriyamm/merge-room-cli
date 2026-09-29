import test from 'node:test';
import assert from 'node:assert/strict';
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
