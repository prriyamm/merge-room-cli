import readline from 'node:readline';
import { liquidGlassLogoLines } from './logo.js';
import { formatTokens } from './tokens.js';
import { resolveTheme, themeSummaries } from './themes.js';
import { applyCockpitEvent, createCockpitState } from './cockpit.js';

const live = Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb');
const colorsEnabled = Boolean(live && !process.env.NO_COLOR);
let activeTheme = resolveTheme(process.env.MERGE_ROOM_THEME || 'merge-room');
const color = (name, text) => colorsEnabled ? `${activeTheme.colors[name] || activeTheme.colors.gray}${text}${activeTheme.colors.reset}` : String(text);
const surface = (text) => colorsEnabled ? `${activeTheme.colors.bg}${String(text).replaceAll(activeTheme.colors.reset, `${activeTheme.colors.reset}${activeTheme.colors.bg}`)}${activeTheme.colors.reset}` : String(text);
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

const STARTUP_PATTERN = Object.freeze(liquidGlassLogoLines({ color: false }));
const COLORED_STARTUP_PATTERN = Object.freeze(liquidGlassLogoLines({ color: true }));

export function startupPatternLines() {
  return [...STARTUP_PATTERN];
}

function tintPattern(value, index) {
  return colorsEnabled ? COLORED_STARTUP_PATTERN[index] : value;
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function printCockpitWelcome({ provider, model, workspace = process.cwd(), animate = true, write = (value) => console.log(value) }) {
  const motion = live && animate && !process.env.CI && !process.env.MERGE_ROOM_NO_MOTION;
  if (motion) {
    for (let visible = 2; visible <= STARTUP_PATTERN.length; visible += 2) {
      clear();
      for (let index = 0; index < STARTUP_PATTERN.length; index += 1) write(index < visible ? tintPattern(STARTUP_PATTERN[index], index) : '');
      await pause(42);
    }
    clear();
  }
  for (const [index, item] of STARTUP_PATTERN.entries()) write(tintPattern(item, index));
  write('');
  write(`  ${color('bold', 'Merge Room')}  ${color('gray', `${provider}/${model} · two rooms ·`)} ${color('teal', '/help')}`);
  write('');
}

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
    console.log(`  ${surface(` ${color('gray', 'usage')} ${color('white', `${elapsed}s`)}   ${color('gray', 'in')} ${color('cyan', tokenLabel(state.usage.input, state.usage.estimatedInput))}   ${color('gray', 'out')} ${color('purple', tokenLabel(state.usage.output, state.usage.estimatedOutput))}   ${color('gray', 'burned')} ${color('bold', color('yellow', tokenLabel(state.usage.total, state.usage.estimatedInput || state.usage.estimatedOutput)))}   ${color('gray', 'calls')} ${color('white', state.usage.calls || 0)}   ${color('gray', 'agents')} ${color('white', config.agents.length)} `)}`);
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

export function createCockpitRenderer({ config, provider, workspace = process.cwd(), onRefresh = () => {}, force = false, columns, rows, write = (line) => console.log(line) }) {
  const state = createCockpitState(config.agents);
  const refresh = () => { render(); onRefresh(); };
  const event = (roomIndex) => (payload) => { applyCockpitEvent(state, roomIndex, payload); refresh(); };
  const render = () => {
    if (!live && !force) return;
    clear();
    const terminalWidth = Math.max(68, Math.min(columns || process.stdout.columns || 108, 140));
    const terminalHeight = Math.max(22, rows || process.stdout.rows || 32);
    const sidebarWidth = Math.min(34, Math.max(27, Math.floor(terminalWidth * 0.3)));
    const mainWidth = terminalWidth - sidebarWidth - 3;
    const contentHeight = Math.max(15, terminalHeight - 6);
    const sidebar = cockpitSidebar(state, config, sidebarWidth, contentHeight);
    const main = cockpitMain(state, config, workspace, mainWidth, contentHeight);
    const header = ` ${color('bold', 'MERGE ROOM')} ${color('gray', `· ${provider.name} · two live sessions`)}`;
    write(`${color('teal', '╭')}${fit(header, terminalWidth - 2)}${color('teal', '╮')}`);
    for (let index = 0; index < contentHeight; index += 1) {
      write(`${color('teal', '│')}${fit(sidebar[index] || '', sidebarWidth)}${color('teal', '│')}${fit(main[index] || '', mainWidth)}${color('teal', '│')}`);
    }
    write(`${color('teal', '╰')}${'─'.repeat(sidebarWidth)}${color('teal', '┴')}${'─'.repeat(mainWidth)}${color('teal', '╯')}`);
    write(surface(fit(` ${color('gray', '/1 /2 switch · /new reset · /help commands · /quit leave')}`, terminalWidth)));
    write(surface(fit(` ${color('teal', state.message)}`, terminalWidth)));
  };
  return { state, event, render, refresh };
}

export function createConversationRenderer({ config, provider, workspace = process.cwd(), onRefresh = () => {}, force = false, write = (line) => console.log(line) }) {
  const state = createCockpitState(config.agents);
  const enabled = Boolean((process.stdin.isTTY && process.stdout.isTTY) || force);
  let started = false;
  const emit = (line = '') => { if (enabled) write(line); };
  const refresh = () => onRefresh();
  const start = (options) => {
    if (started) return Promise.resolve();
    started = true;
    return printCockpitWelcome({ provider: provider.name, model: config.model, workspace, write: emit, ...options });
  };
  const user = (roomIndex, request) => {
    emit('');
    emit(`  ${color('teal', `Room ${roomIndex + 1} ›`)} ${color('white', request)}`);
  };
  const notice = (message) => emit(`  ${color('gray', '·')} ${color('teal', message)}`);
  const event = (roomIndex) => (payload) => {
    applyCockpitEvent(state, roomIndex, payload);
    if (!enabled) return;
    let visibleUpdate = false;
    const prefix = color('gray', `room ${roomIndex + 1}`);
    if (payload.type === 'agent:start') { emit(`  ${color('gray', '○')} ${color(payload.agent.color, payload.agent.name)} ${color('gray', 'is working')}`); visibleUpdate = true; }
    if (payload.type === 'agent:done') { emit(`  ${color('green', '✓')} ${color(payload.agent.color, payload.agent.name)} ${color('gray', 'handed back a note')}`); visibleUpdate = true; }
    if (payload.type === 'agent:error') { emit(`  ${color('red', '×')} ${prefix} ${color('red', crop(payload.error, 76))}`); visibleUpdate = true; }
    if (payload.type === 'agent:skipped') { emit(`  ${color('yellow', '–')} ${prefix} ${color('gray', crop(payload.error, 76))}`); visibleUpdate = true; }
    if (payload.type === 'synthesis:start') { emit(`  ${color('purple', '◇')} ${color('gray', 'Merging the room’s notes…')}`); visibleUpdate = true; }
    if (payload.type === 'synthesis:error') { emit(`  ${color('yellow', '△')} ${color('gray', 'Lead synthesis unavailable; keeping the specialist notes.')}`); visibleUpdate = true; }
    if (payload.type === 'run:cancelled') { emit(`  ${color('yellow', '△')} ${prefix} ${color('gray', payload.error || 'Mission cancelled.')}`); visibleUpdate = true; }
    if (payload.type === 'run:done') {
      visibleUpdate = true;
      emit('');
      for (const paragraph of String(payload.result.answer || '').split(/\n+/)) {
        for (const item of wrap(paragraph, Math.max(44, width() - 8))) emit(`  ${color('white', item)}`);
      }
      const usage = payload.result.usage || {};
      emit('');
      emit(`  ${color('green', '✓')} ${color('bold', `Room ${roomIndex + 1} complete`)} ${color('gray', `· ${formatTokens(usage.total || 0)} tokens · ${usage.calls || 0} calls`)}`);
    }
    if (visibleUpdate) refresh();
  };
  return { state, start, user, notice, event, refresh, render: () => {} };
}

function cockpitSidebar(state, config, maxWidth, height) {
  const lines = [` ${color('bold', 'ROOMS')}`, ''];
  const roomHeight = Math.max(4, Math.floor((height - 3) / state.rooms.length));
  for (const [roomIndex, room] of state.rooms.entries()) {
    const section = [];
    const selected = roomIndex === state.activeRoom;
    const marker = selected ? color('teal', '›') : ' ';
    const status = room.status === 'done' ? color('green', 'done') : room.status === 'error' ? color('red', 'error') : room.running ? color('yellow', room.status) : color('gray', room.status);
    section.push(` ${marker} ${color('bold', `Room ${room.id}`)}  ${status}`);
    section.push(`   ${color('white', crop(room.request || 'Ready for a mission', maxWidth - 4))}`);
    const roomAgents = config.agents.filter((item) => room.agentIds.includes(item.id));
    const agentSlots = Math.max(1, roomHeight - 2);
    const visibleAgents = roomAgents.length > agentSlots ? roomAgents.slice(0, Math.max(0, agentSlots - 1)) : roomAgents;
    for (const agent of visibleAgents) {
      const agentStatus = room.statuses[agent.id] || 'idle';
      const icon = agentStatus === 'done' ? color('green', '●') : agentStatus === 'working' ? color('yellow', '◌') : agentStatus === 'error' ? color('red', '×') : agentStatus === 'skipped' ? color('yellow', '–') : color('gray', '○');
      const activity = agentStatus === 'working' ? agent.specialty : agentStatus;
      section.push(`   ${icon} ${crop(agent.name, 10).padEnd(10)} ${color('gray', crop(activity, maxWidth - 18))}`);
    }
    if (roomAgents.length > visibleAgents.length) section.push(`     ${color('gray', `+${roomAgents.length - visibleAgents.length} more agents`)}`);
    while (section.length < roomHeight) section.push('');
    lines.push(...section.slice(0, roomHeight));
    if (roomIndex < state.rooms.length - 1) lines.push(` ${color('gray', '·'.repeat(Math.max(3, maxWidth - 2)))}`);
  }
  return lines.slice(0, height);
}

function cockpitMain(state, config, workspace, maxWidth, height) {
  const room = state.rooms[state.activeRoom];
  const lines = [
    ` ${color('bold', `ROOM ${room.id}`)} ${color('gray', room.turn ? `· turn ${room.turn}` : '· new session')}`,
    ` ${color('gray', crop(workspace, maxWidth - 2))}`,
    '',
    ` ${color('bold', 'MISSION')}`,
    ...wrap(room.request || 'Type a mission below. Switch rooms at any time.', maxWidth - 2).slice(0, 2).map((item) => ` ${color('white', item)}`),
    '',
    ` ${color('bold', 'LIVE HANDOFFS')}`
  ];
  const notes = Object.entries(room.notes).slice(-2);
  if (!notes.length) lines.push(` ${color('gray', room.running ? 'Specialists are getting oriented…' : 'No handoffs yet.')}`);
  for (const [agentId, note] of notes) {
    const agent = config.agents.find((item) => item.id === agentId);
    lines.push(` ${color(agent?.color || 'gray', agent?.mark || '·')} ${color('gray', crop(note, maxWidth - 5))}`);
  }
  lines.push('', ` ${color('bold', 'RUN LOG')}`);
  if (!room.events.length) lines.push(` ${color('gray', 'Waiting for work.')}`);
  for (const item of room.events.slice(-3)) lines.push(` ${color('gray', item.time)} ${crop(item.message, maxWidth - 13)}`);
  const answer = room.final || room.answerDraft;
  if (answer) {
    lines.push('', ` ${color('bold', 'MERGE ROOM SAYS')}`);
    const remaining = Math.max(2, height - lines.length - 2);
    lines.push(...wrap(answer, maxWidth - 2).slice(-remaining).map((item) => ` ${color('white', item)}`));
  } else if (room.error) lines.push('', ` ${color('red', crop(room.error, maxWidth - 2))}`);
  const elapsed = room.started ? `${((Date.now() - room.started) / 1000).toFixed(1)}s` : '0.0s';
  const usage = room.usage || {};
  const footer = ` ${elapsed} · ${formatTokens(usage.total || 0)} tokens · ${usage.calls || 0} calls`;
  while (lines.length < height - 1) lines.push('');
  lines.push(color('gray', footer));
  return lines.slice(0, height);
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function fit(value, max) {
  const text = String(value);
  const missing = max - visibleLength(text);
  return missing >= 0 ? `${text}${' '.repeat(missing)}` : crop(text.replace(/\x1b\[[0-9;]*m/g, ''), max);
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
  console.log(`  ${color('gray', 'workspace')} ${color('white', plan.workspace)}`);
  console.log(`  ${color('gray', 'strategy')} ${color('teal', plan.strategy)}  ${color('gray', 'agents')} ${plan.agents.length}  ${color('gray', 'context')} ${plan.context ? `${plan.context.fileCount} files` : 'off'}`);
  console.log(`  ${color('gray', 'limits')} max ${plan.limits.maxCalls ? `${plan.limits.maxCalls} calls` : 'unlimited'} · ${plan.limits.maxConcurrency} concurrent · ${plan.limits.maxTokens} output tokens/call\n`);
  for (const wave of plan.waves) {
    const names = wave.agents.map((agent) => `${agent.mark} ${agent.name}`).join('  ');
    console.log(`  ${color('teal', `${wave.stage}.`)} ${color('bold', wave.label.padEnd(13))} ${color('white', names)}`);
  }
  console.log(`\n  ${color('gray', 'Run the mission without `plan` when this shape looks right.')}\n`);
}

export function printHelp() {
  console.log(`${color('bold', 'MERGE ROOM')} ${color('gray', '· multi-agent command cockpit')}\n\n  ${color('teal', 'merge-room')}                        open the conversational cockpit\n  ${color('teal', 'merge-room')} ${color('white', '"your mission"')}       run a mission directly\n  ${color('teal', 'merge-room')} ${color('white', 'run "your mission"')}   explicit run form\n  ${color('teal', 'merge-room')} ${color('white', 'plan "your mission"')}  preview a run without provider calls\n  ${color('teal', 'merge-room')} ${color('white', 'interactive')}              cockpit alias\n  ${color('teal', 'merge-room')} ${color('white', '--json "mission"')}       return JSON for scripts\n  ${color('teal', 'merge-room')} ${color('white', 'agents')}                   show the specialist roster\n  ${color('teal', 'merge-room')} ${color('white', 'theme list')}              list cockpit palettes\n  ${color('teal', 'merge-room')} ${color('white', 'history')}                 list saved missions\n  ${color('teal', 'merge-room')} ${color('white', 'usage')}                  aggregate saved token usage\n  ${color('teal', 'merge-room')} ${color('white', 'show <id>')}               reopen a saved mission\n  ${color('teal', 'merge-room')} ${color('white', 'export <id>')}            print a Markdown transcript\n  ${color('teal', 'merge-room')} ${color('white', 'context')}                  preview workspace context\n  ${color('teal', 'merge-room')} ${color('white', 'doctor')}                   check local setup\n  ${color('teal', 'merge-room')} ${color('white', 'init')}                     create merge-room.config.json\n  ${color('teal', 'merge-room')} ${color('white', '--no-context')}            skip workspace excerpts\n  ${color('teal', 'merge-room')} ${color('white', '--help')}                  show this guide\n\n  ${color('gray', 'Set OPENAI_API_KEY for live runs. Without it, Merge Room uses a tiny local demo provider.')}`);
 console.log(`  ${color('teal', 'merge-room')} ${color('white', 'config')}                  show effective safe config`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'completions [shell]')}       print shell completion script`);
 console.log(`  ${color('teal', 'merge-room')} ${color('white', 'review "change"')}       review with bounded Git diff context`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'brainstorm "idea"')}      parallel specialist perspectives`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--team=scout,critic')}     run a focused team`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', 'resume <id> "follow-up"')} continue a mission`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--no-save')}              keep this run local`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--cwd path / -C path')}    target another workspace`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--prompt-file mission.md')} read a reusable mission file`);
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
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--theme=liquid-glass')}    choose a named cockpit palette`);
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
