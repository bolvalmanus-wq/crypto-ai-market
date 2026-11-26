import { fetchMarketWorker, readWorkerJson, proxyJson } from "../_shared/worker-proxy.js";

export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const response = await fetchMarketWorker(env, "/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://crypto-ai-market.pages.dev"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
      });
      const data = await readWorkerJson(response, "Worker analysis endpoint");
      return proxyJson(data, response.status);
    } catch (error) {
      console.error("Scheduled analysis proxy failed", error instanceof Error ? error.stack : String(error));
      return proxyJson({
        error: "সার্ভার বিশ্লেষণ চালাতে পারেনি।",
        details: error instanceof Error ? error.message : String(error)
      }, error?.status || 502);
    }
  }
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const target = new URL("/latest", "https://market-worker.internal");
  for (const key of ["symbol", "timeframe"]) {
    const value = incoming.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  try {
    const response = await fetchMarketWorker(env, target.pathname + target.search, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10000)
    });
    const data = await readWorkerJson(response, "Worker latest endpoint");
    return proxyJson(data, response.status);
  } catch (error) {
    console.error("Latest scheduler proxy failed", error instanceof Error ? error.stack : String(error));
    return proxyJson({
      error: "Cloud scheduler থেকে ফলাফল আনা যায়নি।",
      details: error instanceof Error ? error.message : String(error)
    }, error?.status || 502);
  }
}
