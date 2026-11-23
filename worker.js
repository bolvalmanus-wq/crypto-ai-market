const PAGE_URL = "https://crypto-ai-market.pages.dev";
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64u = value => {
  value = String(value).trim().replace(/^["']|["']$/g,"").replace(/\s+/g,"");
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    value = value.replace(/^0x/i,"");
    return Uint8Array.from(value.match(/.{2}/g), pair => parseInt(pair,16));
  }
  value = value.replace(/-/g,"+").replace(/_/g,"/");
  return Uint8Array.from(atob(value + "===".slice((value.length+3)%4)), ch => ch.charCodeAt(0));
};
function decodeVapidPrivateKey(input) {
  let value = String(input ?? "").trim().replace(/^["']|["']$/g,"").replace(/\s+/g,"");
  if (!value) throw new Error("Secret value is empty");
  if (value.startsWith("{")) {
    const jwk = JSON.parse(value);
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) throw new Error("JSON secret is not a P-256 private JWK");
    value = jwk.d;
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    value = value.replace(/^0x/i,"");
    return Uint8Array.from(value.match(/.{2}/g), pair => parseInt(pair,16));
  }
  const normalized = value.replace(/-/g,"+").replace(/_/g,"/");
  const decoded = Uint8Array.from(atob(normalized + "=".repeat((4-normalized.length%4)%4)), ch => ch.charCodeAt(0));
  if (decoded.length !== 32) throw new Error("Decoded private key must be 32 bytes; got " + decoded.length);
  return decoded;
}
const utf8 = value => new TextEncoder().encode(value);
const concatBytes = (...parts) => {
  const size = parts.reduce((n,p)=>n+p.length,0), out = new Uint8Array(size);
  let offset=0; for(const part of parts){out.set(part,offset);offset+=part.length;} return out;
};
async function hkdf(ikm,salt,info,length) {
  const key=await crypto.subtle.importKey("raw",ikm,"HKDF",false,["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt,info},key,length*8));
}
async function vapidToken(audience,env) {
  if(!env.VAPID_PRIVATE_KEY||!env.VAPID_PUBLIC_KEY) throw new Error("VAPID keys are not configured");
  const publicBytes=unb64u(env.VAPID_PUBLIC_KEY);
  const privateBytes=decodeVapidPrivateKey(env.VAPID_PRIVATE_KEY);
  const x=b64u(publicBytes.slice(1,33)), y=b64u(publicBytes.slice(33,65)), d=b64u(privateBytes);
  const key=await crypto.subtle.importKey("jwk",{kty:"EC",crv:"P-256",x,y,d,ext:true},{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const header=b64u(utf8(JSON.stringify({typ:"JWT",alg:"ES256"})));
  const payload=b64u(utf8(JSON.stringify({aud:audience,exp:Math.floor(Date.now()/1000)+12*60*60,sub:PAGE_URL})));
  const unsigned=header+"."+payload;
  const signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,utf8(unsigned));
  return unsigned+"."+b64u(signature);
}
async function encryptPush(subscription,payload) {
  const uaPublic=unb64u(subscription.keys.p256dh), auth=unb64u(subscription.keys.auth);
  const uaKey=await crypto.subtle.importKey("raw",uaPublic,{name:"ECDH",namedCurve:"P-256"},false,[]);
  const server=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const serverPublic=new Uint8Array(await crypto.subtle.exportKey("raw",server.publicKey));
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH",public:uaKey},server.privateKey,256));
  const ikm=await hkdf(shared,auth,concatBytes(utf8("WebPush: info\0"),uaPublic,serverPublic),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(ikm,salt,utf8("Content-Encoding: aes128gcm\0"),16);
  const nonce=await hkdf(ikm,salt,utf8("Content-Encoding: nonce\0"),12);
  const aes=await crypto.subtle.importKey("raw",cek,{name:"AES-GCM"},false,["encrypt"]);
  const plain=concatBytes(utf8(JSON.stringify(payload)),new Uint8Array([2]));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce},aes,plain));
  const header=new Uint8Array(21); header.set(salt,0);
  new DataView(header.buffer).setUint32(16,4096,false); header[20]=serverPublic.length;
  return concatBytes(header,serverPublic,cipher);
}
async function sendOnePush(env,subscription,payload) {
  const endpoint=new URL(subscription.endpoint);
  const token=await vapidToken(endpoint.origin,env);
  const body=await encryptPush(subscription,payload);
  return fetch(subscription.endpoint,{
    method:"POST",headers:{
      "Authorization":"vapid t="+token+", k="+env.VAPID_PUBLIC_KEY,
      "Content-Type":"application/octet-stream","Content-Encoding":"aes128gcm",
      "TTL":"300","Urgency":"high"
    },body
  });
}
async function sendSignalPush(env,result) {
  if(!env.ANALYSIS_KV) return;
  if(!env.VAPID_PRIVATE_KEY||!env.VAPID_PUBLIC_KEY) {
    console.log("Signal alert skipped: VAPID keys not configured",{symbol:result.symbol,timeframe:result.timeframe,decision:result.analysis.decision});
    return;
  }
  const decision=result.analysis.decision;
  const stateKey="lastsignal:"+result.symbol+":"+result.timeframe;
  const previous=await env.ANALYSIS_KV.get(stateKey,"json");
  await env.ANALYSIS_KV.put(stateKey,JSON.stringify({decision,candleCloseTime:result.candleCloseTime}),{expirationTtl:60*60*24*14});
  if(!["LONG","SHORT"].includes(decision)||previous?.decision===decision) return;
  const listed=await env.ANALYSIS_KV.list({prefix:"push:sub:",limit:100});
  const payload={
    title:decision,
    body:result.symbol+" · "+(result.timeframe==="30m"?"৩০ মিনিট":"১ ঘণ্টা"),
    url:"/",
    tag:result.symbol+"-"+result.timeframe+"-"+decision,
    decision,symbol:result.symbol,timeframe:result.timeframe
  };
  await Promise.allSettled(listed.keys.map(async item=>{
    const subscription=await env.ANALYSIS_KV.get(item.name,"json");
    if(!subscription) return;
    try {
      const response=await sendOnePush(env,subscription,payload);
      if(response.status===404||response.status===410) await env.ANALYSIS_KV.delete(item.name);
      else if(!response.ok) console.error("Push delivery failed",response.status);
    } catch(error) { console.error("Push send error",String(error)); }
  }));
}
const INTERVALS = { "30m": 30 * 60 * 1000, "1h": 60 * 60 * 1000 };
const REVIEW_MODEL = "@cf/zai-org/glm-4.7-flash";

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
  if (Date.now() - closeTime > interval * 1.5) throw new Error("Latest confirmed candle is stale");
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
  let rawScore = .38*trend + .32*priceTrend + .22*momentum + .08*rsiBias;
  const derivatives = data.derivatives || {};
  const oi = tf === "30m" ? derivatives.openInterest30m : derivatives.openInterest1h;
  if (Array.isArray(oi) && oi.length >= 2 && Number(oi[0].value) > 0) {
    const delta = Number(oi[oi.length - 1].value) / Number(oi[0].value) - 1;
    rawScore += clamp(delta * 18) * .08;
  }
  const ratios = tf === "30m" ? derivatives.longShort30m : derivatives.longShort1h;
  if (Array.isArray(ratios) && ratios.length) {
    const longRatio = Number(ratios[ratios.length - 1].long);
    if (Number.isFinite(longRatio)) rawScore += clamp((longRatio - .5) * 2) * .06;
  }
  const book = derivatives.orderbook;
  if (book?.bids?.length && book?.asks?.length) {
    const bid = book.bids.reduce((n,x)=>n+Number(x[0])*Number(x[1]),0);
    const ask = book.asks.reduce((n,x)=>n+Number(x[0])*Number(x[1]),0);
    if (bid + ask > 0) rawScore += clamp(((bid - ask) / (bid + ask)) * 2) * .07;
  }
  // Additional independent confirmation indicators: MACD, ADX, Bollinger position and relative volume.
  const recentCloses = closes.slice(-60);
  const macdSeries = recentCloses.map((_, index) => {
    const sample = recentCloses.slice(0, index + 1).slice(-26);
    return ema(sample, 12) - ema(sample, 26);
  });
  const macdLine = macdSeries[macdSeries.length - 1];
  const macdSignal = ema(macdSeries.slice(-9), 9);
  const macdHistogram = macdLine - macdSignal;
  const macdBias = clamp((macdHistogram / Math.max(atr, price * 0.0001)) * 12);
  const bbWindow = closes.slice(-20);
  const bbMean = bbWindow.reduce((sum, value) => sum + value, 0) / bbWindow.length;
  const bbStd = Math.sqrt(bbWindow.reduce((sum, value) => sum + (value - bbMean) ** 2, 0) / bbWindow.length);
  const bbUpper = bbMean + 2 * bbStd, bbLower = bbMean - 2 * bbStd;
  const bbPosition = bbUpper > bbLower ? clamp(((price - bbMean) / (2 * bbStd || 1)) * 0.5) : 0;
  const volumeWindow = bars.slice(-21, -1).map(c => Number(c.volume)).filter(Number.isFinite);
  const avgVolume = volumeWindow.length ? volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length : 0;
  const currentVolume = Number(last.volume);
  const relativeVolume = avgVolume > 0 && Number.isFinite(currentVolume) ? currentVolume / avgVolume : null;
  const volumeBias = relativeVolume === null ? 0 : clamp((relativeVolume - 1) * 0.35) * Math.sign(price - last.open);
  const adxPeriod = 14;
  let trSmoothed = 0, plusSmoothed = 0, minusSmoothed = 0;
  const dxValues = [];
  for (let i = 1; i <= adxPeriod; i++) {
    const cur = bars[i], prev = bars[i - 1];
    const up = cur.high - prev.high, down = prev.low - cur.low;
    if (up > down && up > 0) plusSmoothed += up;
    if (down > up && down > 0) minusSmoothed += down;
    trSmoothed += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  for (let i = adxPeriod + 1; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    const up = cur.high - prev.high, down = prev.low - cur.low;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trSmoothed = trSmoothed - trSmoothed / adxPeriod + tr;
    plusSmoothed = plusSmoothed - plusSmoothed / adxPeriod + plus;
    minusSmoothed = minusSmoothed - minusSmoothed / adxPeriod + minus;
    const plusNow = trSmoothed > 0 ? plusSmoothed / trSmoothed * 100 : 0;
    const minusNow = trSmoothed > 0 ? minusSmoothed / trSmoothed * 100 : 0;
    const diSum = plusNow + minusNow;
    if (diSum > 0) dxValues.push(Math.abs(plusNow - minusNow) / diSum * 100);
  }
  const plusDI = trSmoothed > 0 ? plusSmoothed / trSmoothed * 100 : 0;
  const minusDI = trSmoothed > 0 ? minusSmoothed / trSmoothed * 100 : 0;
  let adx = dxValues.length >= adxPeriod ? dxValues.slice(0, adxPeriod).reduce((sum,value)=>sum+value,0) / adxPeriod : 0;
  for (let i = adxPeriod; i < dxValues.length; i++) adx = (adx * (adxPeriod - 1) + dxValues[i]) / adxPeriod;
  const adxBias = adx >= 18 ? Math.sign(plusDI - minusDI) * clamp((adx - 18) / 25) : 0;
  rawScore = clamp(rawScore * 0.68 + macdBias * 0.14 + bbPosition * 0.08 + adxBias * 0.07 + volumeBias * 0.03);
  const score = clamp(rawScore);
  let signal = "WAIT", reason = "ট্রেন্ড, MACD, ADX, ভলিউম ও অন্যান্য সূচক এখনো একমত নয়";
  // RSI extremes are risk warnings, not automatic bans on a valid trend signal.
  if (score >= .48 && rv < 90) { signal = "LONG"; reason = rv >= 78 ? "ট্রেন্ড LONG-এর পক্ষে, তবে RSI বেশি হওয়ায় ঝুঁকি উঁচু" : "EMA ট্রেন্ড ও মোমেন্টাম LONG-এর পক্ষে"; }
  else if (score <= -.48 && rv > 10) { signal = "SHORT"; reason = rv <= 22 ? "ট্রেন্ড SHORT-এর পক্ষে, তবে RSI কম হওয়ায় ঝুঁকি উঁচু" : "EMA ট্রেন্ড ও মোমেন্টাম SHORT-এর পক্ষে"; }
  else if (rv >= 78) reason = "RSI বেশি; নতুন LONG নেওয়ার আগে নিশ্চিতকরণ দরকার";
  else if (rv <= 22) reason = "RSI কম; নতুন SHORT নেওয়ার আগে নিশ্চিতকরণ দরকার";
  return {
    source: data.source, ticker: data.ticker,
    indicators: { rsi: rv, ema9: e9, ema21: e21, atr, macdLine, macdSignal, macdHistogram, adx, plusDI, minusDI, bbUpper, bbMiddle: bbMean, bbLower, bbPosition, relativeVolume, technicalScore: score, technicalSignal: signal },
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


function buildFourHourContext(data) {
  const source = (data.candles?.["1h"] || []).filter(c => c.confirmed && [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.close > 0).sort((a,b) => a.time - b.time);
  const buckets = new Map();
  for (const candle of source) {
    const bucket = Math.floor(candle.time / 14400000) * 14400000;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(candle);
  }
  const bars = [...buckets.entries()].sort((a,b) => a[0] - b[0]).flatMap(([time, rows]) => {
    rows.sort((a,b) => a.time - b.time);
    if (rows.length !== 4 || rows.some((c,i) => i > 0 && c.time - rows[i-1].time !== 3600000)) return [];
    return [{ time, open: rows[0].open, high: Math.max(...rows.map(c=>c.high)), low: Math.min(...rows.map(c=>c.low)), close: rows[3].close, volume: rows.reduce((sum,c)=>sum + (Number(c.volume)||0),0) }];
  });
  if (bars.length < 50) return { timeframe: "4h", signal: "WAIT", available: false, warning: "৪ ঘণ্টার পর্যাপ্ত সম্পূর্ণ ক্যান্ডেল নেই" };
  const closes = bars.map(c=>c.close), last = bars[bars.length-1];
  const ema20 = ema(closes.slice(-80),20), ema50 = ema(closes.slice(-100),50), strength = rsi(closes,14);
  const prior = bars.slice(-21,-1), support = Math.min(...prior.map(c=>c.low)), resistance = Math.max(...prior.map(c=>c.high));
  const supportBreakdown = last.close < support * 0.998, resistanceBreakout = last.close > resistance * 1.002;
  const bearish = ema20 < ema50 && last.close < ema20 && strength < 50;
  const bullish = ema20 > ema50 && last.close > ema20 && strength > 50;
  const warnings = [];
  if (ema20 < ema50) warnings.push("৪ ঘণ্টায় EMA20, EMA50-এর নিচে: বড় প্রবণতা দুর্বল");
  if (last.close < ema20 && strength < 45) warnings.push("৪ ঘণ্টায় দাম EMA20-এর নিচে এবং RSI দুর্বল");
  if (supportBreakdown) warnings.push("সাম্প্রতিক ৪ ঘণ্টার সাপোর্ট ভেঙেছে");
  if (ema20 > ema50 && last.close > ema20 && strength > 55) warnings.push("৪ ঘণ্টায় ঊর্ধ্বমুখী প্রবণতার সমর্থন আছে");
  if (resistanceBreakout) warnings.push("সাম্প্রতিক ৪ ঘণ্টার রেজিস্ট্যান্স অতিক্রম করেছে");
  return { timeframe: "4h", available: true, signal: bearish || supportBreakdown ? "SHORT" : bullish || resistanceBreakout ? "LONG" : "WAIT", ema20, ema50, rsi: strength, close: last.close, support, resistance, supportBreakdown, resistanceBreakout, bearishWarning: ema20 < ema50 || (last.close < ema20 && strength < 45), bullishWarning: ema20 > ema50 || (last.close > ema20 && strength > 55), warnings, candleTime: new Date(last.time + 14400000).toISOString() };
}

function parseModelJson(output) {
  let raw = output && output.response;
  if (raw == null && output && output.choices && output.choices[0] && output.choices[0].message) raw = output.choices[0].message.content;
  if (raw == null && output && output.result) raw = output.result.response;
  if (Array.isArray(raw)) raw = raw.map(part => typeof part === "string" ? part : part && part.text || "").join("");
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.decision) return validateReviewerAnswer(raw);
    raw = raw.text || raw.content || "";
  }
  if (typeof raw !== "string") throw new Error("Cloudflare AI returned an unsupported response");
  const cleaned = raw
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<\|(?:im_start|im_end|fim_prefix|fim_middle|fim_suffix|ghissue|ghreview)\|>/g, "")
    .replace(/^\s*\x60\x60\x60(?:json)?\s*/i, "")
    .replace(/\s*\x60\x60\x60\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("Cloudflare AI returned no JSON object");
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("Cloudflare AI returned incomplete JSON");
  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
  catch (_) { throw new Error("Cloudflare AI returned malformed JSON"); }
  return validateReviewerAnswer(parsed);
}

function validateReviewerAnswer(parsed) {
  const decision = String(parsed && parsed.decision || "").trim().toUpperCase();
  const reason = typeof (parsed && parsed.reason) === "string" ? parsed.reason.trim() : "";
  const risk = typeof (parsed && parsed.risk) === "string" ? parsed.risk.trim() : "";
  if (!["LONG","SHORT","WAIT"].includes(decision) || !reason || !risk) {
    throw new Error("Cloudflare AI answer failed validation");
  }
  return { decision, reason: reason.slice(0, 500), risk: risk.slice(0, 500) };
}

async function reviewWithCloudflare(env, symbol, tf, market, gemini, performanceFeedback = null) {
  if (!env.AI || typeof env.AI.run !== "function") throw new Error("Workers AI binding AI is not configured");
  const compactMarket = {
    source: market.source,
    ticker: {
      last: market.ticker?.last,
      mark: market.ticker?.mark,
      index: market.ticker?.index,
      bid: market.ticker?.bid,
      ask: market.ticker?.ask,
      volume24h: market.ticker?.volume24h,
      openInterest: market.ticker?.openInterest,
      fundingRate: market.ticker?.fundingRate
    },
    indicators: market.indicators,
    performanceFeedback,
    higherTimeframe: market.higherTimeframe,
    riskEngine: market.riskEngine,
    derivatives: market.derivatives ? {
      longShort: market.derivatives.longShort,
      openInterest: market.derivatives.openInterest,
      orderbook: market.derivatives.orderbook,
      fundingHistory: market.derivatives.fundingHistory
    } : null,
    recentCandles: (market.candles || []).slice(-12).map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
    }))
  };
  const messages = [
    { role: "system", content: "তুমি স্বাধীন ও কঠোর ঝুঁকি-পর্যালোচক ক্রিপ্টো পারপেচুয়াল বিশ্লেষক। প্রথম AI-এর সিদ্ধান্তকে অন্ধভাবে সমর্থন করবে না। প্রদত্ত ডেটা দিয়ে তার যুক্তির দুর্বলতা খুঁজবে, বিপরীত দিকের সম্ভাবনাও পরীক্ষা করবে। ডেটায় নেই এমন তথ্য বানাবে না। প্রথম AI-এর মতামত ছাড়াও RSI, EMA9/EMA21, ATR, MACD histogram, ADX ও DI+/DI-, Bollinger অবস্থান, relative volume, technicalScore, technicalSignal, উচ্চতর সময়সীমা, ৪ ঘণ্টার EMA20/EMA50, ৪ ঘণ্টার RSI, supportBreakdown, resistanceBreakout, riskEngine-এর bearishWarning/bullishWarning ও warnings, open interest, long/short ratio, order book ও funding data একসঙ্গে যাচাই করবে। কোনো একটি সূচককে একা চূড়ান্ত সিদ্ধান্তের ভিত্তি করবে না। অস্পষ্টতা, মতবিরোধ বা দুর্বল ডেটা হলে WAIT বেছে নেবে। কোনো ব্যাখ্যা বা Markdown নয়, কেবল সম্পূর্ণ বৈধ JSON দেবে: {\"decision\":\"LONG|SHORT|WAIT\",\"reason\":\"সংক্ষিপ্ত বাংলা যুক্তি\",\"risk\":\"সংক্ষিপ্ত বাংলা ঝুঁকি\"}. জয়ের সম্ভাবনার শতাংশ দেবে না।" },
    { role: "user", content: JSON.stringify({
      task: "প্রথম AI-এর সঙ্গে যুক্তি-পরীক্ষা করো এবং সম্ভাব্য বিপরীত দিকের যুক্তি খুঁজে দেখো। ছোট টাইমফ্রেমের bounce-কে trend reversal ধরে নিও না। ৪ ঘণ্টার trend, support breakdown, momentum deterioration ও volume confirmation যাচাই করো। প্রয়োজন হলে প্রথম AI-এর সিদ্ধান্ত প্রত্যাখ্যান করো। অতীতের যাচাইকৃত ফল দেখবে, কিন্তু ছোট নমুনা থেকে নিয়ম বানাবে না।",
      symbol, timeframe: tf, market: compactMarket,
      firstAI: { decision: gemini.decision, direction: gemini.direction, reason: gemini.reason, risk: gemini.risk, dataQuality: gemini.dataQuality }
    }) }
  ];
  const output = await env.AI.run(REVIEW_MODEL, {
    messages,
    max_completion_tokens: 420,
    temperature: 0
  });
  return parseModelJson(output);
}

function finalDecision(market, gemini, reviewer) {
  const technical = market.indicators.technicalSignal;
  const a = gemini.decision, b = reviewer.decision;
  const higherSignals = [market.higherTimeframe?.signal, market.higherTimeframe?.fourHour?.signal].filter(signal => signal === "LONG" || signal === "SHORT");
  const sameAI = a === b && (a === "LONG" || a === "SHORT");
  const sameTechnical = technical === a;
  const higherConflicts = higherSignals.some(signal => signal !== a);
  const higherContextMissing = market.riskEngine?.available !== true;
  const criticalRiskConflict = (a === "LONG" && (market.riskEngine?.supportBreakdown === true || market.riskEngine?.bearishWarning === true)) || (a === "SHORT" && market.riskEngine?.bullishWarning === true);
  if (sameAI && sameTechnical && !higherConflicts && !criticalRiskConflict && !higherContextMissing && gemini.dataQuality === "GOOD") {
    return {
      decision: a,
      direction: a === "LONG" ? "UPWARD" : "DOWNWARD",
      reason: "দুই AI একমত এবং টেকনিক্যাল ইন্ডিকেটরও " + a + " সমর্থন করছে। " + gemini.reason,
      risk: reviewer.risk || gemini.risk,
      dataQuality: gemini.dataQuality
    };
  }
  const why = higherContextMissing
    ? "৪ ঘণ্টার বড় প্রবণতা যাচাইয়ের পর্যাপ্ত ডেটা নেই; নিরাপদে WAIT"
    : criticalRiskConflict
    ? "৪ ঘণ্টার ট্রেন্ড/সাপোর্ট প্রস্তাবিত দিকের বিপরীত; ঝুঁকি বেশি"
    : higherConflicts
    ? "১ ঘণ্টা/৪ ঘণ্টার বড় প্রবণতা প্রস্তাবিত সিদ্ধান্তের বিপরীত"
    : !sameAI ? "দুই AI-এর সিদ্ধান্ত এক নয়"
    : !sameTechnical ? "ইন্ডিকেটর AI-দের সিদ্ধান্ত নিশ্চিত করছে না"
    : "ডেটার মান যথেষ্ট নিশ্চিত নয়";
  return {
    decision: "WAIT",
    direction: technical === "LONG" ? "UPWARD" : technical === "SHORT" ? "DOWNWARD" : "SIDEWAYS",
    reason: why + "; তাই ঝুঁকি না নিয়ে অপেক্ষা করা হচ্ছে। Gemini: " + gemini.reason,
    risk: reviewer.risk || gemini.risk,
    dataQuality: gemini.dataQuality
  };
}

async function getDecisionFeedback(env, symbol, tf) {
  if (!env.ANALYSIS_KV) return null;
  const cutoff = Date.now() - 10 * 86400000;
  const listed = await env.ANALYSIS_KV.list({ prefix: "decision:", limit: 1000 });
  const rows = [];
  for (const item of listed.keys) {
    const r = await env.ANALYSIS_KV.get(item.name, "json");
    if (r && r.symbol === symbol && r.timeframe === tf &&
        Date.parse(r.decidedAt) >= cutoff &&
        (r.outcome === "CORRECT" || r.outcome === "WRONG")) rows.push(r);
  }
  rows.sort((a,b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
  const correct = rows.filter(r => r.outcome === "CORRECT").length;
  return {
    sampleSize: rows.length,
    correct,
    wrong: rows.length - correct,
    recentOutcomes: rows.slice(0, 8).map(r => ({
      decision: r.decision, outcome: r.outcome,
      entryPrice: r.entryPrice, exitPrice: r.exitPrice,
      pnlPct: Number.isFinite(r.pnlPct) ? Number(r.pnlPct.toFixed(3)) : null
    }))
  };
}

async function runOne(env, symbol, tf) {
  const marketResponse = await fetch(PAGE_URL + "/api/market?symbol=" + symbol, { headers: { "Cache-Control": "no-cache" } });
  if (!marketResponse.ok) throw new Error("Market API HTTP " + marketResponse.status);
  const data = await marketResponse.json();
  if (!data.candles || !data.ticker) throw new Error("Market API returned incomplete data");
  const market = analyze(data, tf);
  // Check adjacent and broader 4h market structure before accepting a direction.
  const fourHour = buildFourHourContext(data);
  if (tf === "30m") {
    try {
      const other = analyze(data, "1h");
      market.higherTimeframe = { timeframe: "1h", signal: other.indicators.technicalSignal, score: other.indicators.technicalScore, rsi: other.indicators.rsi, ema9: other.indicators.ema9, ema21: other.indicators.ema21, fourHour };
    } catch (_) { market.higherTimeframe = { timeframe: "1h", signal: "WAIT", fourHour }; }
  } else {
    market.higherTimeframe = { timeframe: "4h", signal: fourHour.signal, fourHour };
  }
  market.riskEngine = { timeframe: "4h", available: fourHour.available === true, supportBreakdown: fourHour.supportBreakdown === true, resistanceBreakout: fourHour.resistanceBreakout === true, bearishWarning: fourHour.bearishWarning === true, bullishWarning: fourHour.bullishWarning === true, warnings: fourHour.warnings || (fourHour.warning ? [fourHour.warning] : []) };

  // Feed verified 10-day outcomes to BOTH AI reviewers; this is prompt feedback, not model retraining.
  let performanceFeedback = null;
  try { performanceFeedback = await getDecisionFeedback(env, symbol, tf); }
  catch (feedbackError) { console.warn("Decision feedback unavailable", String(feedbackError)); }
  market.performanceFeedback = performanceFeedback;
  const aiResponse = await fetch(PAGE_URL + "/api/ai", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, timeframe: tf, market })
  });
  const ai = await aiResponse.json().catch(() => ({}));
  if (!aiResponse.ok || !ai.analysis) throw new Error(ai.error || "Gemini API HTTP " + aiResponse.status);

  // Always run the independent Cloudflare reviewer so every analysis contains two AI opinions.
  let reviewer = null;
  let reviewerStatus = "REVIEW_FAILED";
  try {
    reviewer = await reviewWithCloudflare(env, symbol, tf, market, ai.analysis, performanceFeedback);
    reviewerStatus = "REVIEWED";
  } catch (error) {
    reviewer = {
      decision: "WAIT",
      reason: "দ্বিতীয় AI-এর যাচাই পাওয়া যায়নি; তাই নিরাপদে WAIT রাখা হয়েছে।",
      risk: error instanceof Error ? error.message.slice(0, 180) : "দ্বিতীয় AI সাময়িক অনুপলব্ধ"
    };
    console.error("Cloudflare AI review unavailable", { symbol, timeframe: tf, error: String(error) });
  }
  const analysis = reviewerStatus === "REVIEWED"
    ? finalDecision(market, ai.analysis, reviewer)
    : {
        decision: "WAIT",
        direction: ai.analysis.direction || "SIDEWAYS",
        reason: reviewerStatus === "REVIEW_FAILED"
          ? "দ্বিতীয় AI যাচাই করতে পারেনি; ভুল সংকেত এড়াতে WAIT।"
          : "টেকনিক্যাল ইন্ডিকেটর ও প্রথম AI-তে এখনো নিশ্চিত LONG/SHORT প্রার্থী নেই।",
        risk: reviewer.risk || ai.analysis.risk || "বাজারে ঝুঁকি রয়েছে",
        dataQuality: ai.analysis.dataQuality || "LIMITED"
      };
  const result = {
    symbol, timeframe: tf,
    provider: reviewerStatus === "REVIEWED" ? "Gemini + Cloudflare Workers AI" : "Gemini + technical filters",
    model: (ai.model || "Gemini") + (reviewerStatus === "REVIEWED" ? " + " + REVIEW_MODEL : ""),
    analysis,
    debate: {
      status: reviewerStatus,
      gemini: ai.analysis,
      cloudflare: reviewerStatus === "REVIEWED" ? reviewer : null,
      technicalSignal: market.indicators.technicalSignal,
      higherTimeframeSignal: market.higherTimeframe?.signal || "UNAVAILABLE",
      fourHourContext: market.higherTimeframe?.fourHour || null,
      riskEngine: market.riskEngine,
      technicalIndicators: {
        rsi: market.indicators.rsi,
        ema9: market.indicators.ema9,
        ema21: market.indicators.ema21,
        atr: market.indicators.atr,
        macdHistogram: market.indicators.macdHistogram,
        adx: market.indicators.adx,
        plusDI: market.indicators.plusDI,
        minusDI: market.indicators.minusDI,
        bollingerPosition: market.indicators.bbPosition,
        relativeVolume: market.indicators.relativeVolume,
        technicalScore: market.indicators.technicalScore,
        technicalSignal: market.indicators.technicalSignal
      }
    },
    generatedAt: new Date().toISOString(),
    candleCloseTime: market.candleCloseTime,
    marketSource: data.source
  };
  const key = "latest:" + symbol + ":" + tf;
  await env.ANALYSIS_KV.put(key, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
  const decisionId = symbol + ":" + tf + ":" + Date.parse(result.generatedAt);
  if ((analysis.decision === "LONG" || analysis.decision === "SHORT") && Number.isFinite(Number(market.ticker.last)) && Number(market.ticker.last) > 0) {
    const decisionRecord = {
      id: decisionId,
      symbol,
      timeframe: tf,
      decision: analysis.decision,
      entryPrice: Number(market.ticker.last),
      decidedAt: result.generatedAt,
      expectedEvaluationAt: new Date(Date.parse(result.generatedAt) + 24 * 60 * 60 * 1000).toISOString(),
      outcome: "PENDING"
    };
    await env.ANALYSIS_KV.put("decision:" + decisionId, JSON.stringify(decisionRecord), { expirationTtl: 60 * 60 * 24 * 11 });
  }
  await env.ANALYSIS_KV.put("history:" + symbol + ":" + tf + ":" + Date.now(), JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
  await sendSignalPush(env, result);
  return result;
}

async function evaluateMaturedDecisions(env) {
  if (!env.ANALYSIS_KV) return;
  const now = Date.now();
  const listed = await env.ANALYSIS_KV.list({ prefix: "decision:", limit: 1000 });
  const due = [];
  for (const item of listed.keys) {
    const r = await env.ANALYSIS_KV.get(item.name, "json");
    if (r && (r.decision === "LONG" || r.decision === "SHORT") &&
        r.outcome === "PENDING" && now - Date.parse(r.decidedAt) >= 24 * 60 * 60 * 1000) {
      due.push({ key: item.name, record: r });
    }
  }
  const symbols = [...new Set(due.map(x => x.record.symbol))];
  const prices = {};
  await Promise.all(symbols.map(async symbol => {
    try {
      const response = await fetch(PAGE_URL + "/api/price?symbol=" + encodeURIComponent(symbol), {
        headers: { "Cache-Control": "no-cache" }
      });
      if (!response.ok) return;
      const data = await response.json();
      const price = Number(data.last);
      if (Number.isFinite(price) && price > 0) prices[symbol] = price;
    } catch (_) {}
  }));
  for (const item of due) {
    const r = item.record, exitPrice = prices[r.symbol];
    if (!Number.isFinite(exitPrice)) continue;
    r.exitPrice = exitPrice;
    r.evaluatedAt = new Date(now).toISOString();
    r.evaluationDelayMs = Math.max(0, now - Date.parse(r.expectedEvaluationAt));
    r.pnlPct = (r.decision === "LONG"
      ? (exitPrice / r.entryPrice - 1)
      : (r.entryPrice / exitPrice - 1)) * 100;
    r.outcome = r.pnlPct > 0 ? "CORRECT" : "WRONG";
    await env.ANALYSIS_KV.put(item.key, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 * 11 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/push/health" && request.method === "GET") {
      let privateKeyBytes = 0, publicKeyBytes = 0, privateKeyError = null;
      const privateKeyPresent = !!env.VAPID_PRIVATE_KEY;
      try { if (privateKeyPresent) privateKeyBytes = decodeVapidPrivateKey(env.VAPID_PRIVATE_KEY).length; }
      catch (error) { privateKeyError = error instanceof Error ? error.message : "Private key parse failed"; }
      try { if (env.VAPID_PUBLIC_KEY) publicKeyBytes = unb64u(env.VAPID_PUBLIC_KEY).length; } catch (_) {}
      return Response.json({
        analysisKv: !!env.ANALYSIS_KV,
        vapidPublicKey: publicKeyBytes === 65,
        vapidPrivateKeyPresent: privateKeyPresent,
        vapidPrivateKey: privateKeyBytes === 32,
        privateKeyInputLength: privateKeyPresent ? String(env.VAPID_PRIVATE_KEY).trim().length : 0,
        privateKeyBytes,
        privateKeyError,
        pushReady: !!env.ANALYSIS_KV && publicKeyBytes === 65 && privateKeyBytes === 32
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/push/public-key" && request.method === "GET") {
      if (!env.VAPID_PUBLIC_KEY) return Response.json({ error: "Push notifications are not configured" }, { status: 503 });
      return Response.json({ publicKey: env.VAPID_PUBLIC_KEY }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/push/subscribe" && request.method === "POST") {
      if (!env.ANALYSIS_KV) return Response.json({ error: "ANALYSIS_KV binding is missing" }, { status: 503 });
      let subscription;
      try { subscription = await request.json(); } catch { return Response.json({ error: "Invalid subscription" }, { status: 400 }); }
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth || !subscription.endpoint.startsWith("https://")) {
        return Response.json({ error: "Invalid push subscription" }, { status: 400 });
      }
      const digest = await crypto.subtle.digest("SHA-256", utf8(subscription.endpoint));
      const id = b64u(new Uint8Array(digest)).slice(0, 32);
      await env.ANALYSIS_KV.put("push:sub:" + id, JSON.stringify(subscription), { expirationTtl: 60 * 60 * 24 * 180 });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/push/test" && request.method === "POST") {
      if (!env.ANALYSIS_KV || !env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
        return Response.json({ error: "Push keys are not configured" }, { status: 503 });
      }
      const listed = await env.ANALYSIS_KV.list({ prefix: "push:sub:", limit: 100 });
      if (!listed.keys.length) return Response.json({ error: "No push subscription found" }, { status: 404 });
      const payload = { title: "নোটিফিকেশন পরীক্ষা", body: "সাউন্ড ও নোটিফিকেশন পরীক্ষা সফল", url: "/", tag: "crypto-ai-market-test-" + Date.now() };
      const results = await Promise.allSettled(listed.keys.map(async item => {
        const subscription = await env.ANALYSIS_KV.get(item.name, "json");
        if (!subscription) return;
        const response = await sendOnePush(env, subscription, payload);
        if (response.status === 404 || response.status === 410) await env.ANALYSIS_KV.delete(item.name);
        if (!response.ok) throw new Error("Push provider HTTP " + response.status);
      }));
      const failed = results.filter(x => x.status === "rejected").length;
      return Response.json({ ok: failed === 0, failed }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
      if (body?.endpoint && env.ANALYSIS_KV) {
        const digest = await crypto.subtle.digest("SHA-256", utf8(body.endpoint));
        const id = b64u(new Uint8Array(digest)).slice(0, 32);
        await env.ANALYSIS_KV.delete("push:sub:" + id);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/performance" && request.method === "GET") {
      if (!env.ANALYSIS_KV) return Response.json({ error: "ANALYSIS_KV binding is missing" }, { status: 503 });
      const now = Date.now(), cutoff = now - 10 * 24 * 60 * 60 * 1000;
      const listed = await env.ANALYSIS_KV.list({ prefix: "decision:", limit: 1000 });
      const records = [];
      for (const item of listed.keys) {
        const record = await env.ANALYSIS_KV.get(item.name, "json");
        if (record && (record.decision === "LONG" || record.decision === "SHORT") &&
            Date.parse(record.decidedAt) >= cutoff) records.push(record);
      }
      records.sort((a,b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
      const last24 = records.filter(x => Date.parse(x.decidedAt) >= now - 86400000);
      const settled = records.filter(x => x.outcome === "CORRECT" || x.outcome === "WRONG");
      const correct = settled.filter(x => x.outcome === "CORRECT").length;
      const evaluatedLast24 = settled.filter(x => Date.parse(x.evaluatedAt || 0) >= now - 86400000);
      const summary = {
        total: records.length, correct, wrong: settled.length - correct,
        pending: records.filter(x => x.outcome === "PENDING").length,
        accuracy: settled.length ? Math.round(correct / settled.length * 1000) / 10 : null,
        last24: {
          total: last24.length,
          correct: last24.filter(x => x.outcome === "CORRECT").length,
          wrong: last24.filter(x => x.outcome === "WRONG").length,
          pending: last24.filter(x => x.outcome === "PENDING").length
        },
        evaluatedLast24: {
          total: evaluatedLast24.length,
          correct: evaluatedLast24.filter(x => x.outcome === "CORRECT").length,
          wrong: evaluatedLast24.filter(x => x.outcome === "WRONG").length
        }
      };
      const dailyMap = {};
      for (const r of records) {
        const day = new Date(r.decidedAt).toISOString().slice(0,10);
        if (!dailyMap[day]) dailyMap[day] = { date: day, total: 0, correct: 0, wrong: 0, pending: 0, records: [] };
        const d = dailyMap[day];
        d.total++;
        if (r.outcome === "CORRECT") d.correct++;
        else if (r.outcome === "WRONG") d.wrong++;
        else d.pending++;
        d.records.push(r);
      }
      return Response.json({
        summary,
        daily: Object.values(dailyMap).sort((a,b)=>b.date.localeCompare(a.date)),
        records
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/analyze" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
      const { symbol, timeframe } = body || {};
      if (!["BTC", "SOL"].includes(symbol) || !["30m", "1h"].includes(timeframe)) {
        return Response.json({ error: "Unsupported symbol or timeframe" }, { status: 400 });
      }
      if (!env.ANALYSIS_KV) return Response.json({ error: "ANALYSIS_KV binding is missing" }, { status: 503 });
      const lockKey = "manual-run:" + symbol + ":" + timeframe;
      const locked = await env.ANALYSIS_KV.get(lockKey);
      if (locked) {
        const cached = await env.ANALYSIS_KV.get("latest:" + symbol + ":" + timeframe, "json");
        if (cached) return Response.json({ items: [cached], throttled: true }, { headers: { "Cache-Control": "no-store" } });
        return Response.json({ error: "বিশ্লেষণ ইতিমধ্যে চলছে; কিছুক্ষণ পর আবার চেষ্টা করুন।" }, { status: 429 });
      }
      await env.ANALYSIS_KV.put(lockKey, "1", { expirationTtl: 120 });
      try {
        const result = await runOne(env, symbol, timeframe);
        return Response.json({ items: [result], triggered: true }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        await env.ANALYSIS_KV.delete(lockKey);
        console.error("Manual analysis failed", { symbol, timeframe, error: String(error) });
        return Response.json({ error: error instanceof Error ? error.message : "বিশ্লেষণ ব্যর্থ হয়েছে" }, { status: 502 });
      }
    }
    if (url.pathname !== "/latest") return Response.json({ error: "Not found" }, { status: 404 });
    const symbol = url.searchParams.get("symbol");
    const timeframe = url.searchParams.get("timeframe");
    if (!["BTC", "SOL"].includes(symbol) || !["30m", "1h"].includes(timeframe)) {
      return Response.json({ error: "Unsupported symbol or timeframe" }, { status: 400 });
    }
    if (!env.ANALYSIS_KV) return Response.json({ error: "ANALYSIS_KV binding is missing" }, { status: 503 });
    const latest = await env.ANALYSIS_KV.get("latest:" + symbol + ":" + timeframe, "json");
    return Response.json({ items: latest ? [latest] : [] }, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  },
  async scheduled(controller, env, ctx) {
    await evaluateMaturedDecisions(env);
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
