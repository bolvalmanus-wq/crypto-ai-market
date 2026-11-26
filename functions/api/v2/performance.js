import { fetchMarketWorker, readWorkerJson, proxyJson } from "../../_shared/worker-proxy.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  try {
    const response = await fetchMarketWorker(env, "/v2/performance", {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000)
    });
    const data = await readWorkerJson(response, "V2 paper performance endpoint");
    return proxyJson(data, response.status);
  } catch (error) {
    console.error("V2 performance proxy failed", error instanceof Error ? error.stack : String(error));
    return proxyJson({
      error: "V2 paper report unavailable",
      details: error instanceof Error ? error.message : String(error),
      code: error?.cause?.code || error?.code || null
    }, error?.status || 502);
  }
}
