import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MergeRoomEngine } from '../src/engine.js';
import { AnthropicProvider, OpenAICompatibleProvider } from '../src/providers.js';
import { readSession, saveSession } from '../src/sessions.js';

test('OpenAI streaming preserves whitespace chunks in callbacks and saved answers', async () => {
  const originalFetch = globalThis.fetch;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-room-stream-whitespace-'));
  const pieces = ['hello', ' ', 'world', '\n\n', 'Next move:', '\n', '\t', 'verify'];
  const answer = pieces.join('');
  globalThis.fetch = async (_url, options) => JSON.parse(options.body).stream
    ? new Response([
      ...pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
      'data: [DONE]\n\n'
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
    : new Response(JSON.stringify({ choices: [{ message: { content: 'A specialist note.' } }] }), {
      headers: { 'content-type': 'application/json' }
    });

  try {
    const config = { ...DEFAULT_CONFIG, retries: 0, agents: [DEFAULT_CONFIG.agents[0]] };
    const provider = new OpenAICompatibleProvider(config, 'test-secret');
    const deltas = [];
    const result = await new MergeRoomEngine({
      config,
      provider,
      onEvent: (event) => { if (event.type === 'synthesis:delta') deltas.push(event.delta); }
    }).run('Preserve answer formatting');

    assert.deepEqual(deltas, pieces);
    assert.equal(result.answer, answer);
    const saved = await saveSession(result, root);
    assert.equal((await readSession(saved.id, root)).answer, answer);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Anthropic does not emit deltas when streaming is disabled', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'A complete answer.' }],
    usage: { input_tokens: 12, output_tokens: 4 }
  }), { headers: { 'content-type': 'application/json' } });

  try {
    const provider = new AnthropicProvider({
      ...DEFAULT_CONFIG,
      baseUrl: 'https://api.anthropic.com',
      streaming: false,
      retries: 0
    }, 'anthropic-secret');
    const response = await provider.complete({
      system: 'system',
      prompt: 'prompt',
      onDelta: (delta) => deltas.push(delta)
    });

    assert.equal(response.text, 'A complete answer.');
    assert.deepEqual(deltas, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
