export async function onRequest({ request, env }) {
  if (!env.SCHEDULER_URL) {
    return Response.json({ error: "Push scheduler is not configured" }, { status: 503 });
  }
  const incoming = new URL(request.url);
  const action = incoming.searchParams.get("action");
  if (!["health", "public-key", "subscribe", "unsubscribe", "test"].includes(action)) {
    return Response.json({ error: "Unsupported push action" }, { status: 400 });
  }
  if ((action === "public-key" || action === "health") && request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (action !== "public-key" && action !== "health" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const target = new URL("/push/" + action, env.SCHEDULER_URL);
    const init = { method: request.method, headers: { Accept: "application/json" } };
    if (request.method === "POST") {
      init.headers["Content-Type"] = "application/json";
      init.body = await request.text();
    }
    const response = await fetch(target.toString(), init);
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch (error) {
    return Response.json({ error: "Push সার্ভারের সঙ্গে সংযোগ করা যায়নি" }, { status: 502 });
  }
}
