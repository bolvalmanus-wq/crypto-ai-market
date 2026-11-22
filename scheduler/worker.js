const PAGE_ORIGIN = "https://crypto-ai-market.pages.dev";
const SYMBOLS = ["BTC", "SOL"];
const TIMEFRAMES = ["30m", "1h"];

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const price of values.slice(period)) value = price * k + value * (1 - k);
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": PAGE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }});
}
async function fetchMarket(symbol) {
  const response = await fetch(`${PAGE_ORIGIN}/api/market?symbol=${symbol}`, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error(`Market API ${symbol}: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.candles) throw new Error(`No candle data for ${symbol}`);
  return data;
}
async function askGemini(env, symbol, timeframe, market, now) {
  if (!env.GEMINI_API_KEY) throw new Error("Worker secret GEMINI_API_KEY is missing");
  const interval = timeframe === "30m" ? 30 * 60 * 1000 : 60 * 60 * 1000;
  const bars = (market.candles[timeframe] || []).filter(c => c.confirmed && Number(c.close) > 0);
  if (bars.length < 30) throw new Error(`Not enough confirmed ${timeframe} candles for ${symbol}`);
  const closes = bars.map(c => Number(c.close));
  const last = closes[closes.length - 1];
  const indicators = {
    lastClose: last,
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    rsi14: rsi(closes, 14),
    candleCloseTime: new Date(Number(bars[bars.length - 1].time) + interval).toISOString(),
    marketSource: market.source || "Unknown public perpetual market"
  };
  const prompt = `তুমি একটি সতর্ক ক্রিপ্টো perpetual futures বিশ্লেষক। ${symbol}/USDT-এর ${timeframe} চার্টে শুধুমাত্র নিচের নিশ্চিত বন্ধ হওয়া ক্যান্ডেল ও সূচক বিশ্লেষণ করো।
নীতি: তথ্য বানাবে না; EMA9/EMA21, RSI14, ক্যান্ডেলের গতি ও উচ্চ-নিম্নের গঠন মিলিয়ে দেখবে; সূচক দ্বিমত করলে WAIT; RSI একা LONG/SHORT নির্ধারণ করে না; win-rate বা লাভের নিশ্চয়তা দেবে না; Entry/SL/TP বানাবে না। সহজ বাংলায় সর্বোচ্চ দুই বাক্যে কারণ ও ঝুঁকি দাও।
ডেটা: ${JSON.stringify({symbol,timeframe,source:market.source,ticker:market.ticker,indicators,candles:bars.slice(-48)})}
শুধু JSON দাও: {"decision":"LONG|SHORT|WAIT","direction":"UPWARD|DOWNWARD|SIDEWAYS","reason":"বাংলায় কারণ","risk":"বাংলায় ঝুঁকি","dataQuality":"GOOD|LIMITED"}.`;
  const models = [env.GEMINI_MODEL || "gemini-3.8-flash", env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite"];
  let lastError = "Gemini unavailable";
  for (const model of [...new Set(models)]) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.15, maxOutputTokens: 450, responseMimeType: "application/json" } }),
        signal: AbortSignal.timeout(20000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { lastError = payload?.error?.message || `Gemini HTTP ${response.status}`; if ([401,403].includes(response.status)) break; continue; }
      const raw = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
      const analysis = JSON.parse(raw || "{}");
      if (!["LONG","SHORT","WAIT"].includes(analysis.decision) || !["UPWARD","DOWNWARD","SIDEWAYS"].includes(analysis.direction) || typeof analysis.reason !== "string" || typeof analysis.risk !== "string" || !["GOOD","LIMITED"].includes(analysis.dataQuality)) throw new Error("Gemini response validation failed");
      return { symbol, timeframe, provider: "Google Gemini", model, analysis, indicators, marketSource: market.source || "Unknown", candleCloseTime: indicators.candleCloseTime, generatedAt: new Date(now).toISOString(), scheduled: true };
    } catch (error) { lastError = error instanceof Error ? error.message : "Gemini request failed"; }
  }
  throw new Error(lastError);
}
async function runAnalysis(env, scheduledTime) {
  const now = Number(scheduledTime) || Date.now();
  const results = [];
  for (const symbol of SYMBOLS) {
    let market;
    try { market = await fetchMarket(symbol); }
    catch (error) { results.push({ symbol, error: String(error), at: new Date(now).toISOString() }); continue; }
    for (const timeframe of TIMEFRAMES) {
      const interval = timeframe === "30m" ? 1800000 : 3600000;
      const closeSlot = Math.floor(now / interval) * interval;
      const key = `latest:${symbol}:${timeframe}`;
      const previous = await env.ANALYSIS_RESULTS.get(key, "json");
      if (previous?.candleCloseTime && new Date(previous.candleCloseTime).getTime() >= closeSlot) continue;
      try {
        const result = await askGemini(env, symbol, timeframe, market, now);
        await env.ANALYSIS_RESULTS.put(key, JSON.stringify(result));
        const historyKey = `history:${symbol}:${timeframe}:${closeSlot}`;
        await env.ANALYSIS_RESULTS.put(historyKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
        results.push({ symbol, timeframe, decision: result.analysis.decision, saved: true });
      } catch (error) {
        results.push({ symbol, timeframe, error: error instanceof Error ? error.message : "Analysis failed" });
      }
    }
  }
  await env.ANALYSIS_RESULTS.put("scheduler:last-run", JSON.stringify({ at: new Date(now).toISOString(), results }));
  return results;
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAnalysis(env, event.scheduledTime));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: {
      "Access-Control-Allow-Origin": PAGE_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }});
    if (url.pathname === "/health") return json({ ok: true, service: "crypto-ai-scheduler", schedule: "*/30 * * * *" });
    if (url.pathname === "/latest") {
      const symbol = url.searchParams.get("symbol");
      const timeframe = url.searchParams.get("timeframe");
      if (symbol && !SYMBOLS.includes(symbol)) return json({ error: "Invalid symbol" }, 400);
      if (timeframe && !TIMEFRAMES.includes(timeframe)) return json({ error: "Invalid timeframe" }, 400);
      const items = [];
      for (const s of symbol ? [symbol] : SYMBOLS) for (const tf of timeframe ? [timeframe] : TIMEFRAMES) {
        const result = await env.ANALYSIS_RESULTS.get(`latest:${s}:${tf}`, "json");
        if (result) items.push(result);
      }
      const lastRun = await env.ANALYSIS_RESULTS.get("scheduler:last-run", "json");
      return json({ items, lastRun });
    }
    if (url.pathname === "/history") {
      const symbol = url.searchParams.get("symbol");
      const timeframe = url.searchParams.get("timeframe");
      if (!SYMBOLS.includes(symbol) || !TIMEFRAMES.includes(timeframe)) return json({ error: "symbol/timeframe required" }, 400);
      const listed = await env.ANALYSIS_RESULTS.list({ prefix: `history:${symbol}:${timeframe}:`, limit: 100 });
      const items = [];
      for (const key of listed.keys) {
        const item = await env.ANALYSIS_RESULTS.get(key.name, "json");
        if (item) items.push(item);
      }
      items.sort((a,b) => new Date(b.generatedAt) - new Date(a.generatedAt));
      return json({ items });
    }
    return json({ error: "Not found" }, 404);
  }
};
