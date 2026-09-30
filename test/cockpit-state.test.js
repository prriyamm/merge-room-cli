import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCockpitEvent, beginCockpitTurn, createCockpitState, restoreAgentStatuses, snapshotCockpitAgents } from '../src/cockpit.js';
import { createCockpitRenderer } from '../src/ui.js';

test('recording a queued request does not steal focus from a later room selection', () => {
  const renderer = createCockpitRenderer({
    config: { agents: [] },
    provider: { name: 'test' },
    force: false,
    write: () => {}
  });

  renderer.state.activeRoom = 0;
  renderer.state.rooms[0].request = 'previous mission';
  renderer.state.activeRoom = 1;
  renderer.user(0, 'repeat previous mission');

  assert.equal(renderer.state.rooms[0].request, 'repeat previous mission');
  assert.equal(renderer.state.activeRoom, 1);
});

test('session restore only applies valid statuses to agents in the current team', () => {
  const currentAgents = [{ id: 'scout' }, { id: 'critic' }];
  const savedAgents = [
    { agent: { id: 'scout' }, status: 'working' },
    { agent: { id: 'critic' }, status: { polluted: true } },
    { agent: { id: 'retired-agent' }, status: 'done' },
    { agent: { id: '__proto__' }, status: { polluted: true } }
  ];

  const statuses = restoreAgentStatuses(currentAgents, savedAgents);

  assert.deepEqual(statuses, { scout: 'working', critic: 'done' });
  assert.equal(Object.getPrototypeOf(statuses), Object.prototype);
});

test('room agent snapshots keep old team identities and handoffs visible after a team change', () => {
  const originalTeam = [
    { id: 'scout', name: 'Scout', specialty: 'Research', color: 'cyan', mark: 'S', prompt: 'private prompt' },
    { id: 'critic', name: 'Critic', specialty: 'Review', color: 'magenta', mark: 'C' }
  ];
  const state = createCockpitState(originalTeam);
  beginCockpitTurn(state, 0, 'Review the proposal', originalTeam);
  applyCockpitEvent(state, 0, { type: 'agent:done', agent: originalTeam[0], text: 'Keep the proposal focused.' });

  const snapshot = snapshotCockpitAgents(originalTeam);
  assert.deepEqual(snapshot[0], {
    id: 'scout', name: 'Scout', specialty: 'Research', color: 'cyan', mark: 'S'
  });
  assert.equal(Object.hasOwn(snapshot[0], 'prompt'), false);

  const lines = [];
  let activeConfig = { agents: originalTeam };
  const renderer = createCockpitRenderer({
    config: activeConfig,
    getConfig: () => activeConfig,
    provider: { name: 'demo' },
    force: true,
    columns: 100,
    rows: 28,
    write: (line) => lines.push(line)
  });
  renderer.state.rooms[0] = state.rooms[0];
  activeConfig = { agents: [{ id: 'maker', name: 'Maker', specialty: 'Build', color: 'green', mark: 'M' }] };

  renderer.render();

  const output = lines.join('\n');
  assert.match(output, /Scout\s+done/);
  assert.match(output, /Keep the proposal focused\./);
});
