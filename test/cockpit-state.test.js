import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreAgentStatuses } from '../src/cockpit.js';

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
