import { fetchMarketWorker, readWorkerJson, proxyJson } from "../../_shared/worker-proxy.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  try {
    const body = await request.json();
    const response = await fetchMarketWorker(env, "/v2/backtest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://crypto-ai-market.pages.dev"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const data = await readWorkerJson(response, "V2 backtest endpoint");
    return proxyJson(data, response.status);
  } catch (error) {
    console.error("V2 backtest proxy failed", error instanceof Error ? error.stack : String(error));
    return proxyJson({
      error: "V2 backtest unavailable",
      details: error instanceof Error ? error.message : String(error)
    }, error?.status || 502);
  }
}
