export async function onRequest({ request, env }) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const workerUrl = env.MARKET_WORKER_URL || "https://crypto-ai-market-worker.bolvalmanus-wq.workers.dev";
  try {
    const target = new URL("/performance", workerUrl);
    const response = await fetch(target.toString(), {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(12000)
    });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); }
    catch (_) {
      console.error("Scheduler performance endpoint returned non-JSON", response.status, body.slice(0, 500));
      return Response.json({
        error: "Cloud scheduler JSON রিপোর্ট দেয়নি।",
        upstreamStatus: response.status,
        details: body.slice(0, 300) || "Empty response"
      }, { status: response.ok ? 502 : response.status, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(data, {
      status: response.status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (error) {
    console.error("Performance proxy failed", error instanceof Error ? error.stack : String(error));
    return Response.json({
      error: "সিদ্ধান্ত পরীক্ষার রিপোর্ট সার্ভার থেকে আনা যায়নি।",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}