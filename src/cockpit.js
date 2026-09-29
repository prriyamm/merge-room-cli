export const ROOM_COUNT = 2;

export function createCockpitState(agents = []) {
  return {
    activeRoom: 0,
    message: 'Start a mission in either room.',
    rooms: Array.from({ length: ROOM_COUNT }, (_, index) => createRoom(index, agents))
  };
}

export function resolveAgentReference(agents, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const byId = agents.find((agent) => String(agent.id || '').toLowerCase() === normalizedQuery);
  return byId || agents.find((agent) => String(agent.name || '').toLowerCase() === normalizedQuery) || null;
}

export function restoreAgentStatuses(currentAgents = [], savedAgents = []) {
  const statuses = Object.fromEntries(currentAgents.map((agent) => [agent.id, 'idle']));
  for (const saved of savedAgents) {
    const id = saved.agent?.id;
    if (id) statuses[id] = saved.status || 'done';
  }
  return statuses;
}

export async function waitForCockpitTasks(tasks) {
  do {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = [...tasks.values()];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  } while (tasks.size);
}

export function selectCockpitRoom(state, roomNumber) {
  const index = Number(roomNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= state.rooms.length) throw new Error(`Room must be between 1 and ${state.rooms.length}.`);
  state.activeRoom = index;
  state.message = `Room ${roomNumber} selected.`;
  return state.rooms[index];
}

export function resetCockpitRoom(state, roomIndex, agents = []) {
  const current = state.rooms[roomIndex];
  if (!current) throw new Error(`Unknown room: ${roomIndex + 1}.`);
  if (current.running) throw new Error(`Room ${roomIndex + 1} is working. Wait for it to finish before starting over.`);
  state.rooms[roomIndex] = createRoom(roomIndex, agents);
  state.message = `Room ${roomIndex + 1} is ready for a new session.`;
  return state.rooms[roomIndex];
}

export function beginCockpitTurn(state, roomIndex, request, agents = []) {
  const room = state.rooms[roomIndex];
  if (!room) throw new Error(`Unknown room: ${roomIndex + 1}.`);
  if (room.running) throw new Error(`Room ${roomIndex + 1} is already working. Switch rooms with /switch.`);
  room.running = true;
  room.status = 'preparing';
  room.request = String(request).trim();
  room.answerDraft = '';
  room.final = null;
  room.error = null;
  room.context = null;
  room.usage = { input: 0, output: 0, total: 0, calls: 0 };
  room.started = Date.now();
  room.finishedAt = null;
  room.events = [];
  room.notes = {};
  room.statuses = Object.fromEntries(agents.map((agent) => [agent.id, 'queued']));
  room.agentIds = agents.map((agent) => agent.id);
  room.turn += 1;
  state.message = `Room ${roomIndex + 1} started turn ${room.turn}. You can switch rooms while it works.`;
  return room;
}

export function applyCockpitEvent(state, roomIndex, payload) {
  const room = state.rooms[roomIndex];
  if (!room) return;
  room.usage = payload.telemetry || room.usage;
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (payload.type === 'run:start') { room.status = 'working'; if (!room.request) room.request = payload.request || ''; }
  if (payload.type === 'agents:dispatch') room.events.push({ time: now, message: `${payload.stageLabel}: ${payload.agentCount} specialist${payload.agentCount === 1 ? '' : 's'} dispatched` });
  if (payload.type === 'agent:start') { room.statuses[payload.agent.id] = 'working'; room.events.push({ time: now, message: `${payload.agent.name} started` }); }
  if (payload.type === 'agent:done') { room.statuses[payload.agent.id] = 'done'; room.notes[payload.agent.id] = payload.text || 'Note received.'; room.events.push({ time: now, message: `${payload.agent.name} returned a note` }); }
  if (payload.type === 'agent:error') { room.statuses[payload.agent.id] = 'error'; room.events.push({ time: now, message: `${payload.agent.name} failed: ${payload.error}` }); }
  if (payload.type === 'agent:skipped') { room.statuses[payload.agent.id] = 'skipped'; room.events.push({ time: now, message: `${payload.agent.name} skipped: ${payload.error}` }); }
  if (payload.type === 'synthesis:start') room.events.push({ time: now, message: 'Lead is merging the handoffs' });
  if (payload.type === 'synthesis:delta') room.answerDraft += payload.delta;
  if (payload.type === 'synthesis:error') room.events.push({ time: now, message: 'Lead unavailable; preserving specialist notes' });
  if (payload.type === 'run:cancelled') {
    room.status = 'cancelled';
    room.events.push({ time: now, message: payload.error || 'Mission cancelled.' });
    for (const [agentId, status] of Object.entries(room.statuses)) if (status === 'queued' || status === 'working') room.statuses[agentId] = 'cancelled';
  }
  if (payload.type === 'run:done') {
    room.result = payload.result;
    room.final = payload.result?.answer || room.answerDraft || null;
    room.usage = payload.result?.usage || room.usage;
    room.status = 'saving';
  }
}

export function finishCockpitTurn(state, roomIndex, result, error = null, { updateMessage = true } = {}) {
  const room = state.rooms[roomIndex];
  if (!room) return;
  room.running = false;
  room.finishedAt = Date.now();
  room.result = result || room.result;
  room.final = result?.answer || room.answerDraft || null;
  room.usage = result?.usage || room.usage;
  room.error = error ? String(error.message || error) : null;
  if (error?.name === 'AbortError') {
    for (const [agentId, status] of Object.entries(room.statuses)) if (status === 'queued' || status === 'working') room.statuses[agentId] = 'cancelled';
  }
  room.status = error ? (error.name === 'AbortError' ? 'cancelled' : 'error') : result?.degraded ? 'degraded' : 'done';
  if (updateMessage) state.message = error ? `Room ${roomIndex + 1} stopped: ${room.error}` : `Room ${roomIndex + 1} finished. Continue there or switch rooms.`;
}

function createRoom(index, agents) {
  return {
    id: index + 1,
    turn: 0,
    status: 'idle',
    running: false,
    request: '',
    context: null,
    statuses: Object.fromEntries(agents.map((agent) => [agent.id, 'idle'])),
    agentIds: agents.map((agent) => agent.id),
    notes: {},
    events: [],
    usage: { input: 0, output: 0, total: 0, calls: 0 },
    answerDraft: '',
    final: null,
    result: null,
    error: null,
    started: null,
    finishedAt: null
  };
}
