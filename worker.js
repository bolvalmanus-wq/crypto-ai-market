const PAGE_URL = "https://crypto-ai-market.pages.dev";
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64u = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((value.length+3)%4)), ch => ch.charCodeAt(0));
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
  const privateBytes=unb64u(env.VAPID_PRIVATE_KEY);
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
  const score = clamp(.38*trend + .32*priceTrend + .22*momentum + .08*rsiBias);
  let signal = "WAIT", reason = "ট্রেন্ড, লাইভ মোমেন্টাম ও সূচকগুলো এখনো একমত নয়";
  // RSI extremes are risk warnings, not automatic bans on a valid trend signal.
  if (score >= .48 && rv < 90) { signal = "LONG"; reason = rv >= 78 ? "ট্রেন্ড LONG-এর পক্ষে, তবে RSI বেশি হওয়ায় ঝুঁকি উঁচু" : "EMA ট্রেন্ড ও মোমেন্টাম LONG-এর পক্ষে"; }
  else if (score <= -.48 && rv > 10) { signal = "SHORT"; reason = rv <= 22 ? "ট্রেন্ড SHORT-এর পক্ষে, তবে RSI কম হওয়ায় ঝুঁকি উঁচু" : "EMA ট্রেন্ড ও মোমেন্টাম SHORT-এর পক্ষে"; }
  else if (rv >= 78) reason = "RSI বেশি; নতুন LONG নেওয়ার আগে নিশ্চিতকরণ দরকার";
  else if (rv <= 22) reason = "RSI কম; নতুন SHORT নেওয়ার আগে নিশ্চিতকরণ দরকার";
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

function parseModelJson(output) {
  const raw = output?.response || output?.choices?.[0]?.message?.content || output?.result?.response || "";
  if (typeof raw !== "string") throw new Error("Cloudflare AI returned an unsupported response");
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Cloudflare AI returned invalid JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!["LONG","SHORT","WAIT"].includes(parsed.decision) ||
      typeof parsed.reason !== "string" || typeof parsed.risk !== "string") {
    throw new Error("Cloudflare AI answer failed validation");
  }
  return parsed;
}

async function reviewWithCloudflare(env, symbol, tf, market, gemini) {
  if (!env.AI || typeof env.AI.run !== "function") throw new Error("Workers AI binding AI is not configured");
  const compactMarket = {
    source: market.source,
    price: market.ticker?.last,
    indicators: market.indicators,
    higherTimeframe: market.higherTimeframe,
    derivatives: market.derivatives ? {
      longShort: market.derivatives.longShort,
      openInterest: market.derivatives.openInterest,
      fundingHistory: market.derivatives.fundingHistory
    } : null,
    recentCandles: (market.candles || []).slice(-12).map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
    }))
  };
  const messages = [
    { role: "system", content: "তুমি স্বাধীন ও কঠোর ঝুঁকি-পর্যালোচক ক্রিপ্টো পারপেচুয়াল বিশ্লেষক। প্রথম AI-এর সিদ্ধান্তকে অন্ধভাবে সমর্থন করবে না। প্রদত্ত ডেটা দিয়ে তার যুক্তির দুর্বলতা খুঁজবে, বিপরীত দিকের সম্ভাবনাও পরীক্ষা করবে। ডেটায় নেই এমন তথ্য বানাবে না। অস্পষ্টতা, মতবিরোধ বা দুর্বল ডেটা হলে WAIT বেছে নেবে। কেবল বৈধ JSON দেবে: {\"decision\":\"LONG|SHORT|WAIT\",\"reason\":\"সংক্ষিপ্ত বাংলা যুক্তি\",\"risk\":\"সংক্ষিপ্ত বাংলা ঝুঁকি\"}. জয়ের সম্ভাবনার শতাংশ দেবে না।" },
    { role: "user", content: JSON.stringify({
      task: "প্রথম AI-এর সঙ্গে যুক্তি-পরীক্ষা করো। প্রয়োজন হলে তার সিদ্ধান্ত প্রত্যাখ্যান করো।",
      symbol, timeframe: tf, market: compactMarket,
      firstAI: { decision: gemini.decision, direction: gemini.direction, reason: gemini.reason, risk: gemini.risk, dataQuality: gemini.dataQuality }
    }) }
  ];
  const output = await env.AI.run(REVIEW_MODEL, {
    messages,
    max_tokens: 220,
    temperature: 0.1
  });
  return parseModelJson(output);
}

function finalDecision(market, gemini, reviewer) {
  const technical = market.indicators.technicalSignal;
  const a = gemini.decision, b = reviewer.decision;
  const higher = market.higherTimeframe?.signal;
  const sameAI = a === b && (a === "LONG" || a === "SHORT");
  const sameTechnical = technical === a;
  const higherConflicts = higher && higher !== "WAIT" && higher !== a;
  if (sameAI && sameTechnical && !higherConflicts && gemini.dataQuality === "GOOD") {
    return {
      decision: a,
      direction: a === "LONG" ? "UPWARD" : "DOWNWARD",
      reason: "দুই AI একমত এবং টেকনিক্যাল ইন্ডিকেটরও " + a + " সমর্থন করছে। " + gemini.reason,
      risk: reviewer.risk || gemini.risk,
      dataQuality: gemini.dataQuality
    };
  }
  const why = higherConflicts
    ? "উচ্চতর সময়সীমার সংকেত বিপরীত"
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

  let reviewer = { decision: "WAIT", reason: "প্রাথমিকভাবে দুই AI-এর বিতর্ক প্রয়োজন হয়নি", risk: ai.analysis.risk || "বাজারে ঝুঁকি রয়েছে" };
  let reviewerStatus = "SKIPPED_NO_DIRECTIONAL_CANDIDATE";
  // Spend Workers AI neurons only when Gemini or the technical engine sees a LONG/SHORT candidate.
  if (["LONG","SHORT"].includes(ai.analysis.decision) || ["LONG","SHORT"].includes(market.indicators.technicalSignal)) {
    try {
      reviewer = await reviewWithCloudflare(env, symbol, tf, market, ai.analysis);
      reviewerStatus = "REVIEWED";
    } catch (error) {
      reviewerStatus = "REVIEW_FAILED";
      reviewer = {
        decision: "WAIT",
        reason: "দ্বিতীয় AI-এর যাচাই পাওয়া যায়নি; তাই নিরাপদে WAIT রাখা হয়েছে।",
        risk: error instanceof Error ? error.message.slice(0, 180) : "দ্বিতীয় AI সাময়িক অনুপলব্ধ"
      };
      console.error("Cloudflare AI review unavailable", { symbol, timeframe: tf, error: String(error) });
    }
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
      higherTimeframeSignal: market.higherTimeframe?.signal || "UNAVAILABLE"
    },
    generatedAt: new Date().toISOString(),
    candleCloseTime: market.candleCloseTime,
    marketSource: data.source
  };
  const key = "latest:" + symbol + ":" + tf;
  await env.ANALYSIS_KV.put(key, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
  await env.ANALYSIS_KV.put("history:" + symbol + ":" + tf + ":" + Date.now(), JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
  await sendSignalPush(env, result);
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
