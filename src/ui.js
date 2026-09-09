import readline from 'node:readline';
import { formatTokens } from './tokens.js';
import { resolveTheme, themeSummaries } from './themes.js';

const live = Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
let activeTheme = resolveTheme(process.env.MERGE_ROOM_THEME || 'merge-room');
const color = (name, text) => live ? `${activeTheme.colors[name] || activeTheme.colors.gray}${text}${activeTheme.colors.reset}` : String(text);
const clear = () => { if (live) process.stdout.write('\x1b[2J\x1b[H'); };
const width = () => Math.max(48, Math.min(process.stdout.columns || 92, 118) - 2);
const line = (char = '─') => char.repeat(width());
const crop = (value, max) => String(value).replace(/\s+/g, ' ').slice(0, max) + (String(value).length > max ? '…' : '');
const wrap = (value, max) => String(value).split(/\s+/).reduce((lines, word) => {
  const current = lines.at(-1) || '';
  if (!current) lines.push(word);
  else if (`${current} ${word}`.length <= max) lines[lines.length - 1] = `${current} ${word}`;
  else lines.push(word);
  return lines;
}, []);

export function setTheme(name = 'merge-room') {
  activeTheme = resolveTheme(name);
  return activeTheme;
}

export function getTheme() {
  return activeTheme.id;
}

export function printBanner({ provider, model }) {
  const w = width();
  console.log('');
  console.log(`  ${color('teal', '╭─')} ${color('bold', 'MERGE ROOM')} ${color('gray', '· agent command cockpit')} ${color('teal', '─'.repeat(Math.max(8, w - 35)))}╮`);
  console.log(`  ${color('teal', '│')} ${color('white', 'A quiet place to make complicated things move.')} ${color('gray', `provider ${provider}  ·  ${model}`)}${' '.repeat(Math.max(1, w - 66 - provider.length - model.length))}${color('teal', '│')}`);
  console.log(`  ${color('teal', '╰')}${color('teal', '─'.repeat(Math.max(8, w - 4)))}${color('teal', '╯')}`);
  console.log('');
}

