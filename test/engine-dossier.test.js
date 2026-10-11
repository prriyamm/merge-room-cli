import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MergeRoomEngine } from '../src/engine.js';

class FlakyStubProvider {
  constructor() {
    this.name = 'stub';
    this.model = 'stub-model';
    this.prompts = [];
  }

  async complete({ system, prompt }) {
    this.prompts.push({ system, prompt });
    if (/Merge Room.s lead/i.test(system)) {
      return {
        text: 'final answer', inputTokens: 1, outputTokens: 1,
        inputEstimated: false, outputEstimated: false,
      };
    }
    if (/^You are Architect,/.test(system)) {
      throw new Error('boom-unavailable');
    }
    if (/Scout/i.test(system)) {
      return {
        text: 'SCOUT-DONE-NOTE', inputTokens: 1, outputTokens: 1,
        inputEstimated: false, outputEstimated: false,
      };
    }
    if (/Maker/i.test(system)) {
      return {
        text: 'MAKER-DONE-NOTE', inputTokens: 1, outputTokens: 1,
        inputEstimated: false, outputEstimated: false,
      };
    }
    if (/Critic/i.test(system)) {
      return {
        text: 'CRITIC-DONE-NOTE', inputTokens: 1, outputTokens: 1,
        inputEstimated: false, outputEstimated: false,
      };
    }
    return {
      text: 'DONE-NOTE', inputTokens: 1, outputTokens: 1,
      inputEstimated: false, outputEstimated: false,
    };
  }
}

test('staged dossiers exclude error placeholders from downstream prompts', async () => {
  const config = { ...DEFAULT_CONFIG, strategy: 'staged', maxCalls: 20 };
  const provider = new FlakyStubProvider();
  const engine = new MergeRoomEngine({ config, provider });

  const result = await engine.run('dossier filter probe');

  // Wave/result structures stay intact: the failed agent is still reported.
  const architect = result.agents.find((item) => item.agent.id === 'architect');
  assert.ok(architect, 'architect result still present');
  assert.equal(architect.status, 'error');
  assert.match(architect.text, /Agent unavailable/);

  const synthesisCall = provider.prompts.find((call) => /Merge Room.s lead/i.test(call.system));
  assert.ok(synthesisCall, 'synthesis prompt was recorded');
  assert.ok(synthesisCall.prompt.includes('SCOUT-DONE-NOTE'), 'synthesis keeps done notes');
  assert.ok(!synthesisCall.prompt.includes('Agent unavailable'), 'synthesis must not contain error placeholder');
  assert.ok(!synthesisCall.prompt.includes('boom-unavailable'), 'synthesis must not leak provider error text');

  // Early notes feed the draft stage: Maker must not see the Architect failure as real notes.
  const draftCall = provider.prompts.find((call) => /Maker/i.test(call.system));
  assert.ok(draftCall, 'draft prompt was recorded');
  assert.ok(draftCall.prompt.includes('SCOUT-DONE-NOTE'), 'draft keeps done notes');
  assert.ok(!draftCall.prompt.includes('Agent unavailable'), 'draft must not contain error placeholder');
  assert.ok(!draftCall.prompt.includes('boom-unavailable'), 'draft must not leak provider error text');

  // Both filtered dossiers feed the review stage: Critic must not see the failure either.
  const reviewCall = provider.prompts.find((call) => /^You are Critic,/.test(call.system));
  assert.ok(reviewCall, 'review prompt was recorded');
  assert.ok(reviewCall.prompt.includes('SCOUT-DONE-NOTE'), 'review keeps done notes');
  assert.ok(reviewCall.prompt.includes('MAKER-DONE-NOTE'), 'review keeps draft notes');
  assert.ok(!reviewCall.prompt.includes('Agent unavailable'), 'review must not contain error placeholder');
  assert.ok(!reviewCall.prompt.includes('boom-unavailable'), 'review must not leak provider error text');
});

test('budget-exhausted agents report skipped status without leaking placeholders into answers', async () => {
  const config = { ...DEFAULT_CONFIG, strategy: 'staged', maxCalls: 2, maxConcurrency: 1 };
  const provider = new FlakyStubProvider();
  const engine = new MergeRoomEngine({ config, provider });

  const result = await engine.run('skipped filter probe');

  const skipped = result.agents.filter((item) => item.status === 'skipped');
  assert.ok(skipped.length > 0, 'budget exhaustion produces skipped agents');
  assert.ok(result.degraded, 'run is degraded');
  // The lead call itself is over budget, so the fallback answer carries the
  // surviving done notes — never the skipped placeholder.
  assert.ok(!result.answer.includes('Agent skipped'), 'answer must not contain skipped placeholder');
  assert.ok(result.answer.includes('SCOUT-DONE-NOTE'), 'answer keeps done notes');
});
