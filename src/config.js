import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeTheme, resolveTheme } from './themes.js';

export const VERSION = '0.4.0';

export const DEFAULT_CONFIG = {
  model: process.env.MERGE_ROOM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  baseUrl: process.env.MERGE_ROOM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  provider: process.env.MERGE_ROOM_PROVIDER || 'auto',
  theme: process.env.MERGE_ROOM_THEME || 'merge-room',
  temperature: 0.35,
  maxTokens: 1200,
  streaming: true,
  streamUsage: false,
  strategy: 'staged',
  maxConcurrency: 4,
  maxCalls: 20,
  requestTimeoutMs: 90000,
  retries: 1,
  sessionDir: '.merge-room/sessions',
  context: { enabled: true, maxFiles: 180, maxBytes: 18000, maxExcerptBytes: 2400, maxDepth: 3 },
  agents: [
    { id: 'scout', name: 'Scout', mark: '◇', color: 'cyan', specialty: 'scope & risks', stage: 1, prompt: 'Map the request into a concise brief. Surface assumptions, risks, and the smallest useful first step.' },
    { id: 'architect', name: 'Architect', mark: '◈', color: 'magenta', specialty: 'systems & structure', stage: 1, prompt: 'Propose a pragmatic implementation shape. Favor clear boundaries, simple interfaces, and an incremental path.' },
    { id: 'maker', name: 'Maker', mark: '✦', color: 'yellow', specialty: 'solution draft', stage: 2, prompt: 'Draft the concrete solution. Include examples, commands, or code when they clarify the answer.' },
    { id: 'critic', name: 'Critic', mark: '△', color: 'red', specialty: 'quality & edge cases', stage: 3, prompt: 'Stress-test the work. Identify missing cases, unsafe assumptions, and the highest-value corrections.' }
  ]
};

export async function loadConfig(cwd = process.cwd(), explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(cwd, explicitPath)]
    : [path.join(cwd, 'merge-room.config.json'), path.join(cwd, '.merge-roomrc.json')];
  for (const file of candidates) {
    try {
      const local = JSON.parse(await fs.readFile(file, 'utf8'));
      return mergeConfig(DEFAULT_CONFIG, local);
    } catch (error) {
      if (error.code === 'ENOENT' && explicitPath) throw new Error(`Could not read ${path.basename(file)}: file not found.`);
      if (error.code !== 'ENOENT') throw new Error(`Could not read ${path.basename(file)}: ${error.message}`);
    }
  }
  return structuredClone(DEFAULT_CONFIG);
}

function mergeConfig(base, local) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('merge-room.config.json must contain a JSON object at the top level.');
  if (local.context !== undefined && (!local.context || typeof local.context !== 'object' || Array.isArray(local.context))) throw new Error('merge-room.config.json `context` must be a JSON object.');
  for (const key of ['streaming', 'streamUsage']) if (local[key] !== undefined && typeof local[key] !== 'boolean') throw new Error(`merge-room.config.json \`${key}\` must be true or false.`);
  if (local.context?.enabled !== undefined && typeof local.context.enabled !== 'boolean') throw new Error('merge-room.config.json `context.enabled` must be true or false.');
  for (const key of ['model', 'baseUrl']) if (local[key] !== undefined && (typeof local[key] !== 'string' || !local[key].trim())) throw new Error(`merge-room.config.json \`${key}\` must be a non-empty string.`);
  const theme = normalizeTheme(local.theme ?? base.theme);
  try { resolveTheme(theme); } catch (error) { throw new Error(`merge-room.config.json \`theme\`: ${error.message}`); }
  const provider = String(local.provider ?? base.provider).trim().toLowerCase();
  if (!['auto', 'demo'].includes(provider)) throw new Error('merge-room.config.json `provider` must be `auto` or `demo`.');
  if (local.sessionDir !== undefined && local.sessionDir !== null && (typeof local.sessionDir !== 'string' || !local.sessionDir.trim())) throw new Error('merge-room.config.json `sessionDir` must be a non-empty string or null.');
  if (local.agents !== undefined && !Array.isArray(local.agents)) throw new Error('merge-room.config.json `agents` must be a JSON array.');
  const sourceAgents = Array.isArray(local.agents) && local.agents.length ? local.agents : base.agents;
  const agents = sourceAgents.map((agent, index) => {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw new Error(`merge-room.config.json agent ${index + 1} must be a JSON object.`);
    const fallback = base.agents[index] || base.agents[0];
    const merged = { ...fallback, ...agent };
    const stage = Number(merged.stage ?? fallback.stage ?? 1);
    if (!Number.isInteger(stage) || stage < 1 || stage > 3) throw new Error(`merge-room.config.json agent ${index + 1} \`stage\` must be 1, 2, or 3.`);
    return { ...merged, id: slugify(agent.id || agent.name || fallback.id), name: String(merged.name || fallback.name), specialty: String(merged.specialty || fallback.specialty), prompt: String(merged.prompt || fallback.prompt), stage };
  });
  const ids = agents.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) throw new Error('merge-room.config.json contains duplicate agent ids. Give each specialist a unique `id`.');
  const strategy = local.strategy ?? base.strategy;
  if (!['staged', 'parallel'].includes(strategy)) throw new Error('merge-room.config.json `strategy` must be `staged` or `parallel`.');
  const maxTokens = Number(local.maxTokens ?? base.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('merge-room.config.json `maxTokens` must be a whole number greater than zero.');
  const temperature = Number(local.temperature ?? base.temperature);
  if (!Number.isFinite(temperature) || temperature < 0) throw new Error('merge-room.config.json `temperature` must be a non-negative number.');
  const maxConcurrency = Number(local.maxConcurrency ?? base.maxConcurrency);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('merge-room.config.json `maxConcurrency` must be a whole number greater than zero.');
  const maxCalls = Number(local.maxCalls ?? base.maxCalls);
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error('merge-room.config.json `maxCalls` must be a whole number greater than or equal to zero (zero means unlimited).');
  const requestTimeoutMs = Number(local.requestTimeoutMs ?? base.requestTimeoutMs);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100) throw new Error('merge-room.config.json `requestTimeoutMs` must be a whole number of at least 100 milliseconds.');
  const retries = Number(local.retries ?? base.retries);
  if (!Number.isInteger(retries) || retries < 0) throw new Error('merge-room.config.json `retries` must be a whole number greater than or equal to zero.');
  const context = { ...base.context, ...(local.context || {}) };
  for (const [key, minimum] of [['maxFiles', 1], ['maxBytes', 256], ['maxExcerptBytes', 80], ['maxDepth', 0]]) {
    if (!Number.isInteger(Number(context[key])) || Number(context[key]) < minimum) throw new Error(`merge-room.config.json \`context.${key}\` must be a whole number >= ${minimum}.`);
    context[key] = Number(context[key]);
  }
 return {
    ...base,
    ...local,
    provider,
    theme,
    strategy,
    maxConcurrency,
    maxCalls,
    maxTokens,
    temperature,
    requestTimeoutMs,
    retries,
    context,
    agents
  };
}

function slugify(value) {
  return String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

export async function writeStarterConfig(cwd = process.cwd()) {
  const file = path.join(cwd, 'merge-room.config.json');
  try { await fs.access(file); return { file, created: false }; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
  return { file, created: true };
}

export function safeBaseUrl(value) {
  const raw = String(value || '');
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/(?:api[_-]?key|token|secret|password|credential)/i.test(key)) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch {
    return raw.replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/i, '$1[redacted]@').replace(/([?&](?:api[_-]?key|token|secret|password|credential)=)[^&\s]+/gi, '$1[redacted]');
  }
}
