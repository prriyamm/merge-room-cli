import { spawn } from 'node:child_process';
import path from 'node:path';
import { estimateTokens } from './tokens.js';
import { validateProviderBaseUrl } from './config.js';

export function createProvider(config, workspace = process.cwd()) {
  const mode = String(config.provider || 'auto').trim().toLowerCase();
  if (!['auto', 'demo'].includes(mode)) throw new Error('Provider mode must be `auto` or `demo`.');
  if (mode === 'demo') return new DemoProvider(config);
  if (config.providers && Object.keys(config.providers).length) return new ProviderRouter(config, workspace);
  const apiKey = process.env.MERGE_ROOM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return new DemoProvider(config);
  return new OpenAICompatibleProvider(config, apiKey);
}

class ProviderRouter {
  constructor(config, workspace) {
    this.config = config;
    this.profiles = new Map();
    for (const [id, profile] of Object.entries(config.providers)) {
      const envName = profile.apiKeyEnv || (profile.type === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
      const apiKey = process.env[envName];
      const cliProvider = ['codex-cli', 'claude-code-cli'].includes(profile.type);
      const adapterConfig = { ...config, ...profile, providerId: id, cwd: workspace, baseUrl: profile.baseUrl || (profile.type === 'anthropic' ? 'https://api.anthropic.com' : config.baseUrl), model: cliProvider ? profile.model : profile.model || config.model, streaming: config.streaming };
      const adapter = profile.type === 'claude-code-cli'
        ? new ClaudeCodeCliProvider(adapterConfig)
        : profile.type === 'codex-cli'
          ? new CodexCliProvider(adapterConfig)
        : profile.type === 'anthropic'
          ? new AnthropicProvider(adapterConfig, apiKey)
          : new OpenAICompatibleProvider(adapterConfig, apiKey);
      this.profiles.set(id, adapter);
    }
    this.defaultProvider = config.defaultProvider || Object.keys(config.providers)[0];
    this.name = 'multi-provider';
    const defaultProfile = config.providers[this.defaultProvider];
    this.model = ['codex-cli', 'claude-code-cli'].includes(defaultProfile?.type) ? defaultProfile.model || (defaultProfile.type === 'codex-cli' ? 'codex-default' : 'claude-code-default') : defaultProfile?.model || config.model;
  }

  complete(options) {
    const id = options.provider || this.defaultProvider;
    const adapter = this.profiles.get(id);
    if (!adapter) throw new Error(`Unknown provider profile \`${id}\`.`);
    if (adapter.requiresApiKey !== false && !adapter.apiKey) throw new Error(`Missing ${adapter.keyEnv} for provider profile \`${id}\`. Set that environment variable to use this route.`);
    return adapter.complete(options);
  }
}

const CLI_OUTPUT_LIMIT = 2 * 1024 * 1024;
const CLI_ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'LANG', 'LC_ALL'];
const CLAUDE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL'];

export class CodexCliProvider {
  constructor(config) {
    this.config = config;
    this.cwd = config.cwd || process.cwd();
    this.timeoutMs = config.requestTimeoutMs;
    this.name = config.providerId || 'codex-cli';
    this.model = config.model || 'codex-default';
    this.requiresApiKey = false;
  }

  async complete({ system, prompt, signal, model: modelOverride }) {
    if (signal?.aborted) throw abortError();
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--config', 'mcp_servers={}'];
    const model = modelOverride || this.config.model;
    if (model) args.push('--model', model);
    args.push('-');
    const input = `You are a read-only Merge Room specialist. Do not attempt to modify files or run commands.\n\n${system}\n\n${prompt}`;
    const output = await runCliProcess('codex', args, input, { cwd: this.cwd, signal, timeoutMs: this.timeoutMs, label: 'Codex CLI', envAllowlist: CLI_ENV_ALLOWLIST });
    const parsed = parseCodexOutput(output);
    return result(parsed.text, parsed.inputTokens, parsed.outputTokens, system, prompt, this.name, model || this.model);
  }
}

export class ClaudeCodeCliProvider {
  constructor(config) {
    this.config = config;
    this.cwd = config.cwd || process.cwd();
    this.timeoutMs = config.requestTimeoutMs;
    this.name = config.providerId || 'claude-code-cli';
    this.model = config.model || 'claude-code-default';
    this.requiresApiKey = false;
  }