export function createRenderer({ config, provider, context = null }) {
 const state = { request: '', context, statuses: new Map(), notes: new Map(), events: [], usage: { input: 0, output: 0, total: 0 }, started: Date.now(), final: null, answerDraft: '' };
  state.lastRenderAt = 0;
 const render = () => {
   if (!live) return;
    state.lastRenderAt = Date.now();
   clear(); printBanner({ provider: provider.name, model: config.model });
    const contextLabel = state.context ? `${state.context.fileCount} files in orbit` : 'context off';
    console.log(`  ${color('dim', 'MISSION')}  ${color('white', crop(state.request || 'Waiting for a mission…', width() - 34))}  ${color('gray', `· ${contextLabel}`)}`);
    console.log(`  ${color('gray', line('·'))}`);
    const laneCaption = config.strategy === 'parallel' ? 'specialists move together' : 'specialists move in waves';
    console.log(`  ${color('bold', 'AGENT LANES')}  ${color('gray', laneCaption)}`);
    for (const agent of config.agents) {
      const status = state.statuses.get(agent.id) || 'queued';
      const icon = status === 'done' ? color('green', '●') : status === 'error' ? color('red', '×') : status === 'skipped' ? color('yellow', '–') : status === 'working' ? color('yellow', '◌') : color('gray', '○');
      const label = status === 'working' ? color('yellow', 'working') : status === 'skipped' ? color('yellow', 'skipped') : status;
      console.log(`  ${icon} ${color(agent.color, agent.mark)} ${color('bold', agent.name.padEnd(12))} ${color('gray', agent.specialty.padEnd(23))} ${label}`);
    }
    const notes = [...state.notes.entries()].slice(-2);
    if (notes.length) {
      console.log(`  ${color('bold', 'HANDOFF NOTES')}`);
      for (const [agentId, note] of notes) {
        const agent = config.agents.find((item) => item.id === agentId);
        console.log(`  ${color(agent?.color || 'gray', agent?.mark || '·')} ${color('gray', crop(note, width() - 9))}`);
      }
    }
    console.log(`  ${color('gray', line('·'))}`);
    console.log(`  ${color('bold', 'RUN LOG')}`);
    for (const event of state.events.slice(-4)) console.log(`  ${color('gray', event.time)} ${event.message}`);
    const answer = state.final || state.answerDraft;
    if (answer) {
      console.log(`  ${color('gray', line('·'))}`);
      console.log(`  ${color('bold', 'MERGE ROOM SAYS')}`);
      for (const paragraph of answer.split(/\n+/)) {
        for (const wrapped of wrap(paragraph, width() - 4)) console.log(`  ${color('white', wrapped)}`);
      }
    }
   const elapsed = ((Date.now() - state.started) / 1000).toFixed(1);
    const tokenLabel = (value, estimated) => `${estimated ? '~' : ''}${formatTokens(value)}`;
   console.log('');
    console.log(`  ${color('bg', ` ${color('gray', 'usage')} ${color('white', `${elapsed}s`)}   ${color('gray', 'in')} ${color('cyan', tokenLabel(state.usage.input, state.usage.estimatedInput))}   ${color('gray', 'out')} ${color('purple', tokenLabel(state.usage.output, state.usage.estimatedOutput))}   ${color('gray', 'burned')} ${color('bold', color('yellow', tokenLabel(state.usage.total, state.usage.estimatedInput || state.usage.estimatedOutput)))}   ${color('gray', 'calls')} ${color('white', state.usage.calls || 0)}   ${color('gray', 'agents')} ${color('white', config.agents.length)} `)}`);
  };
  const event = (payload) => {
    state.usage = payload.telemetry || state.usage;
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (payload.type === 'run:start') state.request = payload.request;
    if (payload.type === 'agents:dispatch') state.events.push({ time: now, message: `${color('teal', 'wave')} ${color('gray', `${payload.stageLabel} · ${payload.agentCount} specialist${payload.agentCount === 1 ? '' : 's'}`)}` });
    if (payload.type === 'agent:start') { state.statuses.set(payload.agent.id, 'working'); state.events.push({ time: now, message: `${color(payload.agent.color, payload.agent.name)} ${color('gray', 'picked up the thread')}` }); }
    if (payload.type === 'agent:done') { state.statuses.set(payload.agent.id, 'done'); state.notes.set(payload.agent.id, payload.text || 'note received'); state.events.push({ time: now, message: `${color('green', 'done')} ${color('gray', `${payload.agent.name || payload.agent?.name || 'specialist'} returned a note`)}` }); }
    if (payload.type === 'agent:error') { state.statuses.set(payload.agent.id, 'error'); state.events.push({ time: now, message: `${color('red', 'error')} ${color('gray', crop(payload.error, width() - 20))}` }); }
    if (payload.type === 'agent:skipped') { state.statuses.set(payload.agent.id, 'skipped'); state.events.push({ time: now, message: `${color('yellow', 'skip')} ${color('gray', crop(payload.error, width() - 20))}` }); }
   if (payload.type === 'synthesis:start') state.events.push({ time: now, message: `${color('teal', 'merge-room')} ${color('gray', 'is weaving the notes together')}` });
    if (payload.type === 'synthesis:error') state.events.push({ time: now, message: `${color('yellow', 'fallback')} ${color('gray', 'lead synthesis unavailable; preserving specialist notes')}` });
    if (payload.type === 'run:cancelled') state.events.push({ time: now, message: `${color('yellow', 'paused')} ${color('gray', payload.error || 'mission cancelled')}` });
   if (payload.type === 'synthesis:delta') state.answerDraft += payload.delta;
    if (payload.type === 'run:done') state.final = payload.result.answer;
    const deltaDue = payload.type !== 'synthesis:delta' || Date.now() - state.lastRenderAt >= 80;
    if (live && deltaDue) render();
    else if (payload.type === 'run:start') console.log(`Merge Room · ${payload.request}`);
    else if (payload.type === 'agent:done') console.log(`  ${payload.agent.name} done`);
    else if (payload.type === 'agent:error') console.log(`  ${payload.agent.name} error: ${payload.error}`);
    else if (payload.type === 'agent:skipped') console.log(`  ${payload.agent.name} skipped: ${payload.error}`);
    else if (payload.type === 'synthesis:error') console.log(`  Lead synthesis unavailable: ${payload.error}`);
    else if (payload.type === 'run:cancelled') console.log(`  Mission cancelled: ${payload.error || 'Mission cancelled.'}`);
   else if (payload.type === 'run:done') console.log(`\n${payload.result.answer}\n`);
  };
  return { event, render, state };
}

