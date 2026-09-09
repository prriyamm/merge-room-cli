import { estimateTokens } from './tokens.js';

export function createProvider(config) {
  const apiKey = process.env.LOOM_API_KEY || process.env.OPENAI_API_KEY;
  const mode = String(config.provider || 'auto').trim().toLowerCase();
  if (!['auto', 'demo'].includes(mode)) throw new Error('Provider mode must be `auto` or `demo`.');
  if (mode === 'demo' || !apiKey) return new DemoProvider(config);
  return new OpenAICompatibleProvider(config, apiKey);
}

export class OpenAICompatibleProvider {
  constructor(config, apiKey) { this.config = config; this.apiKey = apiKey; this.name = 'openai-compatible'; this.model = config.model; }

  async complete({ system, prompt, signal, onDelta, model: modelOverride }) {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const streaming = typeof onDelta === 'function' && this.config.streaming !== false;
    const payload = { model: modelOverride || this.config.model, temperature: this.config.temperature, max_tokens: this.config.maxTokens, ...(streaming ? { stream: true, ...(this.config.streamUsage ? { stream_options: { include_usage: true } } : {}) } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
    const attempts = Math.max(0, Number(this.config.retries) || 0) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.requestTimeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let providerError = false;
      try {
        const response = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(payload) });
        if (!response.ok) {
          providerError = true;
          const body = await response.json().catch(() => ({}));
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < attempts - 1) { await delay(250 * (attempt + 1), signal); continue; }
          throw new Error(body.error?.message || `Provider returned HTTP ${response.status}`);
        }
        if (streaming && response.body?.getReader) {
          const streamed = await readStream(response.body, onDelta);
          if (!streamed.text) throw new Error('Provider returned an empty response');
          return { text: streamed.text, inputTokens: streamed.usage?.prompt_tokens ?? estimateTokens(`${system}\n${prompt}`), outputTokens: streamed.usage?.completion_tokens ?? estimateTokens(streamed.text), inputEstimated: streamed.usage?.prompt_tokens == null, outputEstimated: streamed.usage?.completion_tokens == null };
        }
        const body = await response.json().catch(() => ({}));
        const text = normalizeContent(body.choices?.[0]?.message?.content).trim();
        if (!text) throw new Error('Provider returned an empty response');
        return { text, inputTokens: body.usage?.prompt_tokens ?? estimateTokens(`${system}\n${prompt}`), outputTokens: body.usage?.completion_tokens ?? estimateTokens(text), inputEstimated: body.usage?.prompt_tokens == null, outputEstimated: body.usage?.completion_tokens == null };
      } catch (error) {
        if (timedOut && !signal?.aborted) { const timeoutError = new Error(`Provider request timed out after ${this.config.requestTimeoutMs}ms`); timeoutError.name = 'TimeoutError'; throw timeoutError; }
        if (attempt < attempts - 1 && !providerError && error.name !== 'AbortError') { await delay(250 * (attempt + 1), signal); continue; }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw new Error('Provider request failed after retries');
  }
}

export class DemoProvider {
  constructor(config) { this.config = config; this.name = 'demo'; this.model = 'local-demo'; }

  async complete({ system, prompt, signal, onDelta }) {
    const request = extractRequest(prompt);
    const label = request.length > 72 ? `${request.slice(0, 72)}…` : request;
    const text = /Scout/i.test(system) ? `Scope: ${label}\n\nConstraint to name: what must be true when this is finished.\nFirst move: write one acceptance check and identify the smallest reversible step.`
      : /Architect/i.test(system) ? `Shape: keep “${label}” as a short loop with clear ownership and one observable output.\n\nBoundary: separate the decision from the implementation detail.\nSequence: establish the interface, make the smallest change, then verify it.`
        : /Maker/i.test(system) ? `Draft for “${label}”: start with the outcome, turn it into 2–3 concrete actions, and attach a check to each action.\n\nUseful default: make the first action runnable in one sitting, then leave a clean handoff for the next person.`
          : /Critic/i.test(system) ? `Review of “${label}”: watch for an undefined finish line, hidden dependencies, and a verification step that only checks the happy path.\n\nCorrection: name the failure case before committing to the implementation.`
            : `A practical starting point for “${label}”:\n\n1. Define the outcome and the constraint.\n2. Make the smallest reversible change.\n3. Verify it with one concrete check.\n\nNext move: write the first acceptance check and assign an owner.`;
    if (typeof onDelta === 'function' && this.config.streaming !== false) {
      const pieces = text.split(/(?<=\s)/);
      for (const piece of pieces) { if (signal?.aborted) throw abortError(); onDelta(piece); await delay(10, signal); }
    } else await delay(160 + Math.random() * 280, signal);
    return { text, inputTokens: estimateTokens(`${system}\n${prompt}`), outputTokens: estimateTokens(text), inputEstimated: true, outputEstimated: true };
  }
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortError() {
  const error = new Error('Mission cancelled.');
  error.name = 'AbortError';
  return error;
}

function extractRequest(prompt) {
  const match = String(prompt).match(/User request:\s*([\s\S]*?)(?:\n\nWork as one member|\n\nEarly team notes|\n\nWorkspace project context|$)/i);
  return (match?.[1] || prompt).replace(/\s+/g, ' ').trim();
}

function normalizeContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return normalizeContent(part.text ?? part.content ?? '');
  }).join('');
}

async function readStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage;
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const piece = normalizeContent(parsed.choices?.[0]?.delta?.content);
      if (piece) { text += piece; onDelta(piece); }
      if (parsed.usage) usage = parsed.usage;
    } catch { /* Ignore an incomplete or provider-specific SSE frame. */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer) consume(buffer);
  return { text: text.trim(), usage };
}
