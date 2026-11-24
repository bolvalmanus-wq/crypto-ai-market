export async function onRequest({ request, env }) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  if (!env.SCHEDULER_URL) {
    return Response.json({ error: "Cloud scheduler এখনো সংযুক্ত হয়নি।" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const target = new URL("/performance", env.SCHEDULER_URL);
    const response = await fetch(target.toString(), {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(12000)
    });
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch (_) {
      const hint = body.includes("1101") ? "Cloudflare Worker exception (1101)" :
        body.includes("1102") ? "Cloudflare Worker CPU limit (1102)" :
        "Scheduler returned a non-JSON response";
      return Response.json({ error: hint + "; Worker deployment/logs need checking." }, {
        status: response.ok ? 502 : response.status,
        headers: { "Cache-Control": "no-store" }
      });
    }
    return Response.json(data, {
      status: response.status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error && error.name === "TimeoutError"
        ? "সিদ্ধান্ত পরীক্ষার রিপোর্ট সার্ভার সময়মতো সাড়া দেয়নি।"
        : "সিদ্ধান্ত পরীক্ষার রিপোর্ট সার্ভার থেকে আনা যায়নি।"
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}