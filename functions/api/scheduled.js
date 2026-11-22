export async function onRequest({ request, env }) {
  if (!env.SCHEDULER_URL) {
    return Response.json({ error: "Cloud scheduler এখনো সংযুক্ত হয়নি। Pages secret SCHEDULER_URL সেট করতে হবে।" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const incoming = new URL(request.url);
  if (request.method === "POST") {
    const target = new URL("/analyze", env.SCHEDULER_URL);
    try {
      const body = await request.json();
      const response = await fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
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
  const target = new URL("/latest", env.SCHEDULER_URL);
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