export async function ask(question = 'What should we move forward today?', signal) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let settled = false;
   const finish = (answer = '') => {
     if (settled) return;
     settled = true;
     signal?.removeEventListener('abort', onAbort);
     rl.removeListener('close', onClose);
      process.stdin.removeListener('end', onEnd);
     rl.close();
     resolve(answer.trim());
   };
   const onAbort = () => finish('');
   const onClose = () => finish('');
    const onEnd = () => finish('');
   signal?.addEventListener('abort', onAbort, { once: true });
   rl.once('close', onClose);
    process.stdin.once('end', onEnd);
   if (signal?.aborted) return onAbort();
    rl.question(`  ${color('teal', '›')} ${question} `, (answer) => finish(answer));
  });
}

export function printResult(result, { trace = false } = {}) {
  console.log('');
  if (trace) {
    console.log(`  ${color('bold', 'SPECIALIST TRACE')}`);
    for (const item of result.agents || []) {
      console.log(`  ${color(item.agent.color, item.agent.mark)} ${color('bold', item.agent.name)} ${color('gray', `· stage ${item.stage} · ${item.model} · ${item.status} · ${((item.durationMs || 0) / 1000).toFixed(1)}s`)}`);
      console.log(`  ${color('white', item.text)}\n`);
    }
  }
  const statusIcon = result.degraded ? color('yellow', '△') : color('green', '✓');
 const statusLabel = result.degraded ? 'Mission complete · best effort' : 'Mission complete';
 console.log(`  ${statusIcon} ${color('bold', statusLabel)} ${color('gray', `in ${(result.durationMs / 1000).toFixed(1)}s`)}`);
  if (result.synthesisError) console.log(`  ${color('gray', 'reason')} ${result.synthesisError}`);
 const input = `${result.usage.estimatedInput ? '~' : ''}${formatTokens(result.usage.input)}`;
 const output = `${result.usage.estimatedOutput ? '~' : ''}${formatTokens(result.usage.output)}`;
  const total = `${result.usage.estimatedInput || result.usage.estimatedOutput ? '~' : ''}${formatTokens(result.usage.total)}`;
  const budget = result.maxCalls ? ` · cap ${result.maxCalls} calls` : '';
  console.log(`  ${color('gray', 'usage')} ${color('yellow', `${total} burned`)} · ${input} in · ${output} out · ${result.usage.calls || 0} calls · ${result.agents?.length || 0} agents${budget}`);
  if (result.sessionId) console.log(`  ${color('gray', 'saved')} ${color('teal', `merge-room show ${result.sessionId}`)}`);
  console.log('');
}

export function printThemes(current = getTheme()) {
  console.log(`\n  ${color('bold', 'MERGE ROOM THEMES')}\n`);
  for (const theme of themeSummaries()) {
    const marker = theme.id === current ? color('green', '●') : color('gray', '○');
    console.log(`  ${marker} ${color(theme.id === current ? 'teal' : 'white', theme.id.padEnd(16))} ${color('gray', theme.description)}`);
  }
  console.log(`\n  ${color('gray', 'Use `--theme=<name>` for one run or set `"theme"` in merge-room.config.json.')}\n`);
}

export function printPlan(plan) {
  printBanner({ provider: plan.provider, model: plan.model });
  console.log(`  ${color('bold', 'RUN PREFLIGHT')}  ${color('gray', 'no provider calls made')}\n`);
  console.log(`  ${color('white', crop(plan.request, width() - 4))}\n`);
  console.log(`  ${color('gray', 'strategy')} ${color('teal', plan.strategy)}  ${color('gray', 'agents')} ${plan.agents.length}  ${color('gray', 'context')} ${plan.context ? `${plan.context.fileCount} files` : 'off'}`);
  console.log(`  ${color('gray', 'limits')} max ${plan.limits.maxCalls ? `${plan.limits.maxCalls} calls` : 'unlimited'} · ${plan.limits.maxConcurrency} concurrent · ${plan.limits.maxTokens} output tokens/call\n`);
  for (const wave of plan.waves) {
    const names = wave.agents.map((agent) => `${agent.mark} ${agent.name}`).join('  ');
    console.log(`  ${color('teal', `${wave.stage}.`)} ${color('bold', wave.label.padEnd(13))} ${color('white', names)}`);
  }
  console.log(`\n  ${color('gray', 'Run the mission without `plan` when this shape looks right.')}\n`);
}

