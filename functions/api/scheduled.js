export async function onRequest({ request, env }) {
  const workerUrl = env.MARKET_WORKER_URL || "https://crypto-ai-market-worker.bolvalmanus-wq.workers.dev";
  const incoming = new URL(request.url);
  if (request.method === "POST") {
    const target = new URL("/analyze", workerUrl);
    try {
      const body = await request.json();
      const response = await fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Origin: "https://crypto-ai-market.pages.dev" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
      });
      const text = await response.text();
      return new Response(text, { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ error: "সার্ভার বিশ্লেষণ চালাতে পারেনি।" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const target = new URL("/latest", workerUrl);
  for (const key of ["symbol", "timeframe"]) {
    const value = incoming.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  try {
    const response = await fetch(target.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const body = await response.text();
    return new Response(body, { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return Response.json({ error: "Cloud scheduler থেকে ফলাফল আনা যায়নি।" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
