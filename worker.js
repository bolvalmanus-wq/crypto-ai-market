const PAGE_URL = "https://crypto-ai-market.pages.dev";
const INTERVALS = { "30m": 30 * 60 * 1000, "1h": 60 * 60 * 1000 };

function ema(values, period) {
  const k = 2 / (period + 1); let value = values[0];
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d;
  }
  if (!gains && !losses) return 50; if (!losses) return 100; if (!gains) return 0;
  return 100 - 100 / (1 + gains / losses);
}
function analyze(data, tf) {
  const interval = INTERVALS[tf];
  const bars = (data.candles?.[tf] || []).filter(c => c.confirmed && [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.close > 0);
  if (bars.length < 30) throw new Error("Not enough confirmed candles for " + tf);
  const last = bars[bars.length - 1];
  const closeTime = last.time + interval;
  if (Date.now() < closeTime) throw new Error("Latest candle is not closed yet");
  const price = Number(data.ticker.last);
  const closes = [...bars.map(c => c.close).slice(0, -1), price];
  const e9 = ema(closes.slice(-40), 9), e21 = ema(closes.slice(-60), 21), rv = rsi(closes);
  const ranges = bars.slice(-15).map((c, i) => {
    const p = bars[bars.length - 16 + i];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  const atr = ranges.reduce((a,b) => a+b, 0) / ranges.length;
  const clamp = (x, lo=-1, hi=1) => Math.max(lo, Math.min(hi, x));
  const trend = clamp((e9 / e21 - 1) * 120);
  const priceTrend = clamp((price / e9 - 1) * 80);
  const momentum = clamp((price / last.close - 1) * 250);
  const rsiBias = clamp((rv - 50) / 22);
  const score = clamp(.34*trend + .28*priceTrend + .23*momentum + .15*rsiBias);
  let signal = "WAIT", reason = "ট্রেন্ড, লাইভ মোমেন্টাম ও সূচকগুলো এখনো একমত নয়";
  if (rv >= 75) reason = "RSI বেশি; দামের পেছনে ছুটে LONG নেওয়া ঝুঁকিপূর্ণ";
  else if (rv <= 25) reason = "RSI কম; পতনের পর SHORT নেওয়া ঝুঁকিপূর্ণ";
  else if (score >= .48 && rv >= 50 && rv < 75) { signal = "LONG"; reason = "EMA ট্রেন্ড, মোমেন্টাম ও RSI LONG-এর পক্ষে"; }
  else if (score <= -.48 && rv > 25 && rv <= 50) { signal = "SHORT"; reason = "EMA ট্রেন্ড, মোমেন্টাম ও RSI SHORT-এর পক্ষে"; }
  return {
    source: data.source, ticker: data.ticker,
    indicators: { rsi: rv, ema9: e9, ema21: e21, atr, technicalScore: score, technicalSignal: signal },
    candles: bars.slice(-48),
    higherTimeframe: null,
    derivatives: data.derivatives ? {
      openInterest: tf === "30m" ? data.derivatives.openInterest30m : data.derivatives.openInterest1h,
      longShort: tf === "30m" ? data.derivatives.longShort30m : data.derivatives.longShort1h,
      orderbook: data.derivatives.orderbook,
      fundingHistory: data.derivatives.fundingHistory
    } : null,
    candleCloseTime: new Date(closeTime).toISOString()
  };
}
async function runOne(env, symbol, tf) {
  const marketResponse = await fetch(PAGE_URL + "/api/market?symbol=" + symbol, { headers: { "Cache-Control": "no-cache" } });
  if (!marketResponse.ok) throw new Error("Market API HTTP " + marketResponse.status);
  const data = await marketResponse.json();
  if (!data.candles || !data.ticker) throw new Error("Market API returned incomplete data");
  const market = analyze(data, tf);
  const otherTf = tf === "30m" ? "1h" : "30m";
  try {
    const other = analyze(data, otherTf);
    market.higherTimeframe = {
      timeframe: otherTf, signal: other.indicators.technicalSignal,
      score: other.indicators.technicalScore, rsi: other.indicators.rsi,
      ema9: other.indicators.ema9, ema21: other.indicators.ema21
    };
  } catch (_) {}
  const aiResponse = await fetch(PAGE_URL + "/api/ai", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, timeframe: tf, market })
  });
  const ai = await aiResponse.json().catch(() => ({}));
  if (!aiResponse.ok || !ai.analysis) throw new Error(ai.error || "Gemini API HTTP " + aiResponse.status);
  const result = {
    symbol, timeframe: tf, provider: ai.provider || "Google Gemini",
    model: ai.model || "Gemini", analysis: ai.analysis,
    generatedAt: ai.generatedAt || new Date().toISOString(),
    candleCloseTime: market.candleCloseTime,
    marketSource: data.source
  };
  const key = "latest:" + symbol + ":" + tf;
  await env.ANALYSIS_KV.put(key, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
  await env.ANALYSIS_KV.put("history:" + symbol + ":" + tf + ":" + Date.now(), JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
  return result;
}
export default {
  async scheduled(controller, env, ctx) {
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    const tasks = [];
    for (const symbol of ["BTC", "SOL"]) {
      tasks.push(runOne(env, symbol, "30m"));
      if (minute === 0) tasks.push(runOne(env, symbol, "1h"));
    }
    const outcomes = await Promise.allSettled(tasks);
    const failed = outcomes.filter(x => x.status === "rejected");
    if (failed.length) console.error("Scheduled analysis failures:", failed.map(x => String(x.reason)));
    console.log("Scheduled analysis finished", { scheduledTime: controller.scheduledTime, success: outcomes.length - failed.length, failed: failed.length });
  }
};
