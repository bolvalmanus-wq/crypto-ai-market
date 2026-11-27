const DEFAULT_WORKER_URL = "https://crypto-ai-market-worker.bolvalmanus.workers.dev";

function workerRequestUrl(path, workerUrl) {
  const base = new URL(workerUrl);
  if (base.protocol !== "https:") throw new Error("MARKET_WORKER_URL must use HTTPS");
  return new URL(path, base);
}

/**
 * Prefer a Cloudflare Service Binding (no public DNS hop). Keep URL fallback
 * for existing Pages deployments that have not configured the binding yet.
 */
export function findWorkerServiceBinding(env) {
  if (env?.MARKET_WORKER && typeof env.MARKET_WORKER.fetch === "function") {
    return { name: "MARKET_WORKER", binding: env.MARKET_WORKER };
  }
  // Pages Service Binding variable names are user-defined. Detect the binding
  // even when it was configured as WORKER, CRYPTO_WORKER, or another name.
  for (const [name, value] of Object.entries(env || {})) {
    if (name !== "MARKET_WORKER" && name !== "ASSETS" && value && typeof value.fetch === "function") {
      return { name, binding: value };
    }
  }
  return null;
}

export async function fetchMarketWorker(env, path, init = {}) {
  const requestUrl = new URL(path, "https://market-worker.internal");
  const request = new Request(requestUrl, {
    ...init,
    headers: new Headers(init.headers || {})
  });
  const service = findWorkerServiceBinding(env);
  if (service) {
    try {
      const boundResponse = await service.binding.fetch(request.clone());
      // Service bindings can fail with an HTTP error response without
      // throwing. Treat 404 and 5xx as binding failures and retry the public
      // Worker endpoint; otherwise a stale binding masks the healthy Worker.
      if (boundResponse.status !== 404 && boundResponse.status < 500) {
        return boundResponse;
      }
      console.error("MARKET_WORKER service binding returned HTTP " + boundResponse.status + "; trying HTTPS fallback");
    } catch (bindingError) {
      console.error("MARKET_WORKER service binding failed; trying HTTPS fallback", String(bindingError));
    }
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
