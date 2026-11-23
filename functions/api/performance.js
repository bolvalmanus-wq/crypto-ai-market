export async function onRequest({ request, env }) {
  if (!env.SCHEDULER_URL) {
    return Response.json({ error: "Cloud scheduler এখনো সংযুক্ত হয়নি।" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  try {
    const target = new URL("/performance", env.SCHEDULER_URL);
    const response = await fetch(target.toString(), {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(12000)
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (_) {
    return Response.json({ error: "সিদ্ধান্ত পরীক্ষার রিপোর্ট সার্ভার থেকে আনা যায়নি।" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}