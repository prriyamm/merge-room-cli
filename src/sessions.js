import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function saveSession(result, cwd = process.cwd(), directory = '.merge-room/sessions') {
  const root = await createSessionDirectory(cwd, directory);
  const savedAt = new Date().toISOString();
  const stamp = savedAt.replaceAll(':', '-').replaceAll('.', '-');
  const id = `${stamp}-${randomUUID()}`;
 const file = path.join(root, `${id}.json`);
  const temporary = path.join(root, `.${id}.tmp-${process.pid}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ ...result, id, savedAt }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
 return { id, file };
}

export async function listSessions(cwd = process.cwd(), directory = '.merge-room/sessions', { limit } = {}) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error('Session list limit must be a non-negative integer.');
  if (limit === 0) return [];
  const root = await resolveSessionDirectory(cwd, directory);
  if (!root) return [];
  let names;
  try { names = await fs.readdir(root); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort().reverse()) {
    try {
      const contents = await readRegularFile(path.join(root, name));
      if (contents === null) continue;
      const data = JSON.parse(contents);
      sessions.push({ id: data.id || name.slice(0, -5), runId: data.runId, theme: data.theme, savedAt: data.savedAt, request: data.request, usage: data.usage, provider: data.provider, model: data.model, strategy: data.strategy, status: data.status, maxCalls: data.maxCalls, providerCallsStarted: data.providerCallsStarted, durationMs: data.durationMs, agents: data.agents?.length || 0, degraded: Boolean(data.degraded) });
      if (limit !== undefined && sessions.length >= limit) break;
    } catch { /* Ignore a partial or hand-edited session file. */ }
  }
  return sessions;
}

export async function readSession(id, cwd = process.cwd(), directory = '.merge-room/sessions') {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Session ids may only contain letters, numbers, underscores, and dashes.');
  const root = await resolveSessionDirectory(cwd, directory);
  if (!root) return null;
  const file = path.join(root, `${id}.json`);
  try {
    const contents = await readRegularFile(file);
    return contents === null ? null : JSON.parse(contents);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function resolveSessionDirectory(cwd, directory) {
  let base;
  try { base = await fs.realpath(cwd); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const requestedRoot = path.resolve(base, directory);
  let info;
  let realRoot;
  try {
    info = await fs.lstat(requestedRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    realRoot = await fs.realpath(requestedRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const samePath = process.platform === 'win32'
    ? path.resolve(realRoot).toLowerCase() === path.resolve(requestedRoot).toLowerCase()
    : path.resolve(realRoot) === path.resolve(requestedRoot);
  return samePath ? realRoot : null;
}

async function createSessionDirectory(cwd, directory) {
  const base = await fs.realpath(cwd);
  const requestedRoot = path.resolve(base, directory);
  let current = path.parse(requestedRoot).root;
  const components = path.relative(current, requestedRoot).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session directory must not contain symbolic links.');
  }
  const root = await resolveSessionDirectory(base, requestedRoot);
  if (!root) throw new Error('Session directory must not contain symbolic links.');
  return root;
}

async function readRegularFile(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) return null;
  const noFollow = constants.O_NOFOLLOW || 0;
  const handle = await fs.open(file, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const sameFile = process.platform === 'win32'
      ? before.ino !== 0n && opened.ino === before.ino
      : opened.dev === before.dev && opened.ino === before.ino;
    if (!opened.isFile() || !sameFile) return null;
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export function formatSessionMarkdown(session) {
  const lines = [
    '# Merge Room mission',
    '',
    `- **Session:** ${session.id || 'unsaved'}`,
    ...(session.runId ? [`- **Run ID:** ${session.runId}`] : []),
    ...(session.theme ? [`- **Theme:** ${session.theme}`] : []),
    `- **Saved:** ${session.savedAt || 'unknown'}`,
    `- **Provider:** ${session.provider || 'unknown'} · ${session.model || 'unknown'}`,
  `- **Status:** ${session.status || (session.degraded ? 'degraded' : 'complete')}`,
  `- **Strategy:** ${session.strategy || 'staged'}${session.degraded ? ' · best effort' : ''}`,
    ...(session.maxCalls ? [`- **Call budget:** ${session.providerCallsStarted || 0}/${session.maxCalls} provider calls started`] : []),
    ...(session.durationMs != null ? [`- **Duration:** ${(Number(session.durationMs) / 1000).toFixed(1)}s`] : []),
   ...(session.waves?.length ? [`- **Waves:** ${session.waves.map((wave) => `${wave.label} (${wave.agentIds?.join(', ') || 'none'})`).join(' → ')}`] : []),
    ...(session.context ? [`- **Workspace context:** ${session.context.fileCount || 0} files · ${session.context.excerptCount || 0} excerpts${session.context.diff ? ' · diff included' : ''}`] : []),
  ...(session.synthesisError ? [`- **Synthesis:** ${session.synthesisError}`] : []),
   '',
    '## Mission',
    '',
    session.request || '',
    '',
    '## Merge Room says',
    '',
    session.answer || '',
    ''
 ];
  if (session.usage) {
    const tokenLabel = (value, estimated) => `${estimated ? '~' : ''}${value || 0}`;
   lines.push('## Usage', '', `- Input tokens: ${tokenLabel(session.usage.input, session.usage.estimatedInput)}`, `- Output tokens: ${tokenLabel(session.usage.output, session.usage.estimatedOutput)}`, `- Total tokens burned: ${tokenLabel(session.usage.total, session.usage.estimatedInput || session.usage.estimatedOutput)}`, `- Provider calls: ${session.usage.calls || 0}`, '');
    const models = Object.entries(session.usage.byModel || {});
    if (models.length) {
      lines.push('### By model', '');
      for (const [model, values] of models) lines.push(`- ${model}: ${tokenLabel(values.total, values.estimatedInput || values.estimatedOutput)} total · ${values.calls || 0} calls`);
      lines.push('');
    }
 }
  if (session.agents?.length) {
    lines.push('## Specialist notes', '');
    for (const item of session.agents) {
      const route = [item.provider, item.model].filter(Boolean).join(' · ');
      lines.push(`### ${item.agent?.name || item.agent?.id || 'Specialist'} · stage ${item.stage || 1}${item.status ? ` · ${item.status}` : ''}${item.durationMs != null ? ` · ${(Number(item.durationMs) / 1000).toFixed(1)}s` : ''}${route ? ` · ${route}` : ''}`, '', item.text || '(no note)', '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

export async function writeSessionExport(session, cwd = process.cwd(), destination, format = 'md') {
  if (!destination) throw new Error('Give an export destination path.');
  const output = path.resolve(cwd, destination);
  const content = format === 'json' ? `${JSON.stringify(session, null, 2)}\n` : formatSessionMarkdown(session);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, content, 'utf8');
  return output;
}
