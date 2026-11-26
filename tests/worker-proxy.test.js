import test from "node:test";
import assert from "node:assert/strict";
import { fetchMarketWorker, readWorkerJson, proxyJson } from "../functions/_shared/worker-proxy.js";

test("uses the Pages Service Binding without public DNS", async () => {
  let received;
  const binding = { fetch: async request => {
    received = request;
    return Response.json({ ok: true });
  }};
  const response = await fetchMarketWorker({ MARKET_WORKER: binding }, "/health?check=1", {
    headers: { Accept: "application/json" }
  });
  assert.equal(response.status, 200);
  assert.equal(new URL(received.url).hostname, "market-worker.internal");
  assert.equal(new URL(received.url).pathname, "/health");
  assert.equal(new URL(received.url).searchParams.get("check"), "1");
});


test("detects a Service Binding configured under a custom variable name", async () => {
  let called = false;
  const response = await fetchMarketWorker({
    WORKER: { fetch: async request => {
      called = true;
      assert.equal(new URL(request.url).pathname, "/health");
      return Response.json({ ok: true });
    }},
    ASSETS: { fetch: async () => { throw new Error("must not use ASSETS"); } }
  }, "/health");
  assert.equal(response.status, 200);
  assert.equal(called, true);
});

test("uses configured public URL only when no Service Binding exists", async () => {
  const originalFetch = globalThis.fetch;
  let target;
  globalThis.fetch = async url => {
    target = String(url);
    return Response.json({ ok: true });
  };
  try {
    const response = await fetchMarketWorker({
      MARKET_WORKER_URL: "https://worker.example.workers.dev"
    }, "/performance?symbol=BTC");
    assert.equal(response.status, 200);
    assert.equal(target, "https://worker.example.workers.dev/performance?symbol=BTC");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-JSON Worker responses with an actionable status", async () => {
  await assert.rejects(
    readWorkerJson(new Response("origin unavailable", { status: 530 }), "Worker health endpoint"),
    error => error.status === 530 && error.message.includes("non-JSON")
  );
});

test("proxyJson always disables caching and preserves status", async () => {
  const response = proxyJson({ ok: false }, 502);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: false });
});
