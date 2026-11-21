export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const instruments = {
    BTC: "BTC-USDT-SWAP",
    SOL: "SOL-USDT-SWAP",
  };

  if (!symbol || !instruments[symbol]) {
    return Response.json({ error: "Unsupported symbol" }, { status: 400 });
  }

  const instId = instruments[symbol];
  const base = "https://www.okx.com/api/v5/market";
  const paths = [
    `ticker?instId=${instId}`,
    `candles?instId=${instId}&bar=30m&limit=100`,
    `candles?instId=${instId}&bar=1H&limit=100`,
  ];

  try {
    const responses = await Promise.all(
      paths.map((path) =>
        fetch(`${base}/${path}`, {
          headers: { Accept: "application/json" },
          cf: { cacheTtl: 0, cacheEverything: false },
        })
      )
    );

    if (responses.some((response) => !response.ok)) {
      return Response.json(
        { error: "Market data provider returned an HTTP error", source: "OKX" },
        { status: 502 }
      );
    }

    const payloads = await Promise.all(responses.map((response) => response.json()));
    if (payloads.some((payload) => payload.code !== "0" || !Array.isArray(payload.data))) {
      return Response.json(
        { error: "Market data provider returned invalid data", source: "OKX" },
        { status: 502 }
      );
    }

    const ticker = payloads[0].data[0];
    const candles30m = payloads[1].data;
    const candles1h = payloads[2].data;

    if (!ticker || candles30m.length < 30 || candles1h.length < 30) {
      return Response.json(
        { error: "Not enough market history for analysis", source: "OKX" },
        { status: 503 }
      );
    }

    const timestamp = Number(ticker.ts);
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp / 1000));

    return Response.json(
      {
        symbol,
        instrument: instId,
        source: "OKX USDT perpetual market",
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
          "30m": candles30m.map((c) => ({
            time: Number(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
            confirmed: c[8] === "1",
          })).reverse(),
          "1h": candles1h.map((c) => ({
            time: Number(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
            confirmed: c[8] === "1",
          })).reverse(),
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  } catch (error) {
    return Response.json(
      { error: "Could not connect to the external market data provider", source: "OKX" },
      { status: 502 }
    );
  }
}
