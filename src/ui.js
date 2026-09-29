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
export const stripUnsafeTerminalControls = (value) => String(value)
  .replace(/\x1B\](?:[^\x07\x1B]|\x1B(?!\\))*(?:\x07|\x1B\\|$)/g, '')
  .replace(/\x1B[PX^_][\s\S]*?(?:\x1B\\|$)/g, '')
  .replace(/\x1B\[(?![0-?]*[ -/]*m)[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1B(?!\[)/g, '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F-\x9F]/g, '')
  .replace(/[\r\n]+/g, ' ');
const sanitizeMultilineText = (value) => String(value)
  .replace(/\r\n?/g, '\n')
  .replace(/\x1B\](?:[^\x07\x1B]|\x1B(?!\\))*(?:\x07|\x1B\\|$)/g, '')
  .replace(/\x1B[PX^_][\s\S]*?(?:\x1B\\|$)/g, '')
  .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1B./gs, '')
  .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, ' ');
const sanitizeUntrustedText = (value) => sanitizeMultilineText(value).replace(/\n+/g, ' ');
const sanitizeInlineText = sanitizeUntrustedText;
const width = () => Math.max(48, Math.min(process.stdout.columns || 92, 118) - 2);
const line = (char = '─') => char.repeat(width());
const crop = (value, max) => {
  const text = sanitizeUntrustedText(value).replace(/\s+/g, ' ');
  const limit = Math.max(0, Math.floor(max));
  const items = graphemes(text);
  if (items.reduce((total, item) => total + graphemeWidth(item), 0) <= limit) return text;
  if (limit <= 0) return '';
  let output = '';
  let used = 0;
  for (const grapheme of items) {
    const width = graphemeWidth(grapheme);
    if (used + width > limit - 1) break;
    output += grapheme;
    used += width;
  }
  return `${output}…`;
};
const graphemes = (value) => typeof Intl.Segmenter === 'function'
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(({ segment }) => segment)
  : [...value];
const graphemeWidth = (value) => {
  if (value.includes('\ufe0e') && !value.includes('\ufe0f') && !value.includes('\u200d')) {
    return [...value].reduce((total, character) => total + characterWidth(character), 0);
  }
  if (value.includes('\u200d') || value.includes('\ufe0f') || value.includes('\u20e3')
    || [...value].length === 2 && [...value].every((character) => /\p{Regional_Indicator}/u.test(character))) return 2;
  return /\p{Emoji_Presentation}/u.test(value) ? 2
    : [...value].reduce((total, character) => total + characterWidth(character), 0);
};
const wrap = (value, max) => {
  const limit = Math.max(1, Math.floor(max));
  const lines = [];
  let current = '';
  let currentWidth = 0;
  const pushWord = (word) => {
    let part = '';
    let partWidth = 0;
    for (const grapheme of graphemes(word)) {
      const nextWidth = graphemeWidth(grapheme);
      if (part && partWidth + nextWidth > limit) {
        if (current) lines.push(current);
        lines.push(part);
        current = '';
        currentWidth = 0;
        part = '';
        partWidth = 0;
      }
      part += grapheme;
      partWidth += nextWidth;
    }
    if (current && currentWidth + 1 + partWidth > limit) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    if (current) {
      current += ` ${part}`;
      currentWidth += 1 + partWidth;
    } else {
      current = part;
      currentWidth = partWidth;
    }
  };
  for (const word of sanitizeUntrustedText(value).split(/\s+/).filter(Boolean)) pushWord(word);
  if (current) lines.push(current);
  return lines;
};

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
  write(`  ${color('bold', 'Merge Room')}  ${color('gray', `${sanitizeUntrustedText(provider)}/${sanitizeUntrustedText(model)} · two rooms ·`)} ${color('teal', '/help')}`);
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
  const safeProvider = sanitizeUntrustedText(provider);
  const safeModel = sanitizeUntrustedText(model);
  console.log(`  ${color('teal', '│')} ${color('white', 'A quiet place to make complicated things move.')} ${color('gray', `provider ${safeProvider}  ·  ${safeModel}`)}${' '.repeat(Math.max(1, w - 66 - safeProvider.length - safeModel.length))}${color('teal', '│')}`);
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
      console.log(`  ${icon} ${color(agent.color, sanitizeUntrustedText(agent.mark))} ${color('bold', sanitizeUntrustedText(agent.name).padEnd(12))} ${color('gray', sanitizeUntrustedText(agent.specialty).padEnd(23))} ${label}`);
    }
    const notes = [...state.notes.entries()].slice(-2);
    if (notes.length) {
      console.log(`  ${color('bold', 'HANDOFF NOTES')}`);
      for (const [agentId, note] of notes) {
        const agent = config.agents.find((item) => item.id === agentId);
        console.log(`  ${color(agent?.color || 'gray', sanitizeUntrustedText(agent?.mark || '·'))} ${color('gray', crop(note, width() - 9))}`);
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
    if (payload.type === 'agents:dispatch') state.events.push({ time: now, message: `${color('teal', 'wave')} ${color('gray', `${sanitizeInlineText(payload.stageLabel)} · ${payload.agentCount} specialist${payload.agentCount === 1 ? '' : 's'}`)}` });
    if (payload.type === 'agent:start') { state.statuses.set(payload.agent.id, 'working'); state.events.push({ time: now, message: `${color(payload.agent.color, sanitizeUntrustedText(payload.agent.name))} ${color('gray', 'picked up the thread')}` }); }
    if (payload.type === 'agent:done') { state.statuses.set(payload.agent.id, 'done'); state.notes.set(payload.agent.id, payload.text || 'note received'); state.events.push({ time: now, message: `${color('green', 'done')} ${color('gray', `${sanitizeUntrustedText(payload.agent.name || payload.agent?.name || 'specialist')} returned a note`)}` }); }
    if (payload.type === 'agent:error') { state.statuses.set(payload.agent.id, 'error'); state.events.push({ time: now, message: `${color('red', 'error')} ${color('gray', crop(payload.error, width() - 20))}` }); }
    if (payload.type === 'agent:skipped') { state.statuses.set(payload.agent.id, 'skipped'); state.events.push({ time: now, message: `${color('yellow', 'skip')} ${color('gray', crop(payload.error, width() - 20))}` }); }
   if (payload.type === 'synthesis:start') state.events.push({ time: now, message: `${color('teal', 'merge-room')} ${color('gray', 'is weaving the notes together')}` });
    if (payload.type === 'synthesis:error') state.events.push({ time: now, message: `${color('yellow', 'fallback')} ${color('gray', 'lead synthesis unavailable; preserving specialist notes')}` });
    if (payload.type === 'run:cancelled') state.events.push({ time: now, message: `${color('yellow', 'paused')} ${color('gray', sanitizeUntrustedText(payload.error || 'mission cancelled'))}` });
   if (payload.type === 'synthesis:delta') state.answerDraft += payload.delta;
    if (payload.type === 'run:done') state.final = payload.result.answer;
    const deltaDue = payload.type !== 'synthesis:delta' || Date.now() - state.lastRenderAt >= 80;
    if (live && deltaDue) render();
    else if (payload.type === 'run:start') console.log(`Merge Room · ${sanitizeUntrustedText(payload.request)}`);
    else if (payload.type === 'agent:done') console.log(`  ${sanitizeUntrustedText(payload.agent.name)} done`);
    else if (payload.type === 'agent:error') console.log(`  ${sanitizeUntrustedText(payload.agent.name)} error: ${sanitizeUntrustedText(payload.error)}`);
    else if (payload.type === 'agent:skipped') console.log(`  ${sanitizeUntrustedText(payload.agent.name)} skipped: ${sanitizeUntrustedText(payload.error)}`);
    else if (payload.type === 'synthesis:error') console.log(`  Lead synthesis unavailable: ${sanitizeUntrustedText(payload.error)}`);
    else if (payload.type === 'run:cancelled') console.log(`  Mission cancelled: ${sanitizeUntrustedText(payload.error || 'Mission cancelled.')}`);
   else if (payload.type === 'run:done') console.log(`\n${sanitizeMultilineText(payload.result.answer)}\n`);
  };
  return { event, render, state };
}

