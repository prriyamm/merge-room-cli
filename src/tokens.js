export function estimateTokens(text = '') {
  return Math.max(0, Math.ceil(String(text).length / 4));
}

export function createLedger() {
  const ledger = { input: 0, output: 0, calls: 0, startedAt: Date.now() };
 const estimated = { input: 0, output: 0 };
  const models = new Map();
  return {
    add(input, output, { inputEstimated = false, outputEstimated = false, model } = {}) {
    ledger.input += Number(input) || 0;
    ledger.output += Number(output) || 0;
     if (inputEstimated) estimated.input += Number(input) || 0;
     if (outputEstimated) estimated.output += Number(output) || 0;
    ledger.calls += 1;
      if (model) {
        const bucket = models.get(model) || { input: 0, output: 0, calls: 0, estimatedInput: 0, estimatedOutput: 0 };
        bucket.input += Number(input) || 0;
        bucket.output += Number(output) || 0;
        bucket.calls += 1;
        if (inputEstimated) bucket.estimatedInput += Number(input) || 0;
        if (outputEstimated) bucket.estimatedOutput += Number(output) || 0;
        models.set(model, bucket);
      }
  },
  snapshot() {
      const byModel = Object.fromEntries([...models.entries()].map(([model, bucket]) => [model, { ...bucket, total: bucket.input + bucket.output }]));
      return { ...ledger, total: ledger.input + ledger.output, estimatedInput: estimated.input, estimatedOutput: estimated.output, ...(Object.keys(byModel).length ? { byModel } : {}), elapsedMs: Date.now() - ledger.startedAt };
   }
 };
}

export function formatTokens(value) {
  if (value < 1000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return `${(value / 1000000).toFixed(1)}m`;
}
