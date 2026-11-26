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
    `/api/v5/market/candles?instId=${instId}&bar=1m&limit=300`,
    `/api/v5/market/candles?instId=${instId}&bar=5m&limit=300`,
    `/api/v5/market/candles?instId=${instId}&bar=15m&limit=300`,
    `/api/v5/market/candles?instId=${instId}&bar=30m&limit=300`,
    `/api/v5/market/candles?instId=${instId}&bar=1H&limit=300`,
    `/api/v5/market/candles?instId=${instId}&bar=4H&limit=300`,
  ];

  const requestJson = async (host, path) => {
    const response = await fetch(host + path, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4500),
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

  let lastError = "Bybit API not available; trying OKX fallback";
  try {
    const base = "https://api.bybit.com";
    const bybitGet = async (path) => {
      const response = await fetch(base + path, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Bybit HTTP " + response.status);
      const payload = await response.json();
      if (payload.retCode !== 0 || !payload.result) throw new Error("Bybit API: " + (payload.retMsg || "invalid response"));
      return payload.result;
    };
    const symbolCode = symbol + "USDT";
    const [tickerResult, k1, k5, k15, k30, k60, k240, oi30, oi60, ratio30, ratio60, orderbook, funding] = await Promise.all([
      bybitGet("/v5/market/tickers?category=linear&symbol=" + symbolCode),
      bybitGet("/v5/market/kline?category=linear&symbol=" + symbolCode + "&interval=1&limit=1000"),
      bybitGet("/v5/market/kline?category=linear&symbol=" + symbolCode + "&interval=5&limit=1000"),
      bybitGet("/v5/market/kline?category=linear&symbol=" + symbolCode + "&interval=15&limit=1000"),
      bybitGet("/v5/market/kline?category=linear&symbol=" + symbolCode + "&interval=30&limit=1000"),
      bybitGet("/v5/market/kline?category=linear&symbol=" + symbolCode + "&interval=60&limit=1000"),
      bybitGet("/v5/market/kline?category=linear&symbol=" + symbolCode + "&interval=240&limit=1000"),
      bybitGet("/v5/market/open-interest?category=linear&symbol=" + symbolCode + "&intervalTime=30min&limit=2").catch(() => null),
      bybitGet("/v5/market/open-interest?category=linear&symbol=" + symbolCode + "&intervalTime=1h&limit=2").catch(() => null),
      bybitGet("/v5/market/account-ratio?category=linear&symbol=" + symbolCode + "&period=30min&limit=2").catch(() => null),
      bybitGet("/v5/market/account-ratio?category=linear&symbol=" + symbolCode + "&period=1h&limit=2").catch(() => null),
      bybitGet("/v5/market/orderbook?category=linear&symbol=" + symbolCode + "&limit=25").catch(() => null),
      bybitGet("/v5/market/funding/history?category=linear&symbol=" + symbolCode + "&limit=2").catch(() => null)
    ]);
    const ticker = tickerResult.list?.[0];
    if (!ticker || !k1.list?.length || !k5.list?.length || !k15.list?.length || !k30.list?.length || !k60.list?.length || !k240.list?.length) throw new Error("Bybit returned incomplete market data");
    const mapBars = (rows, intervalMs) => rows.map(row => {
      const start = Number(row[0]);
      return { time:start, open:Number(row[1]), high:Number(row[2]), low:Number(row[3]), close:Number(row[4]), volume:Number(row[5]), confirmed:Date.now() >= start + intervalMs };
    }).reverse();
    const timestamp = Date.now();
    const prev = Number(ticker.prevPrice24h);
    return Response.json({
      symbol, instrument:symbolCode, source:"Bybit USDT perpetual",
      fetchedAt:new Date().toISOString(), marketTimestamp:new Date(timestamp).toISOString(), ageSeconds:0,
      ticker:{last:Number(ticker.lastPrice),mark:Number(ticker.markPrice),index:Number(ticker.indexPrice),open24h:prev,bid:Number(ticker.bid1Price),ask:Number(ticker.ask1Price),volume24h:Number(ticker.turnover24h),openInterest:Number(ticker.openInterestValue),fundingRate:Number(ticker.fundingRate),nextFundingTime:Number(ticker.nextFundingTime)},
      derivatives:{
        openInterest30m:oi30?.list?.map(x=>({value:Number(x.openInterest),time:Number(x.timestamp)}))||[],
        openInterest1h:oi60?.list?.map(x=>({value:Number(x.openInterest),time:Number(x.timestamp)}))||[],
        longShort30m:ratio30?.list?.map(x=>({long:Number(x.buyRatio),short:Number(x.sellRatio),time:Number(x.timestamp)}))||[],
        longShort1h:ratio60?.list?.map(x=>({long:Number(x.buyRatio),short:Number(x.sellRatio),time:Number(x.timestamp)}))||[],
        orderbook:orderbook?.b&&orderbook?.a?{bids:orderbook.b.map(x=>[Number(x[0]),Number(x[1])]),asks:orderbook.a.map(x=>[Number(x[0]),Number(x[1])]),time:Number(orderbook.ts)}:null,
        fundingHistory:funding?.list?.map(x=>({rate:Number(x.fundingRate),time:Number(x.fundingRateTimestamp)}))||[]
      },
      candles:{"1m":mapBars(k1.list,60*1000),"5m":mapBars(k5.list,5*60*1000),"15m":mapBars(k15.list,15*60*1000),"30m":mapBars(k30.list,30*60*1000),"1h":mapBars(k60.list,60*60*1000),"4h":mapBars(k240.list,4*60*60*1000)}
    },{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  } catch(error) {
    lastError = error instanceof Error ? error.message : "Bybit API unavailable";
  }
  for (const host of hosts) {
    try {
      // Bound each regional host attempt so a stalled provider cannot leave the app loading indefinitely.
      const payloads = await Promise.all(paths.map(path => requestJson(host, path)));

      const ticker = payloads[0].data[0];
      const candles1m = payloads[1].data;
      const candles5m = payloads[2].data;
      const candles15m = payloads[3].data;
      const candles30m = payloads[4].data;
      const candles1h = payloads[5].data;
      const candles4h = payloads[6].data;
      if (!ticker || candles1m.length < 30 || candles5m.length < 30 || candles15m.length < 30 || candles30m.length < 30 || candles1h.length < 30 || candles4h.length < 30) {
        lastError = `${new URL(host).hostname}: insufficient candle history (5m=${candles5m.length}, 15m=${candles15m.length}, 1h=${candles1h.length})`;
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
          "1m": candles1m.map(c => ({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]),confirmed:c[8]==="1"})).reverse(),
          "5m": candles5m.map(c => ({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]),confirmed:c[8]==="1"})).reverse(),
          "15m": candles15m.map(c => ({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]),confirmed:c[8]==="1"})).reverse(),
          "30m": candles30m.map(c => ({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]),confirmed:c[8]==="1"})).reverse(),
          "1h": candles1h.map(c => ({
            time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
            low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
            confirmed: c[8] === "1",
          })).reverse(),
          "4h": candles4h.map(c => ({
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