export function createCockpitRenderer({ config, provider, workspace = process.cwd(), onRefresh = () => {}, force = false, columns, rows, write = (line) => console.log(line) }) {
  const state = createCockpitState(config.agents);
  const safeWrite = (line = '') => write(stripUnsafeTerminalControls(line));
  let lastRenderAt = 0;
  const refresh = () => { render(); onRefresh(); };
  const event = (roomIndex) => (payload) => {
    applyCockpitEvent(state, roomIndex, payload);
    if (payload.type !== 'synthesis:delta' || Date.now() - lastRenderAt >= 80) refresh();
  };
  const start = (options) => printCockpitWelcome({ provider: provider.name, model: config.model, workspace, ...options, write: safeWrite });
  const user = (roomIndex, request) => {
    state.activeRoom = roomIndex;
    state.rooms[roomIndex].request = request;
    refresh();
  };
  const loaded = () => refresh();
  const notice = (message) => { state.message = message; refresh(); };
  const render = () => {
    if (!live && !force) return;
    lastRenderAt = Date.now();
    clear();
    const terminalWidth = Math.max(1, Math.min(columns || process.stdout.columns || 108, 140));
    const terminalRows = Math.max(1, rows || process.stdout.rows || 32);
    const terminalHeight = Math.max(1, terminalRows - 1);
    const header = ` ${color('bold', 'MERGE ROOM')} ${color('gray', `· ${sanitizeUntrustedText(provider.name)} · two live sessions`)}`;
    const help = ' /1 /2 switch · /new reset · /cancel [1|2] · /help · /quit';
    if (terminalWidth < 84 || terminalRows < 24) {
      const isHelpMessage = state.message.startsWith('Help:') || state.message.startsWith('/agents [id] /team');
      const isPrimaryHelp = state.message.startsWith('Help: mission');
      const shortHelp = terminalWidth >= 60
        ? isPrimaryHelp ? 'Help: /run /1 /2 /new /wait /cancel [1|2] /help more' : 'Help: /agents /team /profile /context /history /show …'
        : terminalWidth >= 40
          ? isPrimaryHelp ? 'Help: /run /1 /2 /new /wait /help more' : 'Help: /agents /team /profile /show …'
        : terminalWidth >= 30
          ? isPrimaryHelp ? 'Help: /run /1 /2 …' : 'Help: /team /profile …'
          : terminalWidth >= 17
            ? isPrimaryHelp ? 'Help: /run /1 …' : 'Help: /team …'
            : terminalWidth >= 10 ? 'Help: …' : '…';
      const showRoomStatus = !isHelpMessage && terminalHeight >= 4;
      const showHelp = !isHelpMessage && terminalHeight >= 5;
      const showMessage = terminalHeight >= 3 || isHelpMessage && terminalHeight >= 2;
      const messageCapacity = Math.max(0, terminalHeight - 1 - Number(showRoomStatus) - Number(showHelp) - Number(!isHelpMessage));
      const fullMessage = isHelpMessage ? state.message || '' : crop(state.message || '', Math.max(0, terminalWidth - 4));
      const fullHelpLines = showMessage ? wrap(fullMessage, Math.max(1, terminalWidth - 2)) : [];
      const useShortHelp = isHelpMessage && (terminalHeight <= 3 || fullHelpLines.length > messageCapacity);
      const message = useShortHelp ? shortHelp : fullMessage;
      const wrappedMessage = useShortHelp ? wrap(message, Math.max(1, terminalWidth - 2)) : fullHelpLines;
      const messageLines = showMessage && !wrappedMessage.length ? [''] : wrappedMessage;
      const visibleMessageLines = messageLines.slice(0, messageCapacity);
      const contentHeight = isHelpMessage ? 0 : Math.max(0, terminalHeight - 1 - Number(showRoomStatus) - Number(showHelp) - visibleMessageLines.length);
      const activeRoom = state.rooms[state.activeRoom];
      const otherRoom = state.rooms[state.activeRoom === 0 ? 1 : 0];
      const lines = [];
      const latestNote = Object.entries(activeRoom.notes).at(-1);
      const latestEvent = activeRoom.events.at(-1);
      const answer = activeRoom.final || activeRoom.answerDraft;
      if (activeRoom.request) lines.push(` Mission: ${crop(activeRoom.request, Math.max(0, terminalWidth - 10))}`);
      if (latestNote && latestEvent && answer && contentHeight <= 3) {
        const detailWidth = Math.max(0, Math.floor((terminalWidth - 24) / 2));
        lines.push(` Handoff: ${crop(latestNote[1], detailWidth)} · Latest: ${crop(latestEvent.message, detailWidth)}`);
      } else {
        if (latestNote) lines.push(` Handoff: ${crop(latestNote[1], Math.max(0, terminalWidth - 10))}`);
        if (latestEvent) lines.push(` Latest: ${crop(latestEvent.message, Math.max(0, terminalWidth - 9))}`);
      }
      if (activeRoom.error && !answer) lines.unshift(` ${activeRoom.status === 'cancelled' ? 'Cancelled' : 'Stopped'}: ${crop(activeRoom.error, Math.max(0, terminalWidth - 10))}`);
      if (answer && contentHeight > 0) {
        if (contentHeight === 1 && (activeRoom.error || activeRoom.status === 'cancelled')) {
          const status = activeRoom.status === 'cancelled' ? 'CANCELLED' : 'FAILED';
          const reasonLimit = Math.max(0, Math.min(18, terminalWidth - visibleLength(` PARTIAL · ${status}: `) - 15));
          const reasonText = activeRoom.error && terminalWidth >= 44 ? crop(activeRoom.error, reasonLimit) : '';
          const detail = terminalWidth >= 30 ? ` · ${status}${reasonText ? ` (${reasonText})` : ''}` : '';
          const prefix = ` PARTIAL${detail}: `;
          lines.splice(0, lines.length, ` ${color('yellow', 'PARTIAL')}${terminalWidth >= 30 ? ` · ${color('red', status)}${reasonText ? ` (${reasonText})` : ''}` : ''}: ${crop(answer, Math.max(0, terminalWidth - visibleLength(prefix)))}`);
        } else {
          if (activeRoom.error) lines.splice(0, lines.length, ` ${activeRoom.status === 'cancelled' ? 'Cancelled' : 'Stopped'}: ${crop(activeRoom.error, Math.max(0, terminalWidth - 10))}`);
          else lines.splice(Math.max(0, contentHeight - 1));
          const answerLabel = activeRoom.error || activeRoom.status === 'cancelled' ? 'PARTIAL ANSWER' : 'MERGE ROOM SAYS';
          if (contentHeight === lines.length + 1) {
            lines.push(` ${activeRoom.error || activeRoom.status === 'cancelled' ? 'Partial' : 'Answer'}: ${crop(answer, Math.max(0, terminalWidth - 10))}`);
          } else {
            lines.push(` ${color('bold', answerLabel)}`);
            const answerRows = Math.max(0, contentHeight - lines.length);
            if (answerRows > 0) lines.push(...wrap(answer, Math.max(1, terminalWidth - 2)).slice(-answerRows).map((item) => ` ${color('white', item)}`));
          }
        }
      }
      if (!lines.length && contentHeight > 0) lines.push(' Type a mission to start this room.');
      safeWrite(fit(header, terminalWidth));
      if (showRoomStatus) {
        const compactStatus = (status) => ({ preparing: 'prep', working: 'work', cancelled: 'stop', degraded: 'degr', saving: 'save', queued: 'queue' })[status] || status;
        const tinyStatus = (status) => ({ preparing: 'p', working: 'w', cancelled: 'c', degraded: 'd', saving: 's', queued: 'q', idle: 'i', done: 'o', error: 'e' })[status] || '?';
        const roomStatus = terminalWidth >= 44
          ? ` Room ${activeRoom.id}: ${activeRoom.status} · Room ${otherRoom.id}: ${otherRoom.status}`
          : terminalWidth >= 20
            ? ` ${activeRoom.id}:${compactStatus(activeRoom.status)} · ${otherRoom.id}:${compactStatus(otherRoom.status)}`
            : terminalWidth >= 8
              ? ` ${activeRoom.id}:${tinyStatus(activeRoom.status)} ${otherRoom.id}:${tinyStatus(otherRoom.status)}`
              : terminalWidth >= 5
                ? `${activeRoom.id}${tinyStatus(activeRoom.status)} ${otherRoom.id}${tinyStatus(otherRoom.status)}`
                : `${activeRoom.id}${tinyStatus(activeRoom.status)}${otherRoom.id}${tinyStatus(otherRoom.status)}`;
        safeWrite(surface(fit(roomStatus, terminalWidth)));
      }
      for (const item of lines.slice(0, contentHeight)) safeWrite(surface(fit(item, terminalWidth)));
      if (showHelp) safeWrite(surface(fit(help, terminalWidth)));
      for (const line of visibleMessageLines) safeWrite(surface(fit(` ${color('teal', line)}`, terminalWidth)));
      return;
    }
    const sidebarWidth = Math.min(34, Math.max(27, Math.floor(terminalWidth * 0.3)));
    const mainWidth = terminalWidth - sidebarWidth - 3;
    const wrappedMessage = wrap(state.message || '', Math.max(1, terminalWidth - 2));
    const messageLines = (wrappedMessage.length ? wrappedMessage : ['']).slice(0, Math.max(0, terminalHeight - 3));
    const contentHeight = Math.max(0, terminalHeight - 3 - messageLines.length);
    const sidebar = cockpitSidebar(state, config, sidebarWidth, contentHeight);
    const main = cockpitMain(state, config, workspace, mainWidth, contentHeight);
    safeWrite(`${color('teal', '╭')}${fit(header, terminalWidth - 2)}${color('teal', '╮')}`);
    for (let index = 0; index < contentHeight; index += 1) {
      safeWrite(`${color('teal', '│')}${fit(sidebar[index] || '', sidebarWidth)}${color('teal', '│')}${fit(main[index] || '', mainWidth)}${color('teal', '│')}`);
    }
    safeWrite(`${color('teal', '╰')}${'─'.repeat(sidebarWidth)}${color('teal', '┴')}${'─'.repeat(mainWidth)}${color('teal', '╯')}`);
    safeWrite(surface(fit(` ${color('gray', '/1 /2 switch · /new reset · /cancel [1|2] · /help commands · /quit leave')}`, terminalWidth)));
    for (const line of messageLines) safeWrite(surface(fit(` ${color('teal', line)}`, terminalWidth)));
  };
  return { state, start, user, loaded, notice, event, render, refresh };
}