  async complete({ system, prompt, signal, model: modelOverride }) {
    if (signal?.aborted) throw abortError();
    const args = ['--restricted', '--print', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--disallowedTools', 'mcp__*', '--max-turns', '1', '--system-prompt', system];
    const model = modelOverride || this.config.model;
    if (model) args.push('--model', model);
    args.push('Respond to the Merge Room request provided on standard input.');
    const output = await runCliProcess('claude', args, prompt, { cwd: this.cwd, signal, timeoutMs: this.timeoutMs, label: 'Claude Code CLI', envAllowlist: CLAUDE_ENV_ALLOWLIST });
    const parsed = parseClaudeCodeOutput(output);
    return result(parsed.text, parsed.inputTokens, parsed.outputTokens, system, prompt, this.name, model || this.model);
  }
}

function runCliProcess(command, args, input, { cwd, signal, timeoutMs, label, envAllowlist }) {
  const env = Object.fromEntries(envAllowlist.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(cliSpawnError(error, label, command)); return; }
    let stdout = '';
    let stdoutBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let terminationSent = false;
    let killTimer;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null || terminationSent) return;
      terminationSent = true;
      killCliProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killCliProcess(child, 'SIGKILL');
      }, 1000);
      killTimer.unref?.();
    };
    const onAbort = () => { aborted = true; terminate(); };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CLI_OUTPUT_LIMIT) { terminate(); finish(new Error(`${label} output exceeded the 2 MiB limit.`)); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', () => {}); // Drain diagnostics without retaining or echoing paths or secrets.
    child.once('error', (error) => finish(cliSpawnError(error, label, command)));
    child.once('close', (code) => {
      if (aborted) { finish(abortError()); return; }
      if (timedOut) { const error = new Error(`${label} timed out after ${timeoutMs}ms.`); error.name = 'TimeoutError'; finish(error); return; }
      if (code !== 0) { finish(new Error(`${label} exited with status ${code}. Check that the CLI is installed and signed in.`)); return; }
      finish(null, stdout);
    });
    child.stdin.once('error', () => {});
    child.stdin.end(input);
  });
}

function killCliProcess(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else if (process.platform === 'win32' && child.pid) {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const killer = spawn(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill(signal));
    } else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill(signal);
  }
}

function cliSpawnError(error, label, command) {
  if (process.platform === 'win32' && ['ENOENT', 'EINVAL'].includes(error?.code)) return new Error(`Could not start ${label}. Install a native \`${command}.exe\` on PATH; Merge Room does not invoke Windows shell shims.`);
  if (error?.code === 'ENOENT') return new Error(`Could not start ${label}. Install \`${command}\` and sign in with its account first.`);
  return new Error(`Could not start ${label}: ${error.message}`);
}

export function parseCodexOutput(output) {
  let text = '';
  let inputTokens;
  let outputTokens;
  let completed = false;
  const eventTypes = [];
  for (const [index, line] of String(output).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`Codex CLI emitted malformed JSONL on line ${index + 1}.`); }
    eventTypes.push(event.type);
    if (event.type === 'error' || event.type === 'turn.failed') throw new Error('Codex CLI reported a failed turn. Check its local sign-in and CLI status.');
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
    if (event.type === 'turn.started') completed = false;
    if (event.type === 'turn.completed') {
      completed = true;
      inputTokens = event.usage?.input_tokens;
      outputTokens = event.usage?.output_tokens;
    }
  }
  if (!completed) throw new Error(`Codex CLI output did not include a completed turn (events: ${eventTypes.join(', ') || 'none'}).`);
  if (!text.trim()) throw new Error('Codex CLI completed without a final assistant message.');
  return { text: text.trim(), inputTokens, outputTokens };
}

