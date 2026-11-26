import { fetchMarketWorker, readWorkerJson, proxyJson } from "../_shared/worker-proxy.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  try {
    const response = await fetchMarketWorker(env, "/performance", {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000)
    });
    const data = await readWorkerJson(response, "Scheduler performance endpoint");
    return proxyJson(data, response.status);
  } catch (error) {
    console.error("Performance proxy failed", error instanceof Error ? error.stack : String(error));
    return proxyJson({
      error: "সিদ্ধান্ত পরীক্ষার রিপোর্ট সার্ভার থেকে আনা যায়নি।",
      details: error instanceof Error ? error.message : String(error),
      code: error?.cause?.code || error?.code || null
    }, error?.status || 502);
  }
}
