import { runDocumentBatch } from './document-batch.js';

describe('bounded document discovery batch', () => {
  it('processes serially, with pacing, and stops at the source budget', async () => {
    let calls = 0;
    const waits: number[] = [];
    const processed = await runDocumentBatch({ processOne: async () => { calls++; return true; },
      maxSources: 3, maxDurationMs: 10000, now: () => 0, sleep: async ms => { waits.push(ms); } });
    expect(processed).toBe(3); expect(calls).toBe(3); expect(waits).toEqual([2000,2000]);
  });
  it('stops immediately on idle or provider backoff', async () => {
    let calls = 0;
    expect(await runDocumentBatch({ processOne: async () => { calls++; return false; },
      maxSources: 500, maxDurationMs: 10000 })).toBe(0);
    expect(calls).toBe(1);
  });
  it('does not claim another source after the time budget', async () => {
    let time = 0;
    expect(await runDocumentBatch({ processOne: async () => true, maxSources: 500,
      maxDurationMs: 1000, now: () => time, sleep: async ms => { time += ms; } })).toBe(1);
  });
  it('rejects unsafe batch limits', async () => {
    await expect(runDocumentBatch({ processOne: async () => true, maxSources: 501,
      maxDurationMs: 1000 })).rejects.toThrow('Invalid document batch limits');
  });
});
