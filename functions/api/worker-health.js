import { fetchMarketWorker, readWorkerJson, proxyJson, findWorkerServiceBinding } from "../_shared/worker-proxy.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const serviceBinding = findWorkerServiceBinding(env);
  const transport = serviceBinding ? "service-binding" : "public-url-fallback";
  try {
    const response = await fetchMarketWorker(env, "/health", {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10000)
    });
    const worker = await readWorkerJson(response, "Worker health endpoint");
    const ok = response.ok && worker?.ok === true && worker?.service === "crypto-ai-market-worker";
    return proxyJson({
      ok,
      transport,
      bindingName: serviceBinding?.name || null,
      workerStatus: response.status,
      worker,
      checkedAt: new Date().toISOString()
    }, ok ? 200 : 502);
  } catch (error) {
    console.error("Worker health proxy failed", error instanceof Error ? error.stack : String(error));
    return proxyJson({
      ok: false,
      transport,
      bindingName: serviceBinding?.name || null,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    }, 502);
  }
}