export function createConversationRenderer({ config, provider, workspace = process.cwd(), onRefresh = () => {}, force = false, write = (line) => console.log(line) }) {
  const state = createCockpitState(config.agents);
  const enabled = Boolean((process.stdin.isTTY && process.stdout.isTTY) || force);
  let started = false;
  const emit = (line = '') => { if (enabled) write(stripUnsafeTerminalControls(line)); };
  const refresh = () => onRefresh();
  const loaded = (session) => {
    emit('');
    emit(`  ${color('teal', sanitizeUntrustedText(session.id || 'session'))}  ${color('gray', sanitizeUntrustedText(session.savedAt || ''))}`);
    emit(`  ${color('bold', 'MISSION')}  ${sanitizeUntrustedText(session.request || '')}`);
    const degraded = Boolean(session.degraded || session.status === 'degraded');
    const status = degraded ? 'degraded' : session.status || 'complete';
    const durationMs = Number(session.durationMs);
    const duration = session.durationMs != null && Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= Date.now() ? `${(durationMs / 1000).toFixed(1)}s` : '';
    const agentCount = Array.isArray(session.agents) ? session.agents.length : Number(session.agents) || 0;
    const waveSummary = Array.isArray(session.waves) && session.waves.length ? session.waves.map((wave) => `${wave.label}:${wave.agentIds?.length || 0}`).join(' \u2192 ') : '';
    const summary = [status, session.strategy, duration, agentCount ? `${agentCount} agents` : '', waveSummary, session.runId ? `run ${session.runId}` : ''].filter(Boolean).map(sanitizeUntrustedText).join(' \u00b7 ');
    emit(`  ${color(degraded ? 'yellow' : 'gray', summary)}`);
    emit('');
    if (degraded) emit(`  ${color('yellow', '\u25b3 Best-effort run: one or more specialists were unavailable.')}`);
    if (session.synthesisError) emit(`  ${color('gray', `Synthesis: ${sanitizeUntrustedText(session.synthesisError)}`)}`);
    for (const paragraph of String(session.answer || '').split(/\n+/)) {
      for (const item of wrap(paragraph, Math.max(44, width() - 8))) emit(`  ${color('white', item)}`);
    }
    if (Array.isArray(session.agents) && session.agents.length) {
      emit('');
      emit(`  ${color('bold', 'SPECIALIST ROUTES')}`);
      for (const item of session.agents) {
        const name = sanitizeUntrustedText(item.agent?.name || item.agent?.id || 'Specialist');
        const route = [item.provider, item.model].filter(Boolean).map(sanitizeUntrustedText).join(' \u00b7 ');
        emit(`  ${name}${item.stage ? ` \u00b7 stage ${sanitizeUntrustedText(item.stage)}` : ''}${route ? ` \u00b7 ${route}` : ''}`);
      }
    }
    if (session.usage) {
      const usage = session.usage;
      const mark = (value, estimated) => `${estimated ? '~' : ''}${formatTokens(value || 0)}`;
      emit(`  ${color('gray', 'tokens')} ${mark(usage.total, usage.estimatedInput || usage.estimatedOutput)} total \u00b7 ${mark(usage.input, usage.estimatedInput)} in \u00b7 ${mark(usage.output, usage.estimatedOutput)} out`);
    }
    emit('');
    refresh();
  };
  const start = (options) => {
    if (started) return Promise.resolve();
    started = true;
    return printCockpitWelcome({ provider: provider.name, model: config.model, workspace, write: emit, ...options });
  };
  const user = (roomIndex, request) => {
    emit('');
    emit(`  ${color('teal', `Room ${roomIndex + 1} ›`)} ${color('white', sanitizeUntrustedText(request))}`);
  };
  const notice = (message) => emit(`  ${color('gray', '·')} ${color('teal', sanitizeUntrustedText(message))}`);
  const event = (roomIndex) => (payload) => {
    applyCockpitEvent(state, roomIndex, payload);
    if (!enabled) return;
    let visibleUpdate = false;
    const prefix = color('gray', `room ${roomIndex + 1}`);
    const cropAfter = (message, before) => crop(message, Math.max(0, width() - visibleLength(before)));
    if (payload.type === 'agent:start') {
      const before = `  ${prefix} ${color('gray', '○')} `;
      const name = cropAfter(payload.agent.name, `${before}${color('gray', ' is working')}`);
      emit(`${before}${color(payload.agent.color, name)} ${color('gray', 'is working')}`);
      visibleUpdate = true;
    }
    if (payload.type === 'agent:done') {
      const before = `  ${prefix} ${color('green', '✓')} `;
      const name = cropAfter(payload.agent.name, `${before}${color('gray', ' handed back a note')}`);
      emit(`${before}${color(payload.agent.color, name)} ${color('gray', 'handed back a note')}`);
      visibleUpdate = true;
    }
    if (payload.type === 'agent:error') {
      const before = `  ${color('red', '×')} ${prefix} `;
      emit(`${before}${color('red', cropAfter(payload.error, before))}`);
      visibleUpdate = true;
    }
    if (payload.type === 'agent:skipped') {
      const before = `  ${color('yellow', '–')} ${prefix} `;
      emit(`${before}${color('gray', cropAfter(payload.error, before))}`);
      visibleUpdate = true;
    }
    if (payload.type === 'synthesis:start') {
      const before = `  ${prefix} ${color('purple', '◇')} `;
      emit(`${before}${color('gray', cropAfter('Merging the room’s notes…', before))}`);
      visibleUpdate = true;
    }
    if (payload.type === 'synthesis:error') {
      const before = `  ${prefix} ${color('yellow', '△')} `;
      emit(`${before}${color('gray', cropAfter('Lead synthesis unavailable; keeping the specialist notes.', before))}`);
      visibleUpdate = true;
    }
    if (payload.type === 'run:cancelled') {
      const before = `  ${color('yellow', '△')} ${prefix} `;
      emit(`${before}${color('gray', cropAfter(payload.error || 'Mission cancelled.', before))}`);
      visibleUpdate = true;
    }
    if (payload.type === 'run:done') {
      visibleUpdate = true;
      emit('');
      const answerPrefix = `  ${prefix} `;
      const answerWidth = Math.max(1, width() - visibleLength(answerPrefix) - 1);
      for (const paragraph of String(payload.result.answer || '').split(/\n+/)) {
        for (const item of wrap(paragraph, answerWidth)) emit(`${answerPrefix}${color('white', item)}`);
      }
      const usage = payload.result.usage || {};
      const degraded = Boolean(payload.result.degraded);
      if (degraded) {
        const before = `  ${prefix} ${color('yellow', '△')} `;
        emit(`${before}${color('gray', cropAfter('Best-effort run: one or more specialists were unavailable.', before))}`);
      }
      emit('');
      emit(`  ${color(degraded ? 'yellow' : 'green', degraded ? '△' : '✓')} ${color('bold', `Room ${roomIndex + 1} ${degraded ? 'best effort' : 'complete'}`)} ${color('gray', `· ${formatTokens(usage.total || 0)} tokens · ${usage.calls || 0} calls`)}`);
    }
    if (visibleUpdate) refresh();
  };
  return { state, start, user, loaded, notice, event, refresh, render: () => {} };
}