export function printHelp() {
  console.log(`${color('bold', 'MERGE ROOM')} ${color('gray', '· multi-agent command cockpit')}\n\n  ${color('teal', 'merge-room')} ${color('white', '"your mission"')}       run a mission\n  ${color('teal', 'merge-room')} ${color('white', 'run "your mission"')}   explicit run form\n  ${color('teal', 'merge-room')} ${color('white', 'plan "your mission"')}  preview a run without provider calls\n  ${color('teal', 'merge-room')} ${color('white', 'interactive')}              open the cockpit\n  ${color('teal', 'merge-room')} ${color('white', '--json "mission"')}       return JSON for scripts\n  ${color('teal', 'merge-room')} ${color('white', 'agents')}                   show the specialist roster\n  ${color('teal', 'merge-room')} ${color('white', 'theme list')}              list cockpit palettes\n  ${color('teal', 'merge-room')} ${color('white', 'history')}                 list saved missions\n  ${color('teal', 'merge-room')} ${color('white', 'usage')}                  aggregate saved token usage\n  ${color('teal', 'merge-room')} ${color('white', 'show <id>')}               reopen a saved mission\n  ${color('teal', 'merge-room')} ${color('white', 'export <id>')}            print a Markdown transcript\n  ${color('teal', 'merge-room')} ${color('white', 'context')}                  preview workspace context\n  ${color('teal', 'merge-room')} ${color('white', 'doctor')}                   check local setup\n  ${color('teal', 'merge-room')} ${color('white', 'init')}                     create merge-room.config.json\n  ${color('teal', 'merge-room')} ${color('white', '--no-context')}            skip workspace excerpts\n  ${color('teal', 'merge-room')} ${color('white', '--help')}                  show this guide\n\n  ${color('gray', 'Set OPENAI_API_KEY for live runs. Without it, Merge Room uses a tiny local demo provider.')}`);
 console.log(`  ${color('teal', 'merge-room')} ${color('white', 'config')}                  show effective safe config`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'completions [shell]')}       print shell completion script`);
 console.log(`  ${color('teal', 'merge-room')} ${color('white', 'review "change"')}       review with bounded Git diff context`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'brainstorm "idea"')}      parallel specialist perspectives`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--team=scout,critic')}     run a focused team`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'resume <id> "follow-up"')} continue a mission`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--no-save')}              keep this run local`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--include=a.js,b.md')}      prioritize exact context files`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--diff')}                  include a bounded Git diff`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--parallel')}              trade staged depth for lower latency`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--trace')}                 show specialist notes`);
 console.log(`  ${color('teal', 'merge-room')} ${color('white', '--no-stream')}             use non-streaming provider calls`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--stream-usage')}         request exact streamed usage when supported`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--events')}                stream newline-delimited JSON events`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--strict')}                exit 2 when a run is degraded`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--model=… --base-url=…')} override provider settings`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--provider=demo')}         force local demo mode for CI or offline work`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--max-tokens=800')}         cap one provider response`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--temperature=0.2')}       tune response variance`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--concurrency=2')}          limit specialist work in flight`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--max-calls=8')}           cap provider calls (0 = unlimited)`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--timeout=30000')}         bound one provider call (ms)`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--retries=0')}             control transient retries`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--run-id=release-1')}       correlate events and saved runs`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--theme=ember')}           choose merge-room, ocean, ember, mono, or high-contrast`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--limit=10')}              bound history or usage queries`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--config path')}           use another Merge Room config file`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--format=md|json')}       choose export format`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--output path')}           write an export file`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'show last / resume last')}  use the newest saved mission`);
  console.log(`  ${color('teal', 'cat brief.md | merge-room -')}       read a mission from stdin`);
}

export function printAgents(config) {
  printBanner({ provider: 'configured', model: config.model });
  console.log(`  ${color('bold', 'SPECIALIST ROSTER')}\n`);
  for (const agent of config.agents) console.log(`  ${color(agent.color, agent.mark)} ${color('bold', agent.name.padEnd(13))} ${color('gray', `${agent.specialty} · stage ${agent.stage}`)}${agent.model ? ` ${color('purple', `· ${agent.model}`)}` : ''}\n     ${color('dim', agent.prompt)}\n`);
}

