import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreAgentStatuses } from '../src/cockpit.js';
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