function cockpitSidebar(state, config, maxWidth, height) {
  const lines = [` ${color('bold', 'ROOMS')}`, ''];
  const roomHeight = Math.max(4, Math.floor((height - 3) / state.rooms.length));
  for (const [roomIndex, room] of state.rooms.entries()) {
    const section = [];
    const selected = roomIndex === state.activeRoom;
    const marker = selected ? color('teal', '›') : ' ';
    const statusColor = room.status === 'done' ? 'green' : room.status === 'error' ? 'red' : room.running || ['cancelled', 'degraded'].includes(room.status) ? 'yellow' : 'gray';
    const status = color(statusColor, room.status);
    section.push(` ${marker} ${color('bold', `Room ${room.id}`)}  ${status}`);
    section.push(`   ${color('white', crop(room.request || 'Ready for a mission', maxWidth - 4))}`);
    const roomAgents = config.agents.filter((item) => room.agentIds.includes(item.id));
    const agentSlots = Math.max(1, roomHeight - 2);
    const visibleAgents = roomAgents.length > agentSlots ? roomAgents.slice(0, Math.max(0, agentSlots - 1)) : roomAgents;
    for (const agent of visibleAgents) {
      const agentStatus = room.statuses[agent.id] || 'idle';
      const icon = agentStatus === 'done' ? color('green', '●') : agentStatus === 'working' ? color('yellow', '◌') : agentStatus === 'error' ? color('red', '×') : agentStatus === 'skipped' || agentStatus === 'cancelled' ? color('yellow', '–') : color('gray', '○');
      const activity = agentStatus === 'working' ? `working · ${agent.specialty}` : agentStatus;
      section.push(`   ${icon} ${crop(agent.name, 10).padEnd(10)} ${color('gray', crop(activity, maxWidth - 16))}`);
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
    lines.push(` ${color(agent?.color || 'gray', sanitizeUntrustedText(agent?.mark || '·'))} ${color('gray', crop(note, maxWidth - 5))}`);
  }
  lines.push('', ` ${color('bold', 'RUN LOG')}`);
  if (!room.events.length) lines.push(` ${color('gray', 'Waiting for work.')}`);
  for (const item of room.events.slice(-3)) lines.push(` ${color('gray', item.time)} ${crop(item.message, maxWidth - 13)}`);
  if (room.error) lines.push('', ` ${color(room.status === 'cancelled' ? 'yellow' : 'red', crop(room.error, maxWidth - 2))}`);
  const answer = room.final || room.answerDraft;
  if (answer) {
    const heading = room.error || room.status === 'cancelled' ? 'PARTIAL ANSWER' : 'MERGE ROOM SAYS';
    lines.push('', ` ${color('bold', heading)}`);
    const remaining = Math.max(0, height - lines.length - 1);
    const answerLines = wrap(answer, maxWidth - 2);
    lines.push(...(remaining ? answerLines.slice(-remaining) : []).map((item) => ` ${color('white', item)}`));
  }
  const elapsed = room.started ? `${(((room.finishedAt || Date.now()) - room.started) / 1000).toFixed(1)}s` : '0.0s';
  const usage = room.usage || {};
  const footer = ` ${elapsed} · ${formatTokens(usage.total || 0)} tokens · ${usage.calls || 0} calls`;
  while (lines.length < height - 1) lines.push('');
  lines.push(color('gray', footer));
  return lines.slice(0, height);
}

function visibleLength(value) {
  return graphemes(String(value).replace(/\x1b\[[0-9;]*m/g, ''))
    .reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint === 0x200d || /\p{Mark}/u.test(character) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) ? 2 : 1;
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

export function printResult(result, { trace = false, includeAnswer = false } = {}) {
  console.log('');
  if (includeAnswer && result.answer) console.log(`${sanitizeMultilineText(result.answer)}\n`);
  if (trace) {
    console.log(`  ${color('bold', 'SPECIALIST TRACE')}`);
    for (const item of result.agents || []) {
      console.log(`  ${color(item.agent.color, sanitizeUntrustedText(item.agent.mark))} ${color('bold', sanitizeUntrustedText(item.agent.name))} ${color('gray', `· stage ${sanitizeUntrustedText(item.stage)} · ${sanitizeUntrustedText(item.model)} · ${sanitizeUntrustedText(item.status)} · ${((item.durationMs || 0) / 1000).toFixed(1)}s`)}`);
      console.log(`  ${color('white', sanitizeMultilineText(item.text))}\n`);
    }
  }
  const statusIcon = result.degraded ? color('yellow', '△') : color('green', '✓');
 const statusLabel = result.degraded ? 'Mission complete · best effort' : 'Mission complete';
 console.log(`  ${statusIcon} ${color('bold', statusLabel)} ${color('gray', `in ${(result.durationMs / 1000).toFixed(1)}s`)}`);
  if (result.synthesisError) console.log(`  ${color('gray', 'reason')} ${sanitizeUntrustedText(result.synthesisError)}`);
 const input = `${result.usage.estimatedInput ? '~' : ''}${formatTokens(result.usage.input)}`;
 const output = `${result.usage.estimatedOutput ? '~' : ''}${formatTokens(result.usage.output)}`;
  const total = `${result.usage.estimatedInput || result.usage.estimatedOutput ? '~' : ''}${formatTokens(result.usage.total)}`;
  const budget = result.maxCalls ? ` · cap ${result.maxCalls} calls` : '';
  console.log(`  ${color('gray', 'usage')} ${color('yellow', `${total} burned`)} · ${input} in · ${output} out · ${result.usage.calls || 0} calls · ${result.agents?.length || 0} agents${budget}`);
  if (result.sessionId) console.log(`  ${color('gray', 'saved')} ${color('teal', `merge-room show ${sanitizeUntrustedText(result.sessionId)}`)}`);
  console.log('');
}

export function printCockpitPartialAnswer(answer) {
  const text = sanitizeMultilineText(answer || '');
  if (text.trim()) console.log(`\n  ${color('yellow', 'PARTIAL ANSWER')}\n${text}\n`);
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
  console.log(`  ${color('gray', 'workspace')} ${color('white', sanitizeUntrustedText(plan.workspace))}`);
  console.log(`  ${color('gray', 'strategy')} ${color('teal', sanitizeUntrustedText(plan.strategy))}  ${color('gray', 'agents')} ${plan.agents.length}  ${color('gray', 'context')} ${plan.context ? `${plan.context.fileCount} files` : 'off'}`);
  console.log(`  ${color('gray', 'limits')} max ${plan.limits.maxCalls ? `${plan.limits.maxCalls} calls` : 'unlimited'} · ${plan.limits.maxConcurrency} concurrent · ${plan.limits.maxTokens} output tokens/call\n`);
  for (const wave of plan.waves) {
    const names = wave.agents.map((agent) => `${sanitizeUntrustedText(agent.mark)} ${sanitizeUntrustedText(agent.name)}`).join('  ');
    console.log(`  ${color('teal', `${sanitizeUntrustedText(wave.stage)}.`)} ${color('bold', sanitizeUntrustedText(wave.label).padEnd(13))} ${color('white', names)}`);
  }
  console.log(`\n  ${color('gray', 'Run the mission without `plan` when this shape looks right.')}\n`);
}

export function printHelp() {
  console.log(`${color('bold', 'MERGE ROOM')} ${color('gray', '· multi-agent command cockpit')}\n\n  ${color('teal', 'merge-room')}                        open the conversational cockpit\n  ${color('teal', 'merge-room')} ${color('white', '"your mission"')}       run a mission directly\n  ${color('teal', 'merge-room')} ${color('white', 'run "your mission"')}   explicit run form\n  ${color('teal', 'merge-room')} ${color('white', 'plan "your mission"')}  preview a run without provider calls\n  ${color('teal', 'merge-room')} ${color('white', 'interactive')}              cockpit alias\n  ${color('teal', 'merge-room')} ${color('white', '--json "mission"')}       return JSON for scripts\n  ${color('teal', 'merge-room')} ${color('white', 'agents')}                   show the specialist roster\n  ${color('teal', 'merge-room')} ${color('white', 'providers')}                inspect provider profiles and local CLI availability\n  ${color('teal', 'merge-room')} ${color('white', 'theme list')}              list cockpit palettes\n  ${color('teal', 'merge-room')} ${color('white', 'history')}                 list saved missions\n  ${color('teal', 'merge-room')} ${color('white', 'usage')}                  aggregate saved token usage\n  ${color('teal', 'merge-room')} ${color('white', 'show <id>')}               reopen a saved mission\n  ${color('teal', 'merge-room')} ${color('white', 'export <id>')}            print a Markdown transcript\n  ${color('teal', 'merge-room')} ${color('white', 'context')}                  preview workspace context\n  ${color('teal', 'merge-room')} ${color('white', 'doctor')}                   check local setup\n  ${color('teal', 'merge-room')} ${color('white', 'init')}                     create merge-room.config.json\n  ${color('teal', 'merge-room')} ${color('white', '--no-context')}            skip workspace excerpts\n  ${color('teal', 'merge-room')} ${color('white', '--help')}                  show this guide\n\n  ${color('gray', 'Set OPENAI_API_KEY for live runs. Without it, Merge Room uses a tiny local demo provider.')}`);
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
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--model=… --base-url=…')} override fallback provider settings`);
  console.log(`  ${color('teal', 'merge-room')} ${color('white', '--profile=<name>')}   route all agents and the lead through one profile`);
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
  for (const agent of config.agents) console.log(`  ${color(agent.color, sanitizeUntrustedText(agent.mark))} ${color('bold', sanitizeUntrustedText(agent.name).padEnd(13))} ${color('gray', `${sanitizeUntrustedText(agent.specialty)} · stage ${sanitizeUntrustedText(agent.stage)}${agent.provider ? ` · ${sanitizeUntrustedText(agent.provider)}` : ''}`)}${agent.model ? ` ${color('purple', `· ${sanitizeUntrustedText(agent.model)}`)}` : ''}\n     ${color('dim', sanitizeMultilineText(agent.prompt))}\n`);
}

export function printConfig(config) {
  printBanner({ provider: 'configuration', model: config.model });
  console.log(`  ${color('bold', 'EFFECTIVE CONFIG')}\n`);
  for (const [key, value] of Object.entries(config)) {
    if (key === 'agents' || key === 'context') continue;
    const rendered = typeof value === 'string' ? sanitizeUntrustedText(value) : typeof value === 'object' ? sanitizeUntrustedText(JSON.stringify(value)) : value;
    console.log(`  ${color('gray', sanitizeUntrustedText(key).padEnd(18))} ${rendered}`);
  }
  console.log(`\n  ${color('bold', 'AGENTS')}  ${config.agents.map((agent) => sanitizeUntrustedText(agent.id)).join(', ')}`);
  console.log(`  ${color('bold', 'CONTEXT')} ${sanitizeUntrustedText(JSON.stringify(config.context))}\n`);
}

export function printHistory(sessions) {
  if (!sessions.length) return console.log('  No Merge Room sessions yet. Run a mission to create one.\n');
  console.log(`\n  ${color('bold', 'RECENT MISSIONS')}\n`);
 for (const session of sessions.slice(0, 20)) {
   const when = session.savedAt ? new Date(session.savedAt).toLocaleString() : 'unknown time';
    const usage = session.usage || {};
    const burned = usage.total != null ? `${usage.estimatedInput || usage.estimatedOutput ? '~' : ''}${formatTokens(usage.total)} burned` : 'usage unavailable';
    const details = `${sanitizeUntrustedText(session.agents || 0)} agents · ${burned}${session.status === 'degraded' || session.degraded ? ' · degraded' : ''}${session.runId ? ` · run ${sanitizeUntrustedText(session.runId)}` : ''}`;
    console.log(`  ${color('teal', sanitizeUntrustedText(session.id))}  ${color('gray', sanitizeUntrustedText(when))}\n  ${color('gray', details)}\n  ${color('white', crop(session.request, width() - 4))}\n`);
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
      console.log(`  ${color('teal', sanitizeUntrustedText(model))}  ${values.sessions} missions · ${estimated ? '~' : ''}${formatTokens(values.total)} burned · ${values.calls || 0} calls`);
    }
    console.log('');
  }
}

export function printSession(session) {
  console.log(`\n  ${color('teal', sanitizeUntrustedText(session.id || 'session'))}  ${color('gray', sanitizeUntrustedText(session.savedAt || ''))}`);
 console.log(`  ${color('bold', 'MISSION')}  ${sanitizeMultilineText(session.request || '')}\n`);
  const degraded = Boolean(session.degraded || session.status === 'degraded');
  const durationMs = Number(session.durationMs);
  const duration = session.durationMs != null && Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= Date.now() ? `${(durationMs / 1000).toFixed(1)}s` : '';
  const waveSummary = session.waves?.length ? session.waves.map((wave) => `${sanitizeUntrustedText(wave.label)}:${wave.agentIds?.length || 0}`).join(' → ') : '';
  const agentCount = Array.isArray(session.agents) ? session.agents.length : Number(session.agents) || 0;
  const runSummary = [degraded ? 'degraded' : session.status || 'complete', session.strategy, duration, agentCount ? `${agentCount} agents` : '', waveSummary, session.runId ? `run ${sanitizeUntrustedText(session.runId)}` : ''].filter(Boolean).map(sanitizeUntrustedText).join(' · ');
  if (runSummary) console.log(`  ${color('gray', runSummary)}\n`);
 console.log(`  ${color('bold', 'MERGE ROOM SAYS')}\n  ${sanitizeMultilineText(session.answer || '')}\n`);
  if (degraded) console.log(`  ${color('yellow', '△')} ${color('gray', 'Best-effort run: one or more specialists were unavailable.')}\n`);
  if (session.synthesisError) console.log(`  ${color('gray', 'reason')} ${sanitizeUntrustedText(session.synthesisError)}\n`);
  if (Array.isArray(session.agents) && session.agents.length) {
    console.log(`  ${color('bold', 'SPECIALIST ROUTES')}`);
    for (const item of session.agents) {
      const name = sanitizeUntrustedText(item.agent?.name || item.agent?.id || 'Specialist');
      const route = [item.provider, item.model].filter(Boolean).map(sanitizeUntrustedText).join(' · ');
      console.log(`  ${name}${item.stage ? ` · stage ${sanitizeUntrustedText(item.stage)}` : ''}${route ? ` · ${route}` : ''}`);
    }
    console.log('');
  }
  if (session.usage) {
    const mark = (value, estimated) => `${estimated ? '~' : ''}${formatTokens(value || 0)}`;
    console.log(`  ${color('gray', 'tokens')} ${mark(session.usage.total, session.usage.estimatedInput || session.usage.estimatedOutput)} total · ${mark(session.usage.input, session.usage.estimatedInput)} in · ${mark(session.usage.output, session.usage.estimatedOutput)} out\n`);
  }
}
