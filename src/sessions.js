import fs from 'node:fs/promises';
import path from 'node:path';

export async function saveSession(result, cwd = process.cwd(), directory = '.loom/sessions') {
  const root = path.resolve(cwd, directory);
  await fs.mkdir(root, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
 const id = `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
 const file = path.join(root, `${id}.json`);
  const temporary = path.join(root, `.${id}.tmp-${process.pid}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ id, savedAt: new Date().toISOString(), ...result }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
 return { id, file };
}

export async function listSessions(cwd = process.cwd(), directory = '.loom/sessions') {
  const root = path.resolve(cwd, directory);
  let names;
  try { names = await fs.readdir(root); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort().reverse()) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
      sessions.push({ id: data.id || name.slice(0, -5), savedAt: data.savedAt, request: data.request, usage: data.usage, provider: data.provider, model: data.model, strategy: data.strategy, durationMs: data.durationMs, agents: data.agents?.length || 0, degraded: Boolean(data.degraded) });
    } catch { /* Ignore a partial or hand-edited session file. */ }
  }
  return sessions;
}

export async function readSession(id, cwd = process.cwd(), directory = '.loom/sessions') {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Session ids may only contain letters, numbers, underscores, and dashes.');
  const file = path.resolve(cwd, directory, `${id}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function formatSessionMarkdown(session) {
  const lines = [
    '# Loom mission', 
    '',
    `- **Session:** ${session.id || 'unsaved'}`,
    `- **Saved:** ${session.savedAt || 'unknown'}`,
    `- **Provider:** ${session.provider || 'unknown'} · ${session.model || 'unknown'}`,
  `- **Strategy:** ${session.strategy || 'staged'}${session.degraded ? ' · best effort' : ''}`,
    ...(session.durationMs != null ? [`- **Duration:** ${(Number(session.durationMs) / 1000).toFixed(1)}s`] : []),
   ...(session.waves?.length ? [`- **Waves:** ${session.waves.map((wave) => `${wave.label} (${wave.agentIds?.join(', ') || 'none'})`).join(' → ')}`] : []),
    ...(session.context ? [`- **Workspace context:** ${session.context.fileCount || 0} files · ${session.context.excerptCount || 0} excerpts${session.context.diff ? ' · diff included' : ''}`] : []),
  ...(session.synthesisError ? [`- **Synthesis:** ${session.synthesisError}`] : []),
   '',
    '## Mission',
    '',
    session.request || '',
    '',
    '## Loom says',
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
    for (const item of session.agents) lines.push(`### ${item.agent?.name || item.agent?.id || 'Specialist'} · stage ${item.stage || 1}${item.status ? ` · ${item.status}` : ''}${item.durationMs != null ? ` · ${(Number(item.durationMs) / 1000).toFixed(1)}s` : ''}`, '', item.text || '(no note)', '');
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
