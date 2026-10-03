const MIN_GAP_MS = Number(process.env.HIVE_MIN_GAP_MS || 1100);
let chain = Promise.resolve();
let lastRun = 0;

export function schedule(fn) {
  const run = async () => {
    const wait = Math.max(0, lastRun + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRun = Date.now();
    return fn();
  };
  const result = chain.then(run, run);
  chain = result.then(() => {}, () => {});
  return result;
}

export async function withRetry(fn, attempts = 6) {
  let backoff = 1000;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const retryable =
        err.status === 429 ||
        (err.status >= 500 && err.status < 600) ||
        err.status === undefined;
      if (!retryable || i === attempts) throw err;
      const ra = Number(err.retryAfter);
      const wait = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff)
        + Math.floor(Math.random() * 300);
      console.warn(`Hive retry ${i}/${attempts} in ${wait}ms (status ${err.status})`);
      await new Promise((r) => setTimeout(r, wait));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}
