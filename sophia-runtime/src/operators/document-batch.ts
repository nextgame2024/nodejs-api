// One bounded invocation; durable per-source leases/retries live in the service.
// Serial requests leave headroom for interactive downloads and invoice sync.
export async function runDocumentBatch(options: {
  processOne: () => Promise<boolean>;
  maxSources: number;
  maxDurationMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!Number.isInteger(options.maxSources) || options.maxSources < 1 || options.maxSources > 500
      || !Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0) {
    throw new Error('Invalid document batch limits.');
  }
  const deadline = now() + options.maxDurationMs;
  let processed = 0;
  while (processed < options.maxSources && now() < deadline && await options.processOne()) {
    processed++;
    if (processed < options.maxSources && now() < deadline) await sleep(2000);
  }
  return processed;
}