export function printConfig(config) {
  printBanner({ provider: 'configuration', model: config.model });
  console.log(`  ${color('bold', 'EFFECTIVE CONFIG')}\n`);
  for (const [key, value] of Object.entries(config)) {
    if (key === 'agents' || key === 'context') continue;
    console.log(`  ${color('gray', key.padEnd(18))} ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  console.log(`\n  ${color('bold', 'AGENTS')}  ${config.agents.map((agent) => agent.id).join(', ')}`);
  console.log(`  ${color('bold', 'CONTEXT')} ${JSON.stringify(config.context)}\n`);
}

export function printHistory(sessions) {
  if (!sessions.length) return console.log('  No Merge Room sessions yet. Run a mission to create one.\n');
  console.log(`\n  ${color('bold', 'RECENT MISSIONS')}\n`);
 for (const session of sessions.slice(0, 20)) {
   const when = session.savedAt ? new Date(session.savedAt).toLocaleString() : 'unknown time';
    const usage = session.usage || {};
    const burned = usage.total != null ? `${usage.estimatedInput || usage.estimatedOutput ? '~' : ''}${formatTokens(usage.total)} burned` : 'usage unavailable';
    const details = `${session.agents || 0} agents · ${burned}${session.status === 'degraded' || session.degraded ? ' · degraded' : ''}${session.runId ? ` · run ${session.runId}` : ''}`;
    console.log(`  ${color('teal', session.id)}  ${color('gray', when)}\n  ${color('gray', details)}\n  ${color('white', crop(session.request, width() - 4))}\n`);
 }
}

export function printUsage(usage) {
  printBanner({ provider: 'history', model: 'aggregate' });
  console.log(`  ${color('bold', 'USAGE LEDGER')}\n`);
  console.log(`  ${color('gray', 'missions')} ${usage.sessions}`);
  console.log(`  ${color('gray', 'input')}    ${formatTokens(usage.input)}`);
  console.log(`  ${color('gray', 'output')}   ${formatTokens(usage.output)}`);
  const total = `${usage.estimatedInput || usage.estimatedOutput ? '~' : ''}${formatTokens(usage.total)}`;
  console.log(`  ${color('gray', 'burned')}   ${color('yellow', total)}`);
  if (usage.estimatedInput || usage.estimatedOutput) console.log(`  ${color('gray', 'note')}     ~ counts include estimated provider usage`);
 console.log(`  ${color('gray', 'calls')}    ${usage.calls}`);
  console.log(`  ${color('gray', 'degraded')} ${usage.degraded}\n`);
  const models = Object.entries(usage.byModel || {});
  if (models.length) {
    console.log(`  ${color('bold', 'BY MODEL')}\n`);
    for (const [model, values] of models) {
      const estimated = values.estimatedInput || values.estimatedOutput;
      console.log(`  ${color('teal', model)}  ${values.sessions} missions · ${estimated ? '~' : ''}${formatTokens(values.total)} burned · ${values.calls || 0} calls`);
    }
    console.log('');
  }
}

export function printSession(session) {
  console.log(`\n  ${color('teal', session.id || 'session')}  ${color('gray', session.savedAt || '')}`);
 console.log(`  ${color('bold', 'MISSION')}  ${session.request}\n`);
  const waveSummary = session.waves?.length ? session.waves.map((wave) => `${wave.label}:${wave.agentIds?.length || 0}`).join(' → ') : '';
  const agentCount = Array.isArray(session.agents) ? session.agents.length : Number(session.agents) || 0;
  const runSummary = [session.status || (session.degraded ? 'degraded' : 'complete'), session.strategy, session.durationMs != null ? `${(Number(session.durationMs) / 1000).toFixed(1)}s` : '', agentCount ? `${agentCount} agents` : '', waveSummary, session.runId ? `run ${session.runId}` : ''].filter(Boolean).join(' · ');
  if (runSummary) console.log(`  ${color('gray', runSummary)}\n`);
 console.log(`  ${color('bold', 'MERGE ROOM SAYS')}\n  ${session.answer}\n`);
 if (session.degraded) console.log(`  ${color('yellow', '△')} ${color('gray', 'Best-effort run: one or more specialists were unavailable.')}\n`);
  if (session.synthesisError) console.log(`  ${color('gray', 'reason')} ${session.synthesisError}\n`);
  if (session.usage) {
    const mark = (value, estimated) => `${estimated ? '~' : ''}${formatTokens(value || 0)}`;
    console.log(`  ${color('gray', 'tokens')} ${mark(session.usage.total, session.usage.estimatedInput || session.usage.estimatedOutput)} total · ${mark(session.usage.input, session.usage.estimatedInput)} in · ${mark(session.usage.output, session.usage.estimatedOutput)} out\n`);
  }
}
