// workerPool.js
import PQueue from 'p-queue';
import { getStickyProxy, reportDeadProxy } from './stickyProxyPool.js';

export async function runWithWorkerPool(items, handler, opts = {}) {
  const min = Math.max(1, opts.min ?? 3);
  const max = Math.max(min, opts.max ?? 6);
  const concurrency = max;
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const preferPaid = !!opts.preferPaid;
  const service = opts.service ?? 'generic';
  const queue = new PQueue({ concurrency });

  const results = new Array(items.length);
  let taskIndex = 0;

  // map incoming requests across workerIds deterministically (round-robin)
  await Promise.all(items.map((item, index) =>
    queue.add(async () => {
      const workerId = index % concurrency;
      let proxyInfo;
      try {
        proxyInfo = await getStickyProxy(workerId, { preferPaid, ttlMs, service });
      } catch (e) {
        results[index] = { error: 'NO_PROXY_AVAILABLE', message: e.message };
        return;
      }

      try {
        // Allow handler to accept injected proxyInfo: handler({ workerId, proxyInfo, item })
        results[index] = await handler({ workerId, proxyInfo, index, item });
      } catch (err) {
        const msg = err?.message || String(err);
        if (/ECONNRESET|EAI_AGAIN|ETIMEDOUT|ERR_|navigation|timeout|tunnel|net::/i.test(msg)) {
          // consider proxy dead — report and retry once with new proxy
          reportDeadProxy(workerId, proxyInfo);
          try {
            const newProxy = await getStickyProxy(workerId, { preferPaid, ttlMs, service });
            results[index] = await handler({ workerId, proxyInfo: newProxy, index, item });
          } catch (e2) {
            results[index] = { error: true, message: e2?.message || String(e2) };
          }
        } else {
          results[index] = { error: true, message: msg };
        }
      }
    })
  ));

  await queue.onIdle();
  return results;
}