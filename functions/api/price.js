export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const instruments = { BTC: "BTCUSDT", SOL: "SOLUSDT" };
  if (!symbol || !instruments[symbol]) return Response.json({ error: "Unsupported symbol" }, { status: 400 });
  const headers = { Accept: "application/json" };
  const validTicker = t => t && Number.isFinite(Number(t.last)) && Number(t.last) > 0 &&
    Number.isFinite(Number(t.open24h)) && Number(t.open24h) > 0 &&
    Number.isFinite(Number(t.bid)) && Number(t.bid) > 0 &&
    Number.isFinite(Number(t.ask)) && Number(t.ask) >= Number(t.bid);
  try {
    const r = await fetch("https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + instruments[symbol], {
      headers, signal: AbortSignal.timeout(3500)
    });
    if (r.ok) {
      const j = await r.json();
      const t = j.result?.list?.[0];
      const ticker = t && { last:t.lastPrice, open24h:t.prevPrice24h, bid:t.bid1Price, ask:t.ask1Price };
      const timestamp = Number(j.time);
      if (j.retCode === 0 && validTicker(ticker) && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now()+10000 && Date.now()-timestamp <= 60000) {
        return Response.json({ symbol, source:"Bybit", last:Number(ticker.last), open24h:Number(ticker.open24h), bid:Number(ticker.bid), ask:Number(ticker.ask), timestamp }, {
          headers: { "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" }
        });
      }
    }
  } catch (_) {}
  try {
    const instId = symbol + "-USDT-SWAP";
    const r = await fetch("https://www.okx.com/api/v5/market/ticker?instId=" + instId, {
      headers, signal: AbortSignal.timeout(3500)
    });
    if (r.ok) {
      const j = await r.json();
      const t = j.data?.[0];
      const ticker = t && { last:t.last, open24h:t.open24h, bid:t.bidPx, ask:t.askPx };
      const timestamp = Number(t?.ts);
      if (j.code === "0" && validTicker(ticker) && Number.isFinite(timestamp) && timestamp > 0 && Date.now()-timestamp <= 60000) {
        return Response.json({ symbol, source:"OKX", last:Number(ticker.last), open24h:Number(ticker.open24h), bid:Number(ticker.bid), ask:Number(ticker.ask), timestamp }, {
          headers: { "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" }
        });
      }
    }
  } catch (_) {}
  return Response.json({ error:"Live price unavailable" }, { status:502, headers:{ "Cache-Control":"no-store" } });
}
