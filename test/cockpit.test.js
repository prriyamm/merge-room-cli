import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCockpitEvent, beginCockpitTurn, createCockpitState, finishCockpitTurn } from '../src/cockpit.js';

const agents = [{ id: 'scout', name: 'Scout' }, { id: 'critic', name: 'Critic' }];

test('beginCockpitTurn clears prior per-turn state and queues the selected team', () => {
  const state = createCockpitState(agents);
  const room = state.rooms[0];
  room.usage = { input: 42, output: 12, total: 54, calls: 2 };
  room.final = 'previous answer';
  room.events.push({ message: 'previous event' });

  beginCockpitTurn(state, 0, '  inspect the release  ', agents);

  assert.equal(room.request, 'inspect the release');
  assert.equal(room.running, true);
  assert.equal(room.status, 'preparing');
  assert.deepEqual(room.statuses, { scout: 'queued', critic: 'queued' });
  assert.deepEqual(room.usage, { input: 0, output: 0, total: 0, calls: 0 });
  assert.equal(room.final, null);
  assert.deepEqual(room.events, []);
});

test('cancellation marks active and queued specialists, then finishes as cancelled', () => {
  const state = createCockpitState(agents);
  beginCockpitTurn(state, 0, 'inspect the release', agents);
  applyCockpitEvent(state, 0, { type: 'agent:start', agent: agents[0] });
  applyCockpitEvent(state, 0, { type: 'run:cancelled', error: 'Mission cancelled.' });

  assert.equal(state.rooms[0].status, 'cancelled');
  assert.deepEqual(state.rooms[0].statuses, { scout: 'cancelled', critic: 'cancelled' });

  const error = new Error('Mission cancelled.');
  error.name = 'AbortError';
  finishCockpitTurn(state, 0, null, error);
  assert.equal(state.rooms[0].running, false);
  assert.equal(state.rooms[0].status, 'cancelled');
  assert.ok(Number.isFinite(state.rooms[0].finishedAt));
});

test('ordinary failure marks unfinished specialists as failed and preserves completed work', () => {
  const team = [...agents, { id: 'scribe', name: 'Scribe' }];
  const state = createCockpitState(team);
  beginCockpitTurn(state, 0, 'inspect the release', team);
  applyCockpitEvent(state, 0, { type: 'agent:start', agent: agents[0] });
  applyCockpitEvent(state, 0, { type: 'agent:done', agent: agents[0], text: 'Release looks healthy.' });
  applyCockpitEvent(state, 0, { type: 'agent:start', agent: agents[1] });

  finishCockpitTurn(state, 0, null, new Error('Workspace context failed.'));

  assert.equal(state.rooms[0].running, false);
  assert.equal(state.rooms[0].status, 'error');
  assert.deepEqual(state.rooms[0].statuses, { scout: 'done', critic: 'error', scribe: 'error' });
});

test('run completion enters saving, then preserves degraded status and final usage', () => {
  const state = createCockpitState(agents);
  beginCockpitTurn(state, 0, 'inspect the release', agents);
  const result = { answer: 'Best-effort answer', degraded: true, usage: { input: 8, output: 5, total: 13, calls: 3 } };

  applyCockpitEvent(state, 0, { type: 'run:done', result, telemetry: result.usage });
  assert.equal(state.rooms[0].status, 'saving');

  finishCockpitTurn(state, 0, result);
  assert.equal(state.rooms[0].running, false);
  assert.equal(state.rooms[0].status, 'degraded');
  assert.equal(state.rooms[0].final, 'Best-effort answer');
  assert.deepEqual(state.rooms[0].usage, result.usage);
});
