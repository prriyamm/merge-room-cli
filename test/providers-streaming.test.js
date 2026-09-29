import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { AnthropicProvider } from '../src/providers.js';

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
