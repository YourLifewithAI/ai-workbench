// What the mock is, in one sentence (N-3, spec/runs/NEXT.md).
//
// The mock answers from a fixture, so it does not respond to the text you typed. That is correct — it exists to
// prove the plumbing without a key or a bill — and it is surprising the first time, which is exactly what the
// weekend run found: an owner ran an agent on the mock, got the fixture's reply, and reasonably read it as the
// prompt being ignored. So the sentence lives here, once, and is written wherever the mock is chosen or was
// used. One constant rather than three strings, because three strings drift.
export const MOCK_NOTE = 'Replies come from a fixture, so it will not answer your text — it proves the plumbing, not the model.';

/** True when a run's model calls went to the mock adapter, which names its models `mock/…`. */
export function usedMock(modelIds: readonly string[]): boolean {
  return modelIds.some((id) => id.startsWith('mock/'));
}
