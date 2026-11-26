const DEFAULT_WORKER_URL = "https://crypto-ai-market-worker.bolvalmanus-wq.workers.dev";

function workerRequestUrl(path, workerUrl) {
  const base = new URL(workerUrl);
  if (base.protocol !== "https:") throw new Error("MARKET_WORKER_URL must use HTTPS");
  return new URL(path, base);
}

/**
 * Prefer a Cloudflare Service Binding (no public DNS hop). Keep URL fallback
 * for existing Pages deployments that have not configured the binding yet.
 */
export async function fetchMarketWorker(env, path, init = {}) {
  const requestUrl = new URL(path, "https://market-worker.internal");
  const request = new Request(requestUrl, {
    ...init,
    headers: new Headers(init.headers || {})
  });
  if (env.MARKET_WORKER && typeof env.MARKET_WORKER.fetch === "function") {
    return env.MARKET_WORKER.fetch(request);
  }
  const target = workerRequestUrl(path, env.MARKET_WORKER_URL || DEFAULT_WORKER_URL);
  return fetch(target, { ...init, signal: init.signal || AbortSignal.timeout(15000) });
}

export async function readWorkerJson(response, label) {
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const preview = body.slice(0, 300);
    const error = new Error(label + " returned non-JSON (HTTP " + response.status + "): " + (preview || "empty response"));
    error.status = response.status >= 400 ? response.status : 502;
    error.details = preview || "Empty response";
    throw error;
  }
  return data;
}

export function proxyJson(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}
