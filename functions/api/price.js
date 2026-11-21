export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const instruments = { BTC: "BTCUSDT", SOL: "SOLUSDT" };
  if (!symbol || !instruments[symbol]) return Response.json({ error: "Unsupported symbol" }, { status: 400 });
  const headers = { "Accept": "application/json" };
  try {
    const r = await fetch("https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + instruments[symbol], { headers, signal: AbortSignal.timeout(3500) });
    if (r.ok) {
      const j = await r.json();
      const t = j.result?.list?.[0];
      if (j.retCode === 0 && t && Number(t.lastPrice) > 0) {
        return Response.json({ symbol, source: "Bybit", last: Number(t.lastPrice), open24h: Number(t.prevPrice24h), timestamp: Date.now() }, { headers: { "Cache-Control": "no-store" } });
      }
    }
  } catch (e) {}
  try {
    const instId = symbol + "-USDT-SWAP";
    const r = await fetch("https://www.okx.com/api/v5/market/ticker?instId=" + instId, { headers, signal: AbortSignal.timeout(3500) });
    const j = await r.json();
    const t = j.data?.[0];
    if (j.code === "0" && t && Number(t.last) > 0) {
      return Response.json({ symbol, source: "OKX", last: Number(t.last), open24h: Number(t.open24h), timestamp: Number(t.ts) }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (e) {}
  return Response.json({ error: "Live price unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
