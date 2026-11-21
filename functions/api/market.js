export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const instruments = { BTC: "BTC-USDT-SWAP", SOL: "SOL-USDT-SWAP" };

  if (!symbol || !instruments[symbol]) {
    return Response.json({ error: "Unsupported symbol" }, { status: 400 });
  }

  const instId = instruments[symbol];
  // OKX documents separate regional API domains. Try the standard and
  // regional REST hosts because the correct host can depend on account region.
  const hosts = ["https://www.okx.com", "https://openapi.okx.com", "https://eea.okx.com"];
  const paths = [
    `/api/v5/market/ticker?instId=${instId}`,
    `/api/v5/market/candles?instId=${instId}&bar=30m&limit=100`,
    `/api/v5/market/candles?instId=${instId}&bar=1H&limit=100`,
  ];

  const requestJson = async (host, path) => {
    const response = await fetch(host + path, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) {
      throw new Error(`${new URL(host).hostname} ${path.split("?")[0]} HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.code !== "0" || !Array.isArray(payload.data)) {
      throw new Error(`${new URL(host).hostname} API code ${payload.code || "unknown"}: ${payload.msg || "invalid response"}`);
    }
    return payload;
  };

  let lastError = "No OKX API host responded";
  for (const host of hosts) {
    try {
      // Retry once on transient network/server errors before trying another host.
      let payloads;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          payloads = await Promise.all(paths.map(path => requestJson(host, path)));
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : "Unknown provider error";
          if (attempt === 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const ticker = payloads[0].data[0];
      const candles30m = payloads[1].data;
      const candles1h = payloads[2].data;
      if (!ticker || candles30m.length < 30 || candles1h.length < 30) {
        lastError = `${new URL(host).hostname}: insufficient candle history (30m=${candles30m.length}, 1h=${candles1h.length})`;
        continue;
      }

      const timestamp = Number(ticker.ts);
      const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp / 1000));
      return Response.json({
        symbol,
        instrument: instId,
        source: `OKX USDT perpetual market (${new URL(host).hostname})`,
        fetchedAt: new Date().toISOString(),
        marketTimestamp: new Date(timestamp).toISOString(),
        ageSeconds,
        ticker: {
          last: Number(ticker.last),
          open24h: Number(ticker.open24h),
          bid: Number(ticker.bidPx),
          ask: Number(ticker.askPx),
          volume24h: Number(ticker.volCcy24h),
        },
        candles: {
          "30m": candles30m.map(c => ({
            time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
            low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
            confirmed: c[8] === "1",
          })).reverse(),
          "1h": candles1h.map(c => ({
            time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
            low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
            confirmed: c[8] === "1",
          })).reverse(),
        },
      }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown provider error";
    }
  }

  return Response.json({
    error: "All OKX regional market-data endpoints failed",
    source: "OKX",
    details: lastError,
  }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