export function parseClaudeCodeOutput(output) {
  let body;
  try { body = JSON.parse(String(output).trim()); }
  catch { throw new Error('Claude Code CLI emitted malformed JSON output.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Claude Code CLI returned an invalid JSON response.');
  if (body.is_error === true || body.subtype === 'error') throw new Error('Claude Code CLI reported a failed turn. Check its local sign-in and CLI status.');
  if (typeof body.result !== 'string' || !body.result.trim()) throw new Error('Claude Code CLI completed without a final assistant message.');
  return { text: body.result.trim(), inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
}

export class OpenAICompatibleProvider {
  constructor(config, apiKey) { this.config = { ...config, baseUrl: validateProviderBaseUrl(config.baseUrl, 'OpenAI-compatible baseUrl') }; this.apiKey = apiKey; this.keyEnv = config.apiKeyEnv || 'OPENAI_API_KEY'; this.name = config.providerId || 'openai-compatible'; this.model = config.model || config.defaultModel; }

  async complete({ system, prompt, signal, onDelta, model: modelOverride }) {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const streaming = typeof onDelta === 'function' && this.config.streaming !== false;
    const model = modelOverride || this.model || this.config.model;
    const payload = { model, temperature: this.config.temperature, max_tokens: this.config.maxTokens, ...(streaming ? { stream: true, ...(this.config.streamUsage ? { stream_options: { include_usage: true } } : {}) } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
    const attempts = Math.max(0, Number(this.config.retries) || 0) + 1;
    let emittedDelta = false;
    const emitDelta = (delta) => { if (!delta) return; emittedDelta = true; onDelta?.(delta); };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.requestTimeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let providerError = false;
      try {
        const response = await fetch(url, { method: 'POST', signal: controller.signal, redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(payload) });
        if (!response.ok) {
          providerError = true;
          const body = await response.json().catch(() => ({}));
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < attempts - 1) { await delay(250 * (attempt + 1), signal); continue; }
          throw new Error(body.error?.message || `Provider returned HTTP ${response.status}`);
        }
        if (streaming && response.body?.getReader) {
          const streamed = await readStream(response.body, emitDelta);
          if (!streamed.text) throw new Error('Provider returned an empty response');
          return result(streamed.text, streamed.usage?.prompt_tokens, streamed.usage?.completion_tokens, system, prompt, this.name, model);
        }
        const body = await response.json().catch(() => ({}));
        const text = normalizeContent(body.choices?.[0]?.message?.content).trim();
        if (!text) throw new Error('Provider returned an empty response');
        return result(text, body.usage?.prompt_tokens, body.usage?.completion_tokens, system, prompt, this.name, model);
      } catch (error) {
        if (timedOut && !signal?.aborted) { const timeoutError = new Error(`Provider request timed out after ${this.config.requestTimeoutMs}ms`); timeoutError.name = 'TimeoutError'; throw timeoutError; }
        if (attempt < attempts - 1 && !providerError && !emittedDelta && error.name !== 'AbortError') { await delay(250 * (attempt + 1), signal); continue; }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw new Error('Provider request failed after retries');
  }
}

export class AnthropicProvider {
  constructor(config, apiKey) { this.config = { ...config, baseUrl: validateProviderBaseUrl(config.baseUrl || 'https://api.anthropic.com', 'Anthropic baseUrl') }; this.apiKey = apiKey; this.keyEnv = config.apiKeyEnv || 'ANTHROPIC_API_KEY'; this.name = config.providerId || 'anthropic'; this.model = config.model || config.defaultModel; }

  async complete({ system, prompt, signal, onDelta, model: modelOverride }) {
    const baseUrl = this.config.baseUrl;
    const model = modelOverride || this.model;
    const streaming = typeof onDelta === 'function' && this.config.streaming !== false;
    const attempts = Math.max(0, Number(this.config.retries) || 0) + 1;
    let emittedDelta = false;
    const emitDelta = (delta) => { if (!delta) return; emittedDelta = true; onDelta?.(delta); };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.requestTimeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let providerError = false;
      try {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: this.config.maxTokens, temperature: this.config.temperature, system, messages: [{ role: 'user', content: prompt }], ...(streaming ? { stream: true } : {}) })
        });
        if (!response.ok) {
          providerError = true;
          const body = await response.json().catch(() => ({}));
          if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) { await delay(250 * (attempt + 1), signal); continue; }
          throw new Error(body.error?.message || `Anthropic returned HTTP ${response.status}`);
        }
        if (streaming && response.body?.getReader) {
          const streamed = await readAnthropicStream(response.body, emitDelta);
          if (!streamed.text) throw new Error('Anthropic returned an empty response');
          return result(streamed.text, streamed.inputTokens, streamed.outputTokens, system, prompt, this.name, model);
        }
        const body = await response.json().catch(() => ({}));
        const text = normalizeContent(body.content).trim();
        if (!text) throw new Error('Anthropic returned an empty response');
        emitDelta(text);
        return result(text, body.usage?.input_tokens, body.usage?.output_tokens, system, prompt, this.name, model);
      } catch (error) {
        if (timedOut && !signal?.aborted) { const timeoutError = new Error(`Anthropic request timed out after ${this.config.requestTimeoutMs}ms`); timeoutError.name = 'TimeoutError'; throw timeoutError; }
        if (attempt < attempts - 1 && !providerError && !emittedDelta && error.name !== 'AbortError') { await delay(250 * (attempt + 1), signal); continue; }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw new Error('Anthropic request failed after retries');
  }
}

function result(text, input, output, system, prompt, provider, model) {
  return { text, inputTokens: input ?? estimateTokens(`${system}\n${prompt}`), outputTokens: output ?? estimateTokens(text), inputEstimated: input == null, outputEstimated: output == null, provider, model };
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
    return { text, inputTokens: estimateTokens(`${system}\n${prompt}`), outputTokens: estimateTokens(text), inputEstimated: true, outputEstimated: true, provider: this.name, model: this.model };
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


async function readAnthropicStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = false;
  let inputTokens;
  let outputTokens;
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    try {
      const event = JSON.parse(data);
      if (event.type === 'error') throw new Error(event.error?.message || 'Anthropic stream failed.');
      if (event.type === 'message_stop') completed = true;
      if (event.type === 'message_start') inputTokens = event.message?.usage?.input_tokens;
      if (event.type === 'message_delta') outputTokens = event.usage?.output_tokens;
      const piece = event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? event.delta.text : '';
      if (piece) { text += piece; onDelta(piece); }
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() || '';
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer) consume(buffer);
  if (!completed) throw new Error('Anthropic stream ended before message_stop.');
  return { text: text.trim(), inputTokens, outputTokens };
}

async function readStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = false;
  let usage;
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { completed = true; return; }
    if (completed) return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { /* Ignore an incomplete or provider-specific SSE frame. */ return; }
    const piece = normalizeContent(parsed.choices?.[0]?.delta?.content);
    if (piece) { text += piece; onDelta(piece); }
    if (parsed.usage) usage = parsed.usage;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() || '';
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer) consume(buffer);
  if (!completed) throw new Error('Provider stream ended before [DONE].');
  return { text: text.trim(), usage };
}
