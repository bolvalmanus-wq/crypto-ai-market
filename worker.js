import { evaluateV2 } from "./trading-v2.js";
import { trainBrainModel } from "./brain-model.js";
import { onRequestGet as fetchMarketResponse } from "./functions/api/market.js";
const PAGE_URL = "https://crypto-ai-market.pages.dev";

// Fetch market data directly inside the Worker. Never call this Pages site from
// the Worker: pages.dev is a partial-zone hostname and can fail with DNS 1016.
async function loadMarketData(symbol) {
  const request = new Request("https://market-worker.internal/api/market?symbol=" + encodeURIComponent(symbol), {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" }
  });
  const response = await fetchMarketResponse({ request });
  const data = await response.json();
  if (!response.ok || !data?.candles || !data?.ticker) {
    throw new Error(data?.details || data?.error || "Market data unavailable (HTTP " + response.status + ")");
  }
  return data;
}
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
function isAllowedPushEndpoint(value) {
  try {
    const endpoint=new URL(value),host=endpoint.hostname.toLowerCase();
    const allowedHost=host==="fcm.googleapis.com"||host==="web.push.apple.com"||host==="push.apple.com"||
      host==="push.services.mozilla.com"||host.endsWith(".push.services.mozilla.com")||
      host==="notify.windows.com"||host.endsWith(".notify.windows.com");
    return endpoint.protocol==="https:"&&allowedHost&&!endpoint.port&&!endpoint.username&&!endpoint.password;
  } catch (_) { return false; }
}
async function sendOnePush(env,subscription,payload) {
  if(!isAllowedPushEndpoint(subscription?.endpoint))throw new Error("Unsupported Web Push endpoint host");
  const endpoint=new URL(subscription.endpoint);
  const token=await vapidToken(endpoint.origin,env);
  const body=await encryptPush(subscription,payload);
  return fetch(subscription.endpoint,{
    method:"POST",headers:{
      "Authorization":"vapid t="+token+", k="+env.VAPID_PUBLIC_KEY,
      "Content-Type":"application/octet-stream","Content-Encoding":"aes128gcm",
      "TTL":"300","Urgency":"high"
    },body,signal:AbortSignal.timeout(8000)
  });
}
async function sendSignalPush(env,result) {
  if(!env.ANALYSIS_KV) return;
  if(!env.VAPID_PRIVATE_KEY||!env.VAPID_PUBLIC_KEY) {
    console.log("Signal alert skipped: VAPID keys not configured",{symbol:result.symbol,timeframe:result.timeframe,decision:result.analysis.decision});
    return;
  }
  const decision=result.analysis.decision;
  if(!["LONG","SHORT"].includes(decision)) return;
  const stateKey="lastsignal:"+result.symbol+":"+result.timeframe;
  let previous;
  try{previous=await env.ANALYSIS_KV.get(stateKey,"json");}
  catch(error){console.error("Push deduplication read failed; notification skipped",String(error));return;}
  // Deduplicate only the exact same candle's decision. A fresh candle must
  // notify again even when its direction matches the previous LONG/SHORT.
  if(previous?.candleCloseTime===result.candleCloseTime&&previous?.decision===decision&&previous?.notifiedAt) return;
  const subscriptionKeys=[];
  try {
    let cursor;
    do {
      const page=await env.ANALYSIS_KV.list({prefix:"push:sub:",limit:1000,...(cursor?{cursor}:{})});
      subscriptionKeys.push(...(page.keys||[]));
      cursor=page.list_complete?undefined:page.cursor;
    } while(cursor);
  } catch(error) { console.error("Push subscription lookup failed",String(error)); return; }
  if(!subscriptionKeys.length)return;
  const payload={
    title:decision,
    body:result.symbol+" · "+({"30m":"৩০ মিনিট","1h":"১ ঘণ্টা","4h":"৪ ঘণ্টা"}[result.timeframe]||result.timeframe),
    url:"/",
    tag:result.symbol+"-"+result.timeframe+"-"+decision+"-"+String(result.candleCloseTime||result.generatedAt||Date.now()),
    decision,symbol:result.symbol,timeframe:result.timeframe
  };
  // Bound concurrent cryptographic work and provider requests; paginate so no
  // subscriber is silently omitted after the first KV page.
  let delivered=false;
  for(let offset=0;offset<subscriptionKeys.length;offset+=10){
    const batch=subscriptionKeys.slice(offset,offset+10);
    const outcomes=await Promise.allSettled(batch.map(async item=>{
      const subscription=await env.ANALYSIS_KV.get(item.name,"json");
      if(!subscription)return false;
      try{
        const response=await sendOnePush(env,subscription,payload);
        if(response.status===404||response.status===410){await env.ANALYSIS_KV.delete(item.name);return false;}
        if(!response.ok){console.error("Push delivery failed",response.status);return false;}
        return true;
      }catch(error){console.error("Push send error",String(error));return false;}
    }));
    if(outcomes.some(item=>item.status==="fulfilled"&&item.value===true))delivered=true;
  }
  // Only remember a signal after a push provider accepted it. Otherwise a
  // temporary delivery failure would suppress every retry of this signal.
  if(delivered){
    try{await env.ANALYSIS_KV.put(stateKey,JSON.stringify({decision,candleCloseTime:result.candleCloseTime,notifiedAt:new Date().toISOString()}),{expirationTtl:60*60*24*14});}
    catch(error){console.error("Push deduplication state write failed",String(error));}
  }
}
const INTERVALS = { "30m": 30 * 60 * 1000, "1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000 };

function ema(values, period) {
  const k = 2 / (period + 1); let value = values[0];
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return 50;
  let avgGain=0,avgLoss=0;
  for(let i=1;i<=period;i++){const change=values[i]-values[i-1];if(change>0)avgGain+=change;else avgLoss-=change;}
  avgGain/=period;avgLoss/=period;
  for(let i=period+1;i<values.length;i++){
    const change=values[i]-values[i-1],gain=Math.max(0,change),loss=Math.max(0,-change);
    avgGain=(avgGain*(period-1)+gain)/period;
    avgLoss=(avgLoss*(period-1)+loss)/period;
  }
  if(avgGain===0&&avgLoss===0)return 50;
  if(avgLoss===0)return 100;
  if(avgGain===0)return 0;
  const rs=avgGain/avgLoss;
  return 100-100/(1+rs);
}
function analyze(data, tf) {
  const interval = INTERVALS[tf];
  const sortedBars = (data.candles?.[tf] || []).filter(c => c && c.confirmed === true &&
    [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.time > 0 && c.low > 0 && c.high >= c.low &&
    c.open >= c.low && c.open <= c.high && c.close >= c.low && c.close <= c.high && c.volume >= 0
  ).sort((a,b) => a.time - b.time);
  // Keep only the latest uninterrupted run; rolling indicators must not bridge missing candles.
  let segmentStart=0;
  for(let i=1;i<sortedBars.length;i++)if(sortedBars[i].time-sortedBars[i-1].time!==interval)segmentStart=i;
  const bars=sortedBars.slice(segmentStart);
  if (bars.length < 30) throw new Error("Not enough confirmed candles for " + tf);
  const last = bars[bars.length - 1];
  const closeTime = last.time + interval;
  if (Date.now() < closeTime) throw new Error("Latest candle is not closed yet");
  if (Date.now() - closeTime > interval * 1.5) throw new Error("Latest confirmed candle is stale");
  // Keep every indicator on fully confirmed candle data. The live ticker is
  // retained separately for the actual entry quote, never mixed into closed-bar signals.
  const price = Number(last.close);
  const closes = bars.map(c => Number(c.close));
  const e9 = ema(closes.slice(-40), 9), e21 = ema(closes.slice(-60), 21), rv = rsi(closes);
  const ranges = bars.slice(-15).map((c, i) => {
    const p = bars[bars.length - 16 + i];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  const atr = ranges.reduce((a,b) => a+b, 0) / ranges.length;
  const clamp = (x, lo=-1, hi=1) => Math.max(lo, Math.min(hi, x));
  const trend = clamp((e9 / e21 - 1) * 120);
  const priceTrend = clamp((price / e9 - 1) * 80);
  // Three-candle momentum: compare the confirmed close with the close three bars earlier.
  const momentum = closes.length > 3
    ? clamp((price / closes[closes.length - 4] - 1) * 250)
    : 0;
  const rsiBias = clamp((rv - 50) / 22);
  let rawScore = .38*trend + .32*priceTrend + .22*momentum + .08*rsiBias;
  const derivatives = data.derivatives || {};
  const oi = tf === "30m" ? derivatives.openInterest30m : tf === "1h" ? derivatives.openInterest1h : null;
  if (Array.isArray(oi) && oi.length >= 2) {
    const oiStart = Number(oi[0].value), oiEnd = Number(oi[oi.length - 1].value);
    if (Number.isFinite(oiStart) && oiStart > 0 && Number.isFinite(oiEnd) && oiEnd > 0) {
      const delta = oiEnd / oiStart - 1;
      rawScore += clamp(delta * 18) * .08;
    }
  }
  const ratios = tf === "30m" ? derivatives.longShort30m : tf === "1h" ? derivatives.longShort1h : null;
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
  // Stochastic RSI (14,14): calculate a Wilder RSI series, then normalize
  // the latest RSI against the recent 14 RSI readings. Keep it local to analyze().
  const rsiSeries = closes.map((_, index) => index >= 14 ? rsi(closes.slice(0, index + 1), 14) : NaN);
  const rsiWindow = rsiSeries.slice(-14).filter(Number.isFinite);
  const rsiMin = rsiWindow.length ? Math.min(...rsiWindow) : 0;
  const rsiMax = rsiWindow.length ? Math.max(...rsiWindow) : 0;
  const stochRsi = rsiWindow.length && rsiMax > rsiMin
    ? ((rv - rsiMin) / (rsiMax - rsiMin)) * 100
    : 50;
  const vwapBars=bars.slice(-20);
  const vwapVolume=vwapBars.reduce((sum,x)=>sum+Math.max(0,Number(x.volume)||0),0);
  const vwap=vwapVolume>0?vwapBars.reduce((sum,x)=>sum+((x.high+x.low+x.close)/3)*Math.max(0,Number(x.volume)||0),0)/vwapVolume:price;
  const roc3=closes.length>3?(price/closes[closes.length-4]-1)*100:0;
  const roc9=closes.length>9?(price/closes[closes.length-10]-1)*100:0;
  const rocBias=clamp((roc3*0.55+roc9*0.45)*18);
  const vwapBias=clamp((price/vwap-1)*160);
  const donchianBars=bars.slice(-21,-1);
  const donchianUpper=donchianBars.length?Math.max(...donchianBars.map(x=>x.high)):price;
  const donchianLower=donchianBars.length?Math.min(...donchianBars.map(x=>x.low)):price;
  const donchianWidth=Math.max(donchianUpper-donchianLower,price*0.00001);
  const donchianBias=price>donchianUpper?1:price<donchianLower?-1:clamp((price-(donchianUpper+donchianLower)/2)/(donchianWidth/2))*0.35;
  const lastRange=Math.max(last.high-last.low,price*0.00001);
  const candlePressure=clamp((2*last.close-last.high-last.low)/lastRange);
  const priceActionBias=clamp(rocBias*0.38+vwapBias*0.22+donchianBias*0.25+candlePressure*0.15);
  // Add bounded price-action confirmation; related signals are combined once.
  rawScore = clamp(rawScore * 0.82 + priceActionBias * 0.18);
  const score = clamp(rawScore);
  let signal = "WAIT", reason = "ট্রেন্ড, MACD, ADX, ভলিউম ও অন্যান্য সূচক এখনো একমত নয়";
  // RSI extremes are risk warnings, not automatic bans on a valid trend signal.
  if (score >= .48 && rv < 90) { signal = "LONG"; reason = rv >= 78 ? "ট্রেন্ড LONG-এর পক্ষে, তবে RSI বেশি হওয়ায় ঝুঁকি উঁচু" : "EMA ট্রেন্ড ও মোমেন্টাম LONG-এর পক্ষে"; }
  else if (score <= -.48 && rv > 10) { signal = "SHORT"; reason = rv <= 22 ? "ট্রেন্ড SHORT-এর পক্ষে, তবে RSI কম হওয়ায় ঝুঁকি উঁচু" : "EMA ট্রেন্ড ও মোমেন্টাম SHORT-এর পক্ষে"; }
  else if (rv >= 78) reason = "RSI বেশি; নতুন LONG নেওয়ার আগে নিশ্চিতকরণ দরকার";
  else if (rv <= 22) reason = "RSI কম; নতুন SHORT নেওয়ার আগে নিশ্চিতকরণ দরকার";
  return {
    source: data.source, ticker: data.ticker,
    indicators: { rsi: rv, ema9: e9, ema21: e21, atr, macdLine, macdSignal, macdHistogram, adx, plusDI, minusDI, bbUpper, bbMiddle: bbMean, bbLower, bbPosition, relativeVolume, vwap, stochRsi, roc3, roc9, donchianUpper, donchianLower, donchianBias, candlePressure, priceActionBias, technicalScore: score, technicalSignal: signal },
    candles: bars.slice(-80),
    higherTimeframe: null,
    derivatives: data.derivatives ? {
      openInterest: tf === "30m" ? data.derivatives.openInterest30m : tf === "1h" ? data.derivatives.openInterest1h : null,
      longShort: tf === "30m" ? data.derivatives.longShort30m : tf === "1h" ? data.derivatives.longShort1h : null,
      orderbook: data.derivatives.orderbook,
      fundingHistory: data.derivatives.fundingHistory
    } : null,
    candleCloseTime: new Date(closeTime).toISOString()
  };
}



function buildIntradayMovement(data){
  const now=Date.now(),today=new Date(now),cutoff=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
  const bars=(data.candles?.["30m"]||[]).filter(c=>c&&c.confirmed&&[c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.close>0&&c.time>=cutoff&&c.time<=now).sort((a,b)=>a.time-b.time);
  const hours=new Map();
  for(const c of bars){
    const hourStart=Math.floor(c.time/3600000)*3600000;
    let h=hours.get(hourStart);
    if(!h){h={time:hourStart,open:c.open,close:c.close,high:c.high,low:c.low,candles:0};hours.set(hourStart,h);}
    h.close=c.close;h.high=Math.max(h.high,c.high);h.low=Math.min(h.low,c.low);h.candles++;
  }
  const hourly=[...hours.values()].sort((a,b)=>a.time-b.time).map(h=>({time:new Date(h.time).toISOString(),endTime:new Date(h.time+3600000).toISOString(),open:Number(h.open.toFixed(8)),close:Number(h.close.toFixed(8)),high:Number(h.high.toFixed(8)),low:Number(h.low.toFixed(8)),changePct:Number(((h.close/h.open-1)*100).toFixed(3)),direction:h.close>h.open?"UP":h.close<h.open?"DOWN":"FLAT",candles:h.candles}));
  const ranked=hourly.filter(h=>h.candles===2);
  const segments=[];
  let segment=null,previousClose=null,previousTime=null;
  for(const c of bars){
    if(previousTime!==null&&c.time-previousTime!==1800000){if(segment)segments.push(segment);segment=null;previousClose=null;}
    const direction=previousClose===null?(c.close>c.open?"UP":c.close<c.open?"DOWN":"FLAT"):(c.close>previousClose?"UP":c.close<previousClose?"DOWN":"FLAT");
    if(!segment||segment.direction!==direction){
      if(segment)segments.push(segment);
      segment={startTime:c.time,endTime:c.time+1800000,startPrice:previousClose===null?c.open:previousClose,endPrice:c.close,high:c.high,low:c.low,candles:1,direction};
    }else{
      segment.endTime=c.time+1800000;segment.endPrice=c.close;segment.high=Math.max(segment.high,c.high);segment.low=Math.min(segment.low,c.low);segment.candles++;
    }
    previousClose=c.close;previousTime=c.time;
  }
  if(segment)segments.push(segment);
  const movementSegments=segments.filter(s=>s.direction!=="FLAT"&&s.candles>=2).map(s=>({startTime:new Date(s.startTime).toISOString(),endTime:new Date(s.endTime).toISOString(),startPrice:Number(s.startPrice.toFixed(8)),endPrice:Number(s.endPrice.toFixed(8)),high:Number(s.high.toFixed(8)),low:Number(s.low.toFixed(8)),durationMinutes:s.candles*30,candles:s.candles,direction:s.direction,changePct:Number(((s.endPrice/s.startPrice-1)*100).toFixed(3))}));
  const rises=movementSegments.filter(s=>s.direction==="UP").sort((a,b)=>b.changePct-a.changePct);
  const falls=movementSegments.filter(s=>s.direction==="DOWN").sort((a,b)=>a.changePct-b.changePct);
  const expectedCandles=Math.max(0,Math.floor((now-cutoff)/1800000));
  return {timeframe:"30m grouped by UTC hour and directional runs",windowStart:bars.length?new Date(bars[0].time).toISOString():null,windowEnd:bars.length?new Date(bars[bars.length-1].time+1800000).toISOString():null,candleCount:bars.length,expectedCandles,coverageHours:Number((bars.length*30/60).toFixed(1)),completeWindow:expectedCandles>0&&bars.length>=expectedCandles*.9,hourly,segments:movementSegments,strongestRise:ranked.slice().sort((a,b)=>b.changePct-a.changePct)[0]||null,strongestFall:ranked.slice().sort((a,b)=>a.changePct-b.changePct)[0]||null,strongestRiseSegment:rises[0]||null,strongestFallSegment:falls[0]||null,topRiseSegments:rises.slice(0,3),topFallSegments:falls.slice(0,3)};
}

function calculateAgentIndicatorSets(market){
  const b=(market.candles||[]).filter(c=>[c.high,c.low,c.close,c.volume].every(Number.isFinite)).slice(-80);
  const hl=n=>{const a=b.slice(-n);return{high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low))};};
  const mid=n=>{const x=hl(n);return(x.high+x.low)/2;};
  const last=b[b.length-1]||{},p=Number(last.close)||Number(market.ticker?.last)||0;
  const tenkan=mid(9),kijun=mid(26),spanA=(tenkan+kijun)/2,spanB=mid(52);
  const vol=b.slice(-20).reduce((s,x)=>s+Math.max(0,x.volume),0);
  const vwap=vol?b.slice(-20).reduce((s,x)=>s+(x.high+x.low+x.close)/3*Math.max(0,x.volume),0)/vol:p;
  const range=hl(50),width=range.high-range.low,atr=Number(market.indicators?.atr)||0;
  const e20=ema(b.map(x=>x.close).slice(-40),20);
  const typical=b.slice(-20).map(x=>(x.high+x.low+x.close)/3);
  const mean=typical.reduce((s,x)=>s+x,0)/Math.max(1,typical.length);
  const deviation=typical.reduce((s,x)=>s+Math.abs(x-mean),0)/Math.max(1,typical.length);
  const cci=deviation?(typical[typical.length-1]-mean)/(.015*deviation):0;
  // Donchian breakout must compare the current close with the PREVIOUS 20 bars,
  // excluding the current candle; otherwise a close cannot exceed its own high.
  const dc=(()=>{const prior=b.slice(-21,-1);return prior.length?{high:Math.max(...prior.map(x=>x.high)),low:Math.min(...prior.map(x=>x.low))}:{high:p,low:p};})();
  let sar=Number(b[0]?.low)||0,ep=Number(b[0]?.high)||0,af=.02,up=(Number(b[1]?.close)||p)>=(Number(b[0]?.close)||p);
  for(let i=1;i<b.length;i++){const cur=b[i],prev=b[i-1];sar=sar+af*(ep-sar);if(up){sar=Math.min(sar,prev.low,...(b[i-2]?[b[i-2].low]:[]));if(cur.low<sar){up=false;sar=ep;ep=cur.low;af=.02;}else if(cur.high>ep){ep=cur.high;af=Math.min(.2,af+.02);}}else{sar=Math.max(sar,prev.high,...(b[i-2]?[b[i-2].high]:[]));if(cur.high>sar){up=true;sar=ep;ep=cur.high;af=.02;}else if(cur.low<ep){ep=cur.low;af=Math.min(.2,af+.02);}}}
  const obv=b.reduce((state,x,i)=>state+(i===0||x.close===b[i-1].close?0:x.close>b[i-1].close?x.volume:-x.volume),0);
  const obvRecent=b.slice(-10).reduce((state,x,i,a)=>state+(i===0||x.close===a[i-1].close?0:x.close>a[i-1].close?x.volume:-x.volume),0);
  const moneyFlowVolume=b.slice(-20).reduce((s,x)=>s+((x.high===x.low?0:((2*x.close-x.high-x.low)/(x.high-x.low))*x.volume)),0);
  const volume20=b.slice(-20).reduce((s,x)=>s+x.volume,0);
  const cmf=volume20?moneyFlowVolume/volume20:0;
  // Analyst-only, non-overlapping indicator calculations.
  const closes=b.map(x=>x.close), highs=b.map(x=>x.high), lows=b.map(x=>x.low), volumes=b.map(x=>x.volume);
  const pct=(a,z)=>z?((a-z)/z)*100:0;
  const williams=(()=>{const x=hl(14);return x.high===x.low?-50:-100*(x.high-p)/(x.high-x.low);})();
  const aroon=(()=>{const a=b.slice(-25);let hi=0,lo=0;for(let i=1;i<a.length;i++){if(a[i].high>=a[hi].high)hi=i;if(a[i].low<=a[lo].low)lo=i;}return{up:(hi/Math.max(1,a.length-1))*100,down:(lo/Math.max(1,a.length-1))*100};})();
  const volumeProfile=(()=>{const rows=b.slice(-50),lo=Math.min(...rows.map(x=>x.low)),hi=Math.max(...rows.map(x=>x.high)),bins=12,step=(hi-lo)/bins,weights=Array(bins).fill(0);for(const x of rows){const index=Math.max(0,Math.min(bins-1,Math.floor(((x.high+x.low+x.close)/3-lo)/(step||1))));weights[index]+=x.volume;}const best=weights.indexOf(Math.max(...weights));return{pointOfControl:lo+(best+.5)*step,binVolume:weights[best],priceVsPoc:p>=lo+(best+.5)*step?"ABOVE":"BELOW"};})();
  const trueRanges=b.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-b[i].close),Math.abs(x.low-b[i].close)));
  const atrRecent=trueRanges.slice(-14).reduce((s,x)=>s+x,0)/Math.max(1,Math.min(14,trueRanges.length));
  // ATR-band Supertrend (not an EMA proxy).
  const supertrendDirection=(()=>{let upper=0,lower=0,direction="DOWN";for(let i=1;i<b.length;i++){const sample=b.slice(Math.max(1,i-9),i+1),trs=sample.map((x,j)=>{const prev=b[Math.max(0,Math.max(1,i-9)+j-1)].close;return Math.max(x.high-x.low,Math.abs(x.high-prev),Math.abs(x.low-prev));}),a=trs.reduce((s,x)=>s+x,0)/Math.max(1,trs.length),midpoint=(b[i].high+b[i].low)/2,bu=midpoint+1.5*a,bl=midpoint-1.5*a,prevClose=b[i-1].close;upper=i===1||bu<upper||prevClose>upper?bu:upper;lower=i===1||bl>lower||prevClose<lower?bl:lower;if(direction==="DOWN"&&b[i].close>upper)direction="UP";else if(direction==="UP"&&b[i].close<lower)direction="DOWN";}return direction;})();
  const atrPercentile=(()=>{const windows=[];for(let i=14;i<=trueRanges.length;i++){const a=trueRanges.slice(i-14,i);windows.push(a.reduce((s,x)=>s+x,0)/14);}return windows.length?windows.filter(x=>x<=atrRecent).length/windows.length*100:50;})();
  const choppiness=(()=>{const n=14,rs=trueRanges.slice(-n).reduce((s,x)=>s+x,0),hh=Math.max(...highs.slice(-n)),ll=Math.min(...lows.slice(-n));return hh>ll?100*Math.log10(rs/(hh-ll))/Math.log10(n):50;})();
  const moneyFlow=(()=>{let pos=0,neg=0;for(let i=Math.max(1,b.length-15);i<b.length;i++){const tp=(b[i].high+b[i].low+b[i].close)/3,prev=(b[i-1].high+b[i-1].low+b[i-1].close)/3,flow=tp*b[i].volume;if(tp>prev)pos+=flow;else if(tp<prev)neg+=flow;}return neg===0?100:100-(100/(1+pos/neg));})();
  const adl=b.reduce((v,x)=>v+(x.high===x.low?0:((2*x.close-x.high-x.low)/(x.high-x.low))*x.volume),0);
  const adlSeries=b.map((x,i)=>b.slice(0,i+1).reduce((v,y)=>v+(y.high===y.low?0:((2*y.close-y.high-y.low)/(y.high-y.low))*y.volume),0));
  const chaikinOsc=ema(adlSeries.slice(-40),3)-ema(adlSeries.slice(-40),10);
  const roc=pct(p,closes[Math.max(0,closes.length-11)]);
  const ultimateOsc=(()=>{const bp=[],tr=[];for(let i=1;i<b.length;i++){const prev=b[i-1].close;bp.push(b[i].close-Math.min(b[i].low,prev));tr.push(Math.max(b[i].high,prev)-Math.min(b[i].low,prev));}const avg=n=>{const x=bp.slice(-n),y=tr.slice(-n);return y.reduce((s,v)=>s+v,0)?x.reduce((s,v)=>s+v,0)/y.reduce((s,v)=>s+v,0):.5;};return 100*(4*avg(7)+2*avg(14)+avg(28))/7;})();
  const trix=(()=>{const e1=[],e2=[],e3=[];for(let i=0;i<closes.length;i++){e1.push(ema(closes.slice(0,i+1),15));e2.push(ema(e1,15));e3.push(ema(e2,15));}return pct(e3[e3.length-1],e3[Math.max(0,e3.length-2)]);})();
  const dpo=(()=>{const n=20,offset=Math.floor(n/2)+1,idx=closes.length-1-offset;if(idx<0)return 0;return closes[idx]-ema(closes.slice(0,idx+1),n);})();
  const recentRsi=closes=>rsi(closes,14);
  const rsiSeries=b.slice(-22).map((_,i,arr)=>recentRsi(b.slice(0,Math.max(15,b.length-22+i+1)).map(x=>x.close)));
  const rsiNow=Number(market.indicators?.rsi)||recentRsi(b.map(x=>x.close));
  const rsiWindow=rsiSeries.slice(-14).filter(Number.isFinite);
  const stochRsi=rsiWindow.length&&Math.max(...rsiWindow)!==Math.min(...rsiWindow)?(rsiNow-Math.min(...rsiWindow))/(Math.max(...rsiWindow)-Math.min(...rsiWindow))*100:50;
  const pivot=(range.high+range.low+Number(last.close||p))/3;

  return {
    gemma:{name:"Ichimoku Cloud + Rolling VWAP(20) + Fibonacci + Volume Profile(12-bin proxy)",price:p,ichimoku:{tenkan,kijun,spanA,spanB,priceVsCloud:p>Math.max(spanA,spanB)?"ABOVE":p<Math.min(spanA,spanB)?"BELOW":"INSIDE"},vwap:{value:vwap,priceVsVwap:p>=vwap?"ABOVE":"BELOW"},fibonacci:{r382:range.high-width*.382,r500:range.high-width*.5,r618:range.high-width*.618},volumeProfile},
    glm:{name:"Parabolic SAR + CCI + Williams %R + Aroon",parabolicSAR:{value:sar,direction:up?"UP":"DOWN",priceVsSar:p>=sar?"ABOVE":"BELOW"},cci:{value:cci,period:20},williamsR:williams,aroon},
    openai:{name:"Donchian + Keltner + ATR Squeeze + Choppiness",donchian:dc,keltner:{mid:e20,upper:e20+2*atr,lower:e20-2*atr},position:p>dc.high?"BREAKOUT_UP":p<dc.low?"BREAKOUT_DOWN":p>e20+2*atr?"ABOVE_KELTNER":p<e20-2*atr?"BELOW_KELTNER":"INSIDE_CHANNEL",atrPercentile,choppiness},
    llama:{name:"Supertrend + OBV + MFI + Chaikin Oscillator",supertrend:{atr,ema20:e20,direction:supertrendDirection},obv:{value:obv,recentFlow:obvRecent,direction:obvRecent>0?"UP":obvRecent<0?"DOWN":"FLAT"},moneyFlowIndex:moneyFlow,chaikinOscillator:chaikinOsc},
    qwen:{name:"ROC + Ultimate Oscillator + TRIX + DPO",rateOfChange:roc,ultimateOscillator:ultimateOsc,trix,detrendedPriceOscillator:dpo}
  };
}
function calculateAdvancedIndicatorScore(sets, baseScore, marketIndicators = {}) {
 const clamp=x=>Math.max(-1,Math.min(1,Number.isFinite(Number(x))?Number(x):0));
 const sign=x=>x==="UP"||x==="ABOVE"||x==="BREAKOUT_UP"?1:x==="DOWN"||x==="BELOW"||x==="BREAKOUT_DOWN"?-1:0;
 const g=sets?.gemma||{},l=sets?.glm||{},o=sets?.openai||{},m=sets?.llama||{},q=sets?.qwen||{};
 const tenkan=Number(g.ichimoku?.tenkan),kijun=Number(g.ichimoku?.kijun);
 const ichimokuCross=Number.isFinite(tenkan)&&Number.isFinite(kijun)?Math.sign(tenkan-kijun):0;
 const ich=sign(g.ichimoku?.priceVsCloud)*.65+ichimokuCross*.35;
 const vwapScore=sign(g.vwap?.priceVsVwap),pocScore=sign(g.volumeProfile?.priceVsPoc);
 const fibPrice=Number(g.price),fibMid=Number(g.fibonacci?.r500);
 const fibScore=Number.isFinite(fibPrice)&&Number.isFinite(fibMid)&&fibMid>0?Math.sign(fibPrice-fibMid):0;
 const sar=sign(l.parabolicSAR?.direction),cci=clamp(Number(l.cci?.value)/180),will=clamp((Number(l.williamsR)+50)/50),aroon=clamp((Number(l.aroon?.up)-Number(l.aroon?.down))/100);
 const don=Number.isFinite(Number(g.price))&&Number.isFinite(Number(o.donchian?.high))&&Number.isFinite(Number(o.donchian?.low))
   ? (Number(g.price)>Number(o.donchian.high)?1:Number(g.price)<Number(o.donchian.low)?-1:0) : 0;
 const kel=Number.isFinite(Number(g.price))&&Number.isFinite(Number(o.keltner?.upper))&&Number.isFinite(Number(o.keltner?.lower))
   ? (Number(g.price)>Number(o.keltner.upper)?1:Number(g.price)<Number(o.keltner.lower)?-1:0) : 0;
 const supertrend=sign(m.supertrend?.direction),obv=sign(m.obv?.direction),mfi=clamp((Number(m.moneyFlowIndex)-50)/35),chaikin=Math.sign(Number(m.chaikinOscillator)||0);
 const roc=clamp(Number(q.rateOfChange)/1.5),ultimate=clamp((Number(q.ultimateOscillator)-50)/25),trix=clamp(Number(q.trix)/.15),dpo=clamp(Number(q.detrendedPriceOscillator)/(Math.abs(Number(g.price)||1)*.002));
 // Group related indicators so a cluster of near-duplicates cannot outvote
 // genuinely different evidence (trend, momentum, participation, structure).
 const groups={
   trend:(ich+sar+supertrend+aroon)/4,
   momentum:(cci+will+roc+ultimate+trix+dpo)/6,
   participation:(vwapScore+pocScore+obv+mfi+chaikin)/5,
   structure:(don+kel+fibScore)/3
 };
 const adx=Number(marketIndicators.adx),chop=Number(o.choppiness),atrPct=Number(o.atrPercentile);
 const ranging=(Number.isFinite(chop)&&chop>=61.8)||(Number.isFinite(adx)&&adx<18);
 const lowVolatility=Number.isFinite(atrPct)&&atrPct<10;
 const regime=ranging?"RANGE":lowVolatility?"LOW_VOLATILITY":Number.isFinite(adx)&&adx>=25?"TREND":"MIXED";
 // Regime-adaptive weighting: trend-following evidence dominates clean trends;
 // mean-reversion/momentum and participation gain weight in choppy ranges.
 const groupWeights=ranging
   ? {trend:.14,momentum:.34,participation:.30,structure:.22}
   : regime==="LOW_VOLATILITY"
     ? {trend:.24,momentum:.24,participation:.24,structure:.28}
     : regime==="TREND"
       ? {trend:.42,momentum:.22,participation:.22,structure:.14}
       : {trend:.28,momentum:.26,participation:.25,structure:.21};
 const grouped=Object.entries(groups).reduce((sum,[key,value])=>sum+value*groupWeights[key],0);
 const validGroups=Object.values(groups).filter(Number.isFinite);
 const agreement=validGroups.filter(value=>Math.abs(value)>=.12&&Math.sign(value)===Math.sign(grouped)).length;
 const disagreement=validGroups.filter(value=>Math.abs(value)>=.25&&Math.sign(value)!==Math.sign(grouped)).length;
 // In uncertain/ranging regimes, suppress directional scores rather than
 // forcing oscillators to invent a LONG/SHORT edge.
 const regimeFactor=(ranging?.58:1)*(lowVolatility?.78:1)*(disagreement>=2?.78:1);
 const combined=clamp(clamp(baseScore)*.46+grouped*.54);
 const score=clamp(combined*regimeFactor);
 const entryThreshold=ranging?.76:lowVolatility?.74:regime==="TREND"?.60:.68;
 return {score,advancedScore:grouped,regimeFactor,entryThreshold,regime,agreement,disagreement,groups,groupWeights,
   components:{ichimoku:ich,vwap:vwapScore,volumeProfile:pocScore,fibonacci:fibScore,parabolicSar:sar,cci,williamsR:will,aroon,donchian:don,keltner:kel,supertrend,obv,mfi,chaikin,roc,ultimateOscillator:ultimate,trix,dpo,choppiness:Number.isFinite(chop)?chop:null,atrPercentile:Number.isFinite(atrPct)?atrPct:null,adx:Number.isFinite(adx)?adx:null}};
}

function buildThirtyMinuteCandles(data) {
  // Use only the native 30m candle feed; shorter intervals are not supported.
  const native = (data.candles?.["30m"] || [])
    .filter(c => c && c.confirmed === true && [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) && c.close > 0)
    .sort((a,b) => a.time - b.time);
  if (native.length >= 30) return native;
  return native;
}

function buildFourHourCandles(data) {
  const native = (data.candles?.["4h"] || []).filter(c => c.confirmed && [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.close > 0).sort((a,b) => a.time - b.time);
  if (native.length >= 30) return native;
  const source = (data.candles?.["1h"] || []).filter(c => c.confirmed && [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.close > 0).sort((a,b) => a.time - b.time);
  const buckets = new Map();
  for (const candle of source) {
    const bucket = Math.floor(candle.time / 14400000) * 14400000;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(candle);
  }
  return [...buckets.entries()].sort((a,b) => a[0] - b[0]).flatMap(([time, rows]) => {
    rows.sort((a,b) => a.time - b.time);
    if (rows.length !== 4 || rows.some((c,i) => i > 0 && c.time - rows[i-1].time !== 3600000)) return [];
    return [{ time, open: rows[0].open, high: Math.max(...rows.map(c=>c.high)), low: Math.min(...rows.map(c=>c.low)), close: rows[3].close, volume: rows.reduce((sum,c)=>sum + (Number(c.volume)||0),0), confirmed: true }];
  });
}

function buildFourHourContext(data) {
  const native = (data.candles?.["4h"] || []).filter(c => c.confirmed && [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) && c.close > 0 && c.volume >= 0).sort((a,b) => a.time - b.time);
  // Higher-timeframe structure must also use one uninterrupted candle segment.
  const nativeSegmentStart = native.reduce((start,c,i) => i>0 && c.time-native[i-1].time!==INTERVALS["4h"] ? i : start,0);
  const continuousNative = native.slice(nativeSegmentStart);
  const source = continuousNative.length >= 50 ? [] : (data.candles?.["1h"] || []).filter(c => c.confirmed && [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) && c.close > 0 && c.volume >= 0).sort((a,b) => a.time - b.time);
  const buckets = new Map();
  for (const candle of source) {
    const bucket = Math.floor(candle.time / 14400000) * 14400000;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(candle);
  }
  const aggregatedBars = [...buckets.entries()].sort((a,b) => a[0] - b[0]).flatMap(([time, rows]) => {
    rows.sort((a,b) => a.time - b.time);
    if (rows.length !== 4 || rows.some((c,i) => i > 0 && c.time - rows[i-1].time !== 3600000)) return [];
    return [{ time, open: rows[0].open, high: Math.max(...rows.map(c=>c.high)), low: Math.min(...rows.map(c=>c.low)), close: rows[3].close, volume: rows.reduce((sum,c)=>sum + (Number(c.volume)||0),0) }];
  });
  const aggregateSegmentStart=aggregatedBars.reduce((start,c,i)=>i>0&&c.time-aggregatedBars[i-1].time!==INTERVALS["4h"]?i:start,0);
  const continuousAggregated=aggregatedBars.slice(aggregateSegmentStart);
  const bars = continuousNative.length >= 50 ? continuousNative : continuousAggregated;
  if (bars.length < 50) return { timeframe: "4h", signal: "WAIT", available: false, warning: "৪ ঘণ্টার পর্যাপ্ত সম্পূর্ণ ক্যান্ডেল নেই" };
  const closes = bars.map(c=>c.close), last = bars[bars.length-1];
  const ema20 = ema(closes.slice(-80),20), ema50 = ema(closes.slice(-100),50), strength = rsi(closes,14);
  const prior = bars.slice(-21,-1), support = Math.min(...prior.map(c=>c.low)), resistance = Math.max(...prior.map(c=>c.high));
  const supportBreakdown = last.close < support * 0.998, resistanceBreakout = last.close > resistance * 1.002;
  const recent = bars.slice(-5), previous = bars.slice(-10,-5);
  const lowerStructure = Math.max(...recent.map(c=>c.high)) < Math.max(...previous.map(c=>c.high)) && Math.min(...recent.map(c=>c.low)) < Math.min(...previous.map(c=>c.low));
  const higherStructure = Math.max(...recent.map(c=>c.high)) > Math.max(...previous.map(c=>c.high)) && Math.min(...recent.map(c=>c.low)) > Math.min(...previous.map(c=>c.low));
  const averageVolume = prior.reduce((sum,c)=>sum+(Number(c.volume)||0),0) / Math.max(1,prior.length);
  const relativeVolume = averageVolume > 0 ? last.volume / averageVolume : null;
  const confirmedSupportBreakdown = supportBreakdown && relativeVolume !== null && relativeVolume >= 1.15;
  const confirmedResistanceBreakout = resistanceBreakout && relativeVolume !== null && relativeVolume >= 1.15;
  const bearish = ema20 < ema50 && last.close < ema20 && strength < 50;
  const bullish = ema20 > ema50 && last.close > ema20 && strength > 50;
  const warnings = [];
  if (ema20 < ema50) warnings.push("৪ ঘণ্টায় EMA20, EMA50-এর নিচে: বড় প্রবণতা দুর্বল");
  if (last.close < ema20 && strength < 45) warnings.push("৪ ঘণ্টায় দাম EMA20-এর নিচে এবং RSI দুর্বল");
  if (supportBreakdown) warnings.push(confirmedSupportBreakdown ? "৪ ঘণ্টার সাপোর্ট ভেঙেছে এবং ভলিউমও বেড়েছে" : "৪ ঘণ্টার সাপোর্টের নিচে; ভলিউম নিশ্চিতকরণ দুর্বল");
  if (lowerStructure) warnings.push("৪ ঘণ্টায় lower-high ও lower-low কাঠামো তৈরি হচ্ছে");
  if (higherStructure) warnings.push("৪ ঘণ্টায় higher-high ও higher-low কাঠামো তৈরি হচ্ছে");
  if (ema20 > ema50 && last.close > ema20 && strength > 55) warnings.push("৪ ঘণ্টায় ঊর্ধ্বমুখী প্রবণতার সমর্থন আছে");
  if (resistanceBreakout) warnings.push("সাম্প্রতিক ৪ ঘণ্টার রেজিস্ট্যান্স অতিক্রম করেছে");
  return { timeframe: "4h", available: true, signal: bearish || confirmedSupportBreakdown || (lowerStructure && ema20 < ema50) ? "SHORT" : bullish || resistanceBreakout ? "LONG" : "WAIT", ema20, ema50, rsi: strength, close: last.close, support, resistance, supportBreakdown, confirmedSupportBreakdown, resistanceBreakout, confirmedResistanceBreakout, relativeVolume, lowerStructure, higherStructure, bearishWarning: ema20 < ema50 || (last.close < ema20 && strength < 45) || lowerStructure, bullishWarning: ema20 > ema50 || (last.close > ema20 && strength > 55) || higherStructure, warnings, candleTime: new Date(last.time + 14400000).toISOString() };
}

function parseModelJson(output) {
  let raw = typeof output === "string" ? output : null;
  if (raw == null && output && typeof output === "object") {
    raw = output.response ?? output.generated_text ?? output.output_text ?? output.text ?? null;
    if (raw == null && output.result != null) {
      raw = typeof output.result === "string" ? output.result
        : (output.result.response ?? output.result.generated_text ?? output.result.text ?? output.result.content ?? null);
    }
    if (raw == null && output.choices?.[0]?.message) raw = output.choices[0].message.content;
    if (raw == null && output.content != null) raw = output.content;
  }
  if (Array.isArray(raw)) raw = raw.map(part => typeof part === "string" ? part : part && (part.text || part.content) || "").join("");
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.decision) return validateReviewerAnswer(raw);
    raw = raw.choices?.[0]?.message?.content || raw.response || raw.text || raw.content || raw.generated_text || "";
  }
  if (typeof raw !== "string" || !raw.trim()) {
    const keys = output && typeof output === "object" ? Object.keys(output).join(",") : typeof output;
    throw new Error("Cloudflare AI returned empty/unsupported response (" + keys.slice(0,100) + ")");
  }
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<\|(?:im_start|im_end|fim_prefix|fim_middle|fim_suffix|ghissue|ghreview)\|>/g, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("Cloudflare AI returned no JSON object: " + cleaned.slice(0,100));
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) {
    // Salvage a truncated response only when decision and reason are present.
    const decisionMatch = cleaned.match(/"decision"\s*:\s*"(LONG|SHORT|WAIT)"/i);
    const reasonMatch = cleaned.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)/i);
    if (decisionMatch && reasonMatch) {
      let reason = reasonMatch[1];
      try { reason = JSON.parse('"' + reason.replace(/\\$/, "") + '"'); }
      catch (_) { reason = reason.replace(/\\(["\\])/g, "$1"); }
      if (reason.trim()) {
        const riskMatch = cleaned.match(/"risk"\s*:\s*"((?:\\.|[^"\\])*)/i);
        let risk = "সিগন্যাল ভুল হতে পারে; বড় টাইমফ্রেম ও ইনভ্যালিডেশন নিশ্চিত না হলে ট্রেড নয়।";
        if (riskMatch) {
          try { risk = JSON.parse('"' + riskMatch[1].replace(/\\$/, "") + '"'); } catch (_) {}
        }
        return validateReviewerAnswer({decision:decisionMatch[1],reason,risk});
      }
    }
    throw new Error("Cloudflare AI returned incomplete JSON: " + cleaned.slice(0,100));
  }
  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
  catch (_) { throw new Error("Cloudflare AI returned malformed JSON"); }
  return validateReviewerAnswer(parsed);
}

function validateReviewerAnswer(parsed) {
  const decision = String(parsed && (parsed.decision || parsed.signal || parsed.recommendation) || "").trim().toUpperCase();
  const reasonValue = parsed && (parsed.reason || parsed.rationale || parsed.summary || parsed.explanation);
  const reason = typeof reasonValue === "string" ? reasonValue.trim() : "";
  const riskValue = parsed && (parsed.risk || parsed.riskWarning || parsed.caution);
  const risk = typeof riskValue === "string" && riskValue.trim()
    ? riskValue.trim()
    : "সিগন্যাল ভুল হতে পারে; বড় টাইমফ্রেম ও ইনভ্যালিডেশন নিশ্চিত না হলে ট্রেড নয়।";
  if (!["LONG","SHORT","WAIT"].includes(decision) || !reason) {
    throw new Error("Cloudflare AI answer failed validation");
  }
  const confidenceRaw = Number(parsed?.confidenceScore ?? parsed?.confidence ?? 50);
  const confidenceScore = Number.isFinite(confidenceRaw) ? Math.max(0,Math.min(100,Math.round(confidenceRaw))) : 50;
  return { decision, confidenceScore, reason: reason.slice(0, 500), risk: risk.slice(0, 500) };
}

const TRADING_FRAMEWORK_BN = `
ট্রেডিং জ্ঞান ও বাধ্যতামূলক বিশ্লেষণ-পদ্ধতি:
১) বাজারের অবস্থা আগে শ্রেণিবদ্ধ করো: uptrend, downtrend, range, breakout, pullback, নাকি high-volatility/choppy market। প্রতিটি অবস্থায় একই কৌশল প্রয়োগ করবে না।
২) Market structure: swing high/low, higher-high/higher-low, lower-high/lower-low, support/resistance এবং breakout-এর পর retest যাচাই করো। শুধু একটি candle বা wick-কে breakout ধরবে না; candle close ও volume confirmation দেখো।
৩) Multi-timeframe: ৪ ঘণ্টা = প্রধান trend/context, ১ ঘণ্টা = intermediate structure, ৩০ মিনিট = entry timing। ১ ঘণ্টা ও ৪ ঘণ্টার বিপরীত সংকেত থাকলে ঝুঁকির সতর্কতা দাও; ৪ ঘণ্টার প্রবল বিপরীত trend হলে confidence কমাও এবং risk স্পষ্ট করো।
৪) Indicator-গুলোকে আলাদা ভোটের মতো গুনবে না। EMA trend, MACD momentum, RSI momentum/overbought-oversold context, ADX trend strength, Bollinger volatility/mean-reversion context, relative volume confirmation—এগুলো একই price action-এর সম্পর্কিত প্রমাণ। নতুন VWAP অবস্থান, ROC(3/9) momentum, Donchian breakout এবং candle pressure-ও দেখবে; এগুলোকে একক price-action confirmation family হিসেবে বিবেচনা করবে, একই তথ্যকে বারবার double-count করবে না। VWAP-এর ওপরে থাকা একা LONG নয়; Donchian breakout-এ candle close ও volume না মিললে false breakout ঝুঁকি উল্লেখ করবে।
৫) Derivatives: open interest বাড়া/কমা, long-short ratio, funding এবং orderbook imbalance-কে context হিসেবে দেখো; এগুলো একা price direction নিশ্চিত করে না। crowded positioning হলে squeeze/liq risk উল্লেখ করো।
৬) LONG-এর পক্ষে: structure ও higher timeframe bullish, price/EMA trend সহায়ক, momentum ও volume confirmation আছে, resistance-এর ঠিক নিচে late entry নয়, এবং invalidation level যুক্তিসঙ্গত।
৭) SHORT-এর পক্ষে: structure ও higher timeframe bearish, lower-high/lower-low বা confirmed support breakdown, momentum ও volume সহায়ক, support-এর একেবারে কাছে late entry নয়, এবং invalidation level যুক্তিসঙ্গত।
৮) WAIT কেবল তখনই দেবে যখন প্রমাণ সত্যিই দ্বিধাবিভক্ত/সমতল, market range/chop, data missing/stale, অথবা কোনো দিকেই গ্রহণযোগ্য setup নেই। ৪টি নিজস্ব indicator-এর মধ্যে অন্তত ৩টি একই দিক দেখালে এবং বিপরীত প্রমাণ দুর্বল হলে সেই দিকের LONG/SHORT bias দেবে; নিখুঁত নিশ্চয়তা না থাকার কারণে WAIT করবে না। দুর্বল/মাঝারি সংকেত হলে ঝুঁকি স্পষ্ট করবে, কিন্তু সিদ্ধান্ত এড়িয়ে যাবে না।
৯) Risk management: আগে trade invalidation কোথায় হবে তা ভাবো; stop-loss ছাড়া trade নয়। সম্ভাব্য reward যদি সম্ভাব্য risk-এর তুলনায় যথেষ্ট না হয় তবে WAIT। leverage, position size বা নিশ্চিত লাভের দাবি বানাবে না। ATR/volatility বেশি হলে risk বাড়ে।
১০) সিদ্ধান্ত দেওয়ার আগে বিপরীত দিকের সবচেয়ে শক্তিশালী যুক্তি খোঁজো (pre-mortem)। নিজের প্রাথমিক মত ভুল প্রমাণ করতে পারে—এমন ডেটা স্পষ্টভাবে বিবেচনা করো।
১১) কেবল সরবরাহ করা ডেটা ব্যবহার করো। সংবাদ, liquidation map, funding, open interest, support বা price level দেওয়া না থাকলে সেগুলো আছে বলে দাবি করবে না। কোনো সংখ্যা অনুমান করবে না।
১২) confidence score বা win-rate বানাবে না। সিদ্ধান্তের সঙ্গে সংক্ষিপ্ত evidence এবং সবচেয়ে বড় risk উল্লেখ করো। অতীতের performance feedback ছোট sample হলে সেটিকে দুর্বল ইঙ্গিত হিসেবে ধরো, নিশ্চয়তা হিসেবে নয়।
`; 

async function runCloudflareAgent(env, model, role, instructions, symbol, tf, market, specialistIndicators) {
  const compactMarket = {
    intradayMovement:market.intradayMovement||null,
    source:market.source,
    ticker:{last:market.ticker?.last,mark:market.ticker?.mark,bid:market.ticker?.bid,ask:market.ticker?.ask,volume24h:market.ticker?.volume24h,openInterest:market.ticker?.openInterest,fundingRate:market.ticker?.fundingRate},
    indicators:market.indicators,
    formingCandle:market.formingCandle || null,
    specialistIndicators,
    higherTimeframe:market.higherTimeframe,
    riskEngine:market.riskEngine,
    derivatives:market.derivatives ? {
      openInterest:Array.isArray(market.derivatives.openInterest)?market.derivatives.openInterest.slice(-3):[],
      longShort:Array.isArray(market.derivatives.longShort)?market.derivatives.longShort.slice(-3):[],
      orderbook:{bids:Array.isArray(market.derivatives.orderbook?.bids)?market.derivatives.orderbook.bids.slice(0,5):[],asks:Array.isArray(market.derivatives.orderbook?.asks)?market.derivatives.orderbook.asks.slice(0,5):[]},
      fundingHistory:Array.isArray(market.derivatives.fundingHistory)?market.derivatives.fundingHistory.slice(-3):[]
    }:null,
    recentCandles:(market.candles||[]).slice(-40).map((c,i,a)=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume,changePct:i>0&&Number(a[i-1].close)>0?Number(((c.close/a[i-1].close-1)*100).toFixed(4)):null,direction:i>0?(c.close>a[i-1].close?"UP":c.close<a[i-1].close?"DOWN":"FLAT"):"BASE"})),
    candleCloseTime:market.candleCloseTime,
    timeframe:tf
  };
  const messages=[
    {role:"system",content:"তুমি স্বাধীন "+role+" ট্রেডিং বিশ্লেষক। অন্য AI-এর মতামত দেখবে না এবং তাদের সঙ্গে ঐকমত্য করার চেষ্টা করবে না। তোমার কাজ হলো এই নির্দিষ্ট "+tf+" টাইমফ্রেমে এখনকার বাজার দেখে বাধ্যতামূলকভাবে একটি দিক বেছে নেওয়া: LONG অথবা SHORT। WAIT তোমার স্বাভাবিক উত্তর নয়; ডেটা যথেষ্ট থাকলে দুই দিকের যুক্তি তুলনা করে যেদিকে প্রমাণ তুলনামূলক বেশি, সেই দিকেই ভোট দাও। কোনো দিকের প্রমাণ দুর্বল হলে সেটিও গোপন করবে না—reason-এ দুর্বলতা লিখবে এবং confidence ৫০-এর নিচে রাখবে। কেবল ডেটা অনুপস্থিত/অবৈধ বা বাজারের তথ্য বিশ্লেষণ-অযোগ্য হলে WAIT দিতে পারবে। কোনো indicator value বা market data বানাবে না। প্রথমে timeframe অনুযায়ী trend/structure, তারপর নিজের চারটি indicator, volume/volatility, support-resistance ও invalidation যাচাই করো; LONG ও SHORT উভয় সম্ভাবনার বিরুদ্ধে যুক্তি পরীক্ষা করে শেষে একটি দিক নির্বাচন করো। intradayMovement-এ আজকের UTC দিনের শুরু থেকে বর্তমান সময় পর্যন্ত ৫-মিনিট ক্যান্ডেল UTC ঘণ্টা অনুযায়ী সাজানো আছে; hourly-এর time/endTime ও changePct দেখে কোন ঘণ্টায় দাম উঠেছে/নেমেছে; segments-এর startTime/endTime/durationMinutes/changePct দেখে সুনির্দিষ্ট ওঠা-নামার সময়সীমা শনাক্ত করবে এবং strongestRiseSegment/strongestFallSegment উল্লেখ করবে। completeWindow false হলে ডেটার ঘাটতি স্পষ্ট করবে। recentCandles-এর প্রতিটি time UTC millisecond timestamp; এগুলোকে সময়ক্রমে বিশ্লেষণ করে কোন সময়/ক্যান্ডেলে দাম বেড়েছে, কোন সময়/ক্যান্ডেলে কমেছে, পরিবর্তনের শতাংশ, ধারাবাহিক higher-high/higher-low বা lower-high/lower-low, breakout, reversal ও volume confirmation নির্দিষ্ট করে বলবে। শুধু শেষ দামের ভিত্তিতে সিদ্ধান্ত নয়—সর্বশেষ ৪০টি সম্পূর্ণ ক্যান্ডেলের price path বিচার করবে। formingCandle থাকলে সেটি চলমান, এখনো বন্ধ হয়নি—এটিকে আগাম সতর্কতা হিসেবে বিবেচনা করো, নিশ্চিত ক্যান্ডেল বলে দাবি করো না; ticker ও formingCandle-এর দিক/ভলিউম মিলিয়ে দেখো। "+TRADING_FRAMEWORK_BN+" তোমার বিশেষ দায়িত্ব: "+instructions+" উত্তর অবশ্যই একটি সম্পূর্ণ JSON object হবে, কোনো ভূমিকা বা markdown নয়; decision অবশ্যই LONG অথবা SHORT (শুধু অযোগ্য ডেটায় WAIT), confidenceScore 0-100 পূর্ণসংখ্যা: {\"decision\":\"LONG|SHORT|WAIT\",\"confidenceScore\":65,\"reason\":\"বাংলায় সংক্ষিপ্ত কিন্তু নির্দিষ্ট যুক্তি\",\"risk\":\"বাংলায় ঝুঁকি ও কোন দামে/কোন শর্তে মত ভুল হবে\"}."},
    {role:"user",content:JSON.stringify({symbol,timeframe:tf,market:compactMarket})}
  ];
  const models=[model].filter(Boolean); // No same-model fallback: each analyst must remain genuinely independent. Each reviewer must give its best evidence-based directional view; WAIT only when neither side has a real edge.
  const failures=[];
  for(const selectedModel of models){
    try{
      const output=await env.AI.run(selectedModel,{messages,max_tokens:512,temperature:0});
      return {agent:role,model:selectedModel,...parseModelJson(output)};
    }catch(error){failures.push(selectedModel+": "+String(error?.message||error).slice(0,140));}
  }
  throw new Error("সব Cloudflare বিশ্লেষক মডেল ব্যর্থ: "+failures.join(" | "));
}


async function runIndependentAnalysts(env, symbol, tf, market) {
  if (!env.AI || typeof env.AI.run !== "function") throw new Error("Workers AI binding AI is not configured");
  const sets=market.agentIndicatorSets || calculateAgentIndicatorSets(market);
  const analysts=[
    {model:"@cf/google/gemma-4-26b-a4b-it",role:"Gemma 4 · Ichimoku/VWAP/Fibonacci/Volume Profile",key:"gemma",instructions:"তোমার নিজস্ব চারটি indicator-ই ব্যবহার করো: Ichimoku Cloud trend, VWAP fair-value position, Fibonacci retracement levels এবং Volume Profile POC/value area। অন্য specialist-এর indicator বা মূল engine-এর RSI/EMA/MACD/ADX/BB-কে ভোট হিসেবে গণনা করবে না।"},
    {model:"@cf/zai-org/glm-4.7-flash",role:"GLM 4.7 · Parabolic SAR/CCI/Williams %R/Aroon",key:"glm",instructions:"তোমার নিজস্ব চারটি indicator-ই ব্যবহার করো: Parabolic SAR trend flip, CCI momentum/extreme, Williams %R close-location momentum এবং Aroon trend age/direction। অন্য specialist-এর indicator বা মূল engine-এর RSI/EMA/MACD/ADX/BB-কে ভোট হিসেবে গণনা করবে না।"},
    {model:"@cf/openai/gpt-oss-20b",role:"GPT OSS · Donchian/Keltner/ATR Squeeze/Choppiness",key:"openai",instructions:"তোমার নিজস্ব চারটি indicator-ই ব্যবহার করো: Donchian breakout/channel, Keltner volatility envelope, ATR percentile squeeze/expansion এবং Choppiness Index trend-vs-range। অন্য specialist-এর indicator বা মূল engine-এর RSI/EMA/MACD/ADX/BB-কে ভোট হিসেবে গণনা করবে না।"},
    {model:"@cf/meta/llama-3.3-70b-instruct-fp8-fast",role:"Llama 3.3 · Supertrend/OBV/MFI/Chaikin Oscillator",key:"llama",instructions:"তোমার নিজস্ব চারটি indicator-ই ব্যবহার করো: ATR Supertrend trend, OBV volume confirmation, Money Flow Index buying/selling pressure এবং Chaikin Oscillator accumulation/distribution momentum। অন্য specialist-এর indicator বা মূল engine-এর RSI/EMA/MACD/ADX/BB-কে ভোট হিসেবে গণনা করবে না।"},
    {model:"@cf/qwen/qwen3.8-27b",role:"Qwen 3.8.8 · ROC/Ultimate Oscillator/TRIX/DPO",key:"qwen",instructions:"তোমার নিজস্ব চারটি indicator-ই ব্যবহার করো: Rate of Change momentum, Ultimate Oscillator multi-period buying pressure, TRIX smoothed momentum এবং Detrended Price Oscillator cycle deviation। অন্য specialist-এর indicator বা মূল engine-এর RSI/EMA/MACD/ADX/BB-কে ভোট হিসেবে গণনা করবে না।"}
  ];
  const settled=await Promise.allSettled(analysts.map(a=>
    runCloudflareAgent(env,a.model,a.role,a.instructions,symbol,tf,market,sets[a.key])
  ));
  const opinions=settled.flatMap((item,index)=>item.status==="fulfilled"?[{...item.value,indicators:analysts[index].key?sets[analysts[index].key]:null}]:[]);
  const errors=settled.flatMap((item,index)=>item.status==="rejected"
    ?[{agent:analysts[index].role,error:String(item.reason).slice(0,220)}]:[]);
  const unique=new Set();
  const independentOpinions=opinions.filter(o=>{
    const id=String(o.model||"").trim();
    if(!id||unique.has(id))return false;
    unique.add(id);return true;
  });
  return {
    opinions:independentOpinions,
    independentOpinions,
    errors,
    status:independentOpinions.length>=3?"ANALYSTS_COMPLETE":"ANALYSTS_INSUFFICIENT",
    analystCount:independentOpinions.length,
    judge:null,
    judgeError:null
  };
}
function recommendedDurationMinutes(market, confidenceScore) {
  const tf = market.timeframe || "30m";
  const base = {"30m":30,"1h":60,"4h":240}[tf] || 30;
  let multiplier = confidenceScore >= 88 ? 3 : confidenceScore >= 78 ? 2 : 1;
  const price = Number(market.ticker?.last);
  const atr = Number(market.indicators?.atr);
  const atrPct = price > 0 && Number.isFinite(atr) ? atr / price : 0;
  // Higher-than-usual volatility shortens the suggested review horizon.
  if (atrPct > 0.012) multiplier = 1;
  else if (atrPct > 0.006) multiplier = Math.min(multiplier, 2);
  return Math.max(base, Math.round(base * multiplier));
}

function finalDecision(market, council) {
  const opinions = council.opinions || [];
  // Count only unique, successfully responding independent model analysts.
  const rawIndependentOpinions = council.independentOpinions || opinions;
  // Never count the same underlying model twice (for example, a fallback GLM
  // answering both the Gemma and GLM specialist prompts).
  const seenModels = new Set();
  const independentOpinions = rawIndependentOpinions.filter(opinion => {
    const identity = String(opinion.model || opinion.agent || "").trim();
    if (!identity || seenModels.has(identity)) return false;
    seenModels.add(identity);
    return true;
  });
  const counts = { LONG:0, SHORT:0, WAIT:0 };
  for (const opinion of independentOpinions) if (counts[opinion.decision] !== undefined) counts[opinion.decision]++;
  const valid = independentOpinions.length;
  const ranked = ["LONG","SHORT"].sort((a,b)=>counts[b]-counts[a]);
  const candidate = ranked[0], opposing = ranked[1];
  const margin = counts[candidate] - counts[opposing];
  // With only two independent analysts, one clear
  // directional vote plus one WAIT may proceed only if technical, higher-TF,
  // market-data and hard-risk checks all independently confirm it. Opposing
  // LONG/SHORT votes still produce WAIT. Three or more reviewers need majority.
  const requiredVotes = Math.floor(valid / 2) + 1;
  const technical = market.indicators.technicalSignal;
  const score = Number(market.indicators.technicalScore) || 0;
  const technicalSupports = candidate === "LONG" ? score >= 0.18 : score <= -0.18;
  // Require directional agreement from every higher timeframe:
  // 30m entries use 1h/4h context; 1h setups use 4h trend.
  const higher = market.higherTimeframe || {};
  const fastTimeframe = market.timeframe === "30m";
  const requiredHigherSignals = higher.requiredSignals || (higher.timeframe === "1h" ? [higher.signal, higher.fourHour?.signal] : [higher.signal]);
  // WAIT/neutral on a higher timeframe is not automatically a veto; only an explicit opposite trend blocks an entry.
  const oppositeSignal = candidate === "LONG" ? "SHORT" : "LONG";
  // Fast and intraday setups are primarily checked against 1h structure.
  // 4h context remains important for 1h/4h decisions, but missing 4h data
  // must not silently veto every short-term opportunity.
  const strongestHigherSignal = fastTimeframe
    ? (higher.oneHourSignal || (requiredHigherSignals.length > 1 ? requiredHigherSignals[1] : higher.signal))
    : (higher.fourHour?.signal || higher.signal || (requiredHigherSignals.length ? requiredHigherSignals[requiredHigherSignals.length - 1] : "WAIT"));
  // Higher-timeframe opposition is a caution; the 4h context remains the primary risk filter.
  const higherAligned = Boolean(strongestHigherSignal) && strongestHigherSignal !== oppositeSignal;
  const lowerTimeframeConflict = requiredHigherSignals.some(signal => signal === oppositeSignal) && !higherAligned;
  // Broad 4h trend warnings are context, not automatic vetoes for intraday reversals.
  // Fast entries are blocked only by a volume-confirmed 4h structural break.
  const hardRisk = fastTimeframe
    ? (candidate === "LONG" ? market.riskEngine?.confirmedSupportBreakdown === true : market.riskEngine?.confirmedResistanceBreakout === true)
    : (candidate === "LONG"
      ? (market.riskEngine?.confirmedSupportBreakdown === true || market.riskEngine?.bearishWarning === true)
      : (market.riskEngine?.confirmedResistanceBreakout === true || market.riskEngine?.bullishWarning === true));
  const enough = counts[candidate] >= requiredVotes && margin >= 1 && candidate !== "WAIT";
  // Directional decisions must depend on verified market data, not on Gemini being online.
  // Gemini is an optional vote; its outage must not permanently force WAIT when the
  // Cloudflare analysts and the optional Gemini vote are counted separately.
  const candleData = Array.isArray(market.candles) ? market.candles : [];
  const tickerPrice = Number(market.ticker?.last);
  const fourHourContext = market.higherTimeframe?.fourHour;
  const dataQualityGood = Boolean(
    market.source &&
    Number.isFinite(tickerPrice) && tickerPrice > 0 &&
    candleData.length >= 30 &&
    candleData.every(c => [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.close > 0) &&
    (fastTimeframe
      ? Boolean(higher.oneHourSignal || requiredHigherSignals.some(x => x === "LONG" || x === "SHORT" || x === "WAIT"))
      : fourHourContext?.available === true)
  );
  const enoughIndependentReviewers = valid >= 3;
  // Directional confidence is an evidence score, NOT a win probability.
  // 60 points: independent AI vote share; 25: technical engine strength; 15: 4h context.
  const votePoints = valid ? (counts[candidate] / valid) * 60 : 0;
  const technicalPoints = technicalSupports ? Math.min(25, Math.abs(score) / 0.50 * 25) : 0;
  const higherPoints = higherAligned ? 15 : 0;
  const confidenceScore = Math.round(votePoints + technicalPoints + higherPoints);
  const confidencePass = confidenceScore >= 70;
  const strongEnough = enoughIndependentReviewers && enough && confidencePass && technicalSupports && higherAligned && !hardRisk && dataQualityGood;
  if (strongEnough) {
    const durationMinutes = recommendedDurationMinutes(market, confidenceScore);
    return {
      decision:candidate,
      direction:candidate==="LONG"?"UPWARD":"DOWNWARD",
      confidenceScore,
      confidenceLabel:"দিকনির্দেশক আত্মবিশ্বাস; লাভের সম্ভাবনা নয়",
      durationMinutes,
      reason:"স্বতন্ত্র AI ভোটে " + counts[candidate] + "/" + valid + " " + candidate + " সমর্থন করেছে; সমন্বিত দিকনির্দেশক স্কোর " + confidenceScore + "% (ন্যূনতম ৭০%)।" + (lowerTimeframeConflict ? " তবে ছোট টাইমফ্রেমে বিপরীত সংকেত থাকায় সতর্কতা প্রয়োজন।" : ""),
      risk:(lowerTimeframeConflict ? "১৫মি/১ঘণ্টার কিছু সংকেত বিপরীত; দ্রুত invalid হতে পারে। " : "") + "দ্রুত মূল্য পরিবর্তন, স্লিপেজ ও নির্ধারিত invalidation অতিক্রমের ঝুঁকি রয়েছে।",
      dataQuality:"GOOD"
    };
  }
  let why = !enoughIndependentReviewers ? "কমপক্ষে তিনটি স্বতন্ত্র AI মডেলের মতামত পাওয়া যায়নি"
    : counts[candidate] < requiredVotes || margin < 1 ? "AI মতামতে সংখ্যাগরিষ্ঠতা নেই"
    : !technicalSupports ? "নিজস্ব টেকনিক্যাল ইঞ্জিন প্রস্তাবিত দিক সমর্থন করছে না"
    : !higherAligned ? "বড় টাইমফ্রেমে বিপরীত সংকেত রয়েছে"
    : hardRisk ? "গুরুত্বপূর্ণ সাপোর্ট/রেজিস্ট্যান্স ঝুঁকি বিপরীত"
    : !dataQualityGood ? "যাচাইকৃত বাজার ডেটা বা ৪ ঘণ্টার প্রেক্ষাপট অপর্যাপ্ত"
    : "নিরাপদ সিদ্ধান্তের শর্ত পূরণ হয়নি";
  return {
    decision:"WAIT",
    direction:technical==="LONG"?"UPWARD":technical==="SHORT"?"DOWNWARD":"SIDEWAYS",
    directionalBias:candidate==="LONG"||candidate==="SHORT"?candidate:(technical==="LONG"||technical==="SHORT"?technical:"NO_CLEAR_EDGE"),
    confidenceScore,
    confidenceLabel:"দিকনির্দেশক আত্মবিশ্বাস; লাভের সম্ভাবনা নয়",
    reason:"স্বাধীন AI ভোট: LONG " + counts.LONG + ", SHORT " + counts.SHORT + ", WAIT " + counts.WAIT + " — দিকনির্দেশক স্কোর " + confidenceScore + "%; সিদ্ধান্তের জন্য ৭০% প্রয়োজন। " + why + "।",
    risk:"স্বাধীন বিশ্লেষকদের মধ্যে যথেষ্ট সমর্থন না থাকলে ট্রেড এড়িয়ে চলুন।",
    dataQuality:dataQualityGood?"GOOD":"LIMITED"
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

async function runScheduledOne(env, symbol, tf, marketData) {
  if (!env.ANALYSIS_KV) throw new Error("ANALYSIS_KV binding is missing");
  if (!marketData || marketData.__fetchError) throw new Error(marketData?.__fetchError || "Scheduled market snapshot unavailable");
  // Reuse one validated market snapshot for every timeframe in this cron run.
  return await runOne(env, symbol, tf, { persist: false, marketData });
}

async function persistLatestSnapshot(env, symbol, result) {
  const key = "latest:" + symbol;
  let snapshot = {};
  try { snapshot = await env.ANALYSIS_KV.get(key, "json") || {}; }
  catch (_) { snapshot = {}; }
  snapshot[result.timeframe] = result;
  snapshot.updatedAt = new Date().toISOString();
  snapshot.storagePolicy = "batched-scheduler";
  await env.ANALYSIS_KV.put(key, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 90 });
}

function shouldRunAiCouncil(market) {
  const ind = market.indicators || {};
  const score = Number(ind.technicalScore) || 0;
  const priceAction = Number(ind.priceActionBias) || 0;
  const adx = Number(ind.adx) || 0;
  const roc3 = Number(ind.roc3) || 0;
  const breakout = Math.abs(Number(ind.donchianBias) || 0) >= 0.65;
  // Always review a clear technical signal. Earlier directional setups also
  // qualify when momentum/structure confirms; neutral chop does not consume 5 AI calls.
  if (ind.technicalSignal === "LONG" || ind.technicalSignal === "SHORT") {
    return { review: true, reason: "প্রাথমিক টেকনিক্যাল সিগন্যাল তৈরি হয়েছে" };
  }
  const directional = Math.abs(score) >= 0.28;
  const confirmation = adx >= 16 || Math.abs(roc3) >= 0.12 || breakout || Math.abs(priceAction) >= 0.38;
  if (directional && confirmation) {
    return { review: true, reason: "প্রাথমিক দিকনির্দেশক স্কোর ও মোমেন্টাম/ব্রেকআউট নিশ্চিতকরণ আছে" };
  }
  return { review: false, reason: "প্রাথমিক স্ক্রিনিংয়ে পর্যাপ্ত দিকনির্দেশক edge নেই; নিরপেক্ষ/চপ বাজারে অপ্রয়োজনীয় AI কল বাদ" };
}

async function runOne(env, symbol, tf, options = {}) {
  let data=options.marketData||null;
  if(!data) data = await loadMarketData(symbol);
  if (!data.candles || !data.ticker) throw new Error("Market API returned incomplete data");
  const analysisData = tf === "4h"
    ? { ...data, candles: { ...data.candles, "4h": buildFourHourCandles(data) } }
    : tf === "30m"
      ? { ...data, candles: { ...data.candles, "30m": buildThirtyMinuteCandles(data) } }
      : data;
  const market = analyze(analysisData, tf);
  market.intradayMovement = buildIntradayMovement(data);
  market.timeframe = tf;
  // Check adjacent and broader 4h market structure before accepting a direction.
  const fourHour = buildFourHourContext(data);
  if (tf === "30m") {
    try {
      const other = analyze(data, "1h");
      market.higherTimeframe = { timeframe: "1h", signal: other.indicators.technicalSignal, score: other.indicators.technicalScore, rsi: other.indicators.rsi, ema9: other.indicators.ema9, ema21: other.indicators.ema21, requiredSignals: [other.indicators.technicalSignal, fourHour.signal], fourHour };
    } catch (_) { market.higherTimeframe = { timeframe: "1h", signal: "WAIT", requiredSignals: ["WAIT", fourHour.signal], fourHour }; }
  } else if (tf === "1h") {
    market.higherTimeframe = { timeframe: "4h", signal: fourHour.signal, fourHour };
  } else {
    market.higherTimeframe = { timeframe: "4h", signal: market.indicators.technicalSignal, fourHour };
  }
  market.agentIndicatorSets = calculateAgentIndicatorSets(market);
  market.riskEngine = { timeframe: "4h", available: fourHour.available === true, supportBreakdown: fourHour.supportBreakdown === true, confirmedSupportBreakdown: fourHour.confirmedSupportBreakdown === true, resistanceBreakout: fourHour.resistanceBreakout === true, confirmedResistanceBreakout: fourHour.confirmedResistanceBreakout === true, bearishWarning: fourHour.bearishWarning === true, bullishWarning: fourHour.bullishWarning === true, warnings: fourHour.warnings || (fourHour.warning ? [fourHour.warning] : []) };

  // Removed an unused historical-feedback scan: the AI prompt did not include
  // market.performanceFeedback, so reading up to 1,000 KV records per run wasted latency.
  // Pass the currently forming candle separately as provisional intrabar evidence.
  // Confirmed candles remain the only input to closed-candle indicator calculations.
  const timeframeBars = analysisData.candles?.[tf] || [];
  const formingCandle = [...timeframeBars].reverse().find(c => c && c.confirmed === false && [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite));
  market.formingCandle = formingCandle ? { time: formingCandle.time, open: formingCandle.open, high: formingCandle.high, low: formingCandle.low, close: formingCandle.close, volume: Number(formingCandle.volume) || 0, status: "FORMING_UNCONFIRMED" } : null;
  // Indicator-only mode: AI analysts are deliberately disabled while the
  // technical engine is evaluated independently.
  const technical = market.indicators;
  const advanced = calculateAdvancedIndicatorScore(market.agentIndicatorSets, technical.technicalScore, technical);
  technical.baseTechnicalScore = technical.technicalScore;
  technical.advancedIndicatorScore = advanced.advancedScore;
  technical.technicalScore = advanced.score;
  // Conservative entry threshold: prefer fewer, better-confirmed signals over frequent low-edge calls.
  const ENTRY_THRESHOLD = advanced.entryThreshold;
  const groupAgreement = advanced.agreement >= 3;
  technical.technicalSignal = advanced.score >= ENTRY_THRESHOLD && groupAgreement ? "LONG" : advanced.score <= -ENTRY_THRESHOLD && groupAgreement ? "SHORT" : "WAIT";
  technical.reason = technical.technicalSignal === "LONG" ? "ট্রেন্ড, মোমেন্টাম, অংশগ্রহণ ও প্রাইস-স্ট্রাকচার দলের অন্তত ৩টি LONG-এ একমত" :
    technical.technicalSignal === "SHORT" ? "ট্রেন্ড, মোমেন্টাম, অংশগ্রহণ ও প্রাইস-স্ট্রাকচার দলের অন্তত ৩টি SHORT-এ একমত" :
    advanced.agreement < 3 ? "চারটি বিশ্লেষণ দলের অন্তত তিনটি একই দিকে একমত নয়; WAIT" :
    "বাজারের অবস্থা ও সম্মিলিত স্কোরে প্রবেশের যথেষ্ট সুবিধা নেই";
  const candidate=technical.technicalSignal,higher=market.higherTimeframe||{};
  const higherSignals=tf==="30m"?[higher.signal,higher.fourHour?.signal].filter(x=>x==="LONG"||x==="SHORT"):[higher.fourHour?.signal||higher.signal].filter(x=>x==="LONG"||x==="SHORT");
  const higherSignal=higherSignals[0]||"WAIT";
  const opposite=candidate==="LONG"?"SHORT":"LONG";
  const hardRisk=candidate==="LONG"?market.riskEngine?.confirmedSupportBreakdown===true:candidate==="SHORT"?market.riskEngine?.confirmedResistanceBreakout===true:false;
  let decision=candidate,decisionReason=technical.reason;
  // Require genuinely separate momentum/strength confirmation. EMA and price-derived
  // indicators alone are not enough to authorize a directional call.
  const trendStrength=Number(technical.adx);
  const macdValue=Number(technical.macdHistogram);
  const plusDI=Number(technical.plusDI),minusDI=Number(technical.minusDI);
  const momentumConfirmed=candidate==="LONG"
    ? Number.isFinite(macdValue)&&macdValue>0&&Number.isFinite(plusDI)&&Number.isFinite(minusDI)&&plusDI>minusDI
    : candidate==="SHORT"
      ? Number.isFinite(macdValue)&&macdValue<0&&Number.isFinite(plusDI)&&Number.isFinite(minusDI)&&minusDI>plusDI
      : false;
  if(candidate!=="WAIT"&&(!Number.isFinite(trendStrength)||trendStrength<18)){decision="WAIT";decisionReason="ADX ১৮-এর নিচে; প্রবণতার শক্তি যথেষ্ট নয়";}
  if(candidate!=="WAIT"&&decision!=="WAIT"&&!momentumConfirmed){decision="WAIT";decisionReason="MACD ও directional movement একই দিকে নিশ্চিত নয়";}
  if(candidate!=="WAIT"&&decision!=="WAIT"&&higherSignals.includes(opposite)){decision="WAIT";decisionReason="এক বা একাধিক উচ্চতর টাইমফ্রেমে বিপরীত সংকেত; তাই ঝুঁকি এড়াতে WAIT";}
  const needsHigherAgreement=["30m","1h"].includes(tf);
  if(candidate!=="WAIT"&&decision!=="WAIT"&&needsHigherAgreement&&!higherSignals.includes(candidate)){decision="WAIT";decisionReason="উচ্চতর টাইমফ্রেমে একই দিকের সমর্থন নেই; তাই WAIT";}
  if(candidate!=="WAIT"&&decision!=="WAIT"&&hardRisk){decision="WAIT";decisionReason="৪ ঘণ্টার কাঠামোয় বিপরীত দিকের নিশ্চিত ব্রেক; তাই WAIT";}
  const analysis={decision,direction:decision==="LONG"?"UPWARD":decision==="SHORT"?"DOWNWARD":"SIDEWAYS",directionalBias:candidate,
    confidenceScore:Math.min(95,Math.round(Math.abs(technical.technicalScore)*100)),
    durationMinutes:({"30m":30,"1h":60,"4h":240}[tf]||30),reason:decisionReason,
    risk:"শুধু গাণিতিক ইন্ডিকেটর-সম্মিলন; confidence হলো স্কোরের মাত্রা, লাভের সম্ভাবনা নয়। প্রবেশের আগে stop-loss ও position sizing যাচাই করুন।",dataQuality:"GOOD"};
  // Isolated V2 research path: consumes only confirmed candles and never changes legacy signals.
  // Share the same confirmed, timeframe-complete candle set with V2.
  // V2 receives the same native 30m/1h/4h candle set as the main engine.
  const v2Data = analysisData;
  let brainModel=null;
  try{brainModel=await env.ANALYSIS_KV.get("brain:model:v1","json");}
  catch(error){console.warn("Shadow brain model unavailable",String(error));}
  const v2Testing = evaluateV2({ symbol, timeframe: tf, data: v2Data, market, now: Date.now(), accountEquity: null, config: { riskPct: 0.5, maxSpreadPct: 0.10, atrStopMultiple: 1.5 }, brainModel });
  const result={symbol,timeframe:tf,provider:"Indicator Engine Only · AI Disabled",
    model:"EMA/RSI/MACD/ADX + Ichimoku/SAR/Supertrend/Donchian/OBV/MFI/ROC",analysis,
    debate:{status:"INDICATOR_ONLY",screening:{reviewed:true,reason:"AI সম্পূর্ণ বন্ধ; সব সিদ্ধান্ত গাণিতিক ইন্ডিকেটর থেকে"},
      analystCount:0,councilOpinions:[],councilVoteCounts:{LONG:0,SHORT:0,WAIT:0},councilErrors:[],judgeError:null,
      technicalSignal:technical.technicalSignal,higherTimeframeSignal:higherSignal,
      fourHourContext:market.higherTimeframe?.fourHour||null,riskEngine:market.riskEngine,
      technicalIndicators:{...technical,advancedScore:advanced.advancedScore,regimeFactor:advanced.regimeFactor,entryThreshold:advanced.entryThreshold,marketRegime:advanced.regime,groupAgreement:advanced.agreement,groupDisagreement:advanced.disagreement,indicatorGroups:advanced.groups,advancedComponents:advanced.components,indicatorSets:market.agentIndicatorSets||{}}},
    testing:{ v2: v2Testing },
    generatedAt:new Date().toISOString(),candleCloseTime:market.candleCloseTime,signalPriceBasis:"confirmed-candle-close",entryPriceBasis:"live-ticker-at-decision",marketSource:data.source,
    marketFetchedAt:data.fetchedAt||null,marketTimestamp:data.marketTimestamp||null,inputTimeframe:tf,
    inputCandleCount:market.candles.length,intradayMovement:market.intradayMovement};
  if(options.persist!==false){
    try{await persistLatestSnapshot(env,symbol,result);}
    catch(error){result.storageWarnings=[...(result.storageWarnings||[]),"Latest snapshot could not be persisted"];console.error("Latest snapshot persistence failed",{symbol,timeframe:tf,error:String(error)});}
  }
  // One record per symbol/timeframe/closed candle. The scheduler may rerun several
  // times while the same candle remains latest; do not count those as new decisions.
  const decisionId = symbol + ":" + tf + ":" + Date.parse(result.candleCloseTime);
  if ((analysis.decision === "LONG" || analysis.decision === "SHORT") && Number.isFinite(Number(market.ticker.last)) && Number(market.ticker.last) > 0) {
    const decisionRecord = {
      id: decisionId,
      symbol,
      timeframe: tf,
      decision: analysis.decision,
      confidenceScore: Number(result.analysis.confidenceScore) || 0,
      // Save the indicator readings at signal time so their directional hit-rates
      // can be measured from later, independently verified outcomes.
      indicatorSnapshot: {
        baseScore: Number(technical.baseTechnicalScore),
        combinedScore: Number(technical.technicalScore),
        advancedScore: Number(technical.advancedIndicatorScore),
        rsi: Number(technical.rsi),
        adx: Number(technical.adx),
        macdHistogram: Number(technical.macdHistogram),
        relativeVolume: Number(technical.relativeVolume),
        components: { ...advanced.components }
      },
      entryPrice: Number(market.ticker.last),
      decidedAt: result.generatedAt,
      durationMinutes: Number(result.analysis.durationMinutes) || ({"30m":30,"1h":60,"4h":240}[tf] || 30),
      candleCloseTime: result.candleCloseTime,
      // Anchor the horizon to the actual closed signal candle, not scheduler execution latency.
      expectedEvaluationAt: new Date(Date.parse(result.candleCloseTime) + (Number(result.analysis.durationMinutes) || ({"30m":30,"1h":60,"4h":240}[tf] || 30)) * 60 * 1000).toISOString(),
      outcome: "PENDING"
    };
    try{
      const existingDecision = await env.ANALYSIS_KV.get("decision:" + decisionId, "json");
      if (!existingDecision) {
        await env.ANALYSIS_KV.put("decision:" + decisionId, JSON.stringify(decisionRecord), {expirationTtl:60*60*24*11,metadata:{id:decisionRecord.id,symbol:decisionRecord.symbol,timeframe:decisionRecord.timeframe,decision:decisionRecord.decision,decidedAt:decisionRecord.decidedAt,outcome:decisionRecord.outcome}});
        try{await env.ANALYSIS_KV.delete("observations:cache:v1");}catch(cacheError){console.error("Observation cache invalidation failed",String(cacheError));}
      }
    }catch(error){
      result.storageWarnings=[...(result.storageWarnings||[]),"Legacy decision ledger unavailable"];
      console.error("Legacy decision ledger write failed",{decisionId,error:String(error)});
    }
  }
  // Separate V2 paper-trade ledger. It never sends alerts or affects legacy decisions.
  const candidateDecision=v2Testing.featureSnapshot?.candidateDirection;
  const candidateEntry=Number(market.ticker.last);
  if (["LONG","SHORT"].includes(candidateDecision) && Number.isFinite(candidateEntry) && candidateEntry>0) {
    const v2Id = symbol + ":" + tf + ":" + Date.parse(result.candleCloseTime);
    const candidateDirection=candidateDecision==="LONG"?1:-1;
    const candidateAtr=Number(v2Testing.featureSnapshot?.frames?.entry?.atr)||0;
    const candidateStopDistance=Math.max(candidateAtr*1.5,candidateEntry*0.001);
    const candidateStop=candidateDirection>0?candidateEntry-candidateStopDistance:candidateEntry+candidateStopDistance;
    const candidateTarget=candidateDirection>0?candidateEntry+2*candidateStopDistance:candidateEntry-2*candidateStopDistance;
    const v2Record = {
      id:v2Id, system:"V2", paperMode:"CANDIDATE_SHADOW", approvedByV2:v2Testing.decision===candidateDecision,
      decision:candidateDecision, symbol, timeframe,
      strategy:v2Testing.selectedStrategy, confidenceScore:v2Testing.confidenceScore,
      confidenceMeaning:v2Testing.confidenceMeaning,
      modelVersion:"v2-shadow-features-1",
      marketRegime:v2Testing.marketRegime,
      regimeByTimeframe:v2Testing.regimeByTimeframe,
      timeframeAgreement:v2Testing.timeframeAgreement,
      scoreBreakdown:v2Testing.scoreBreakdown,
      featureSnapshot:v2Testing.featureSnapshot,
      brainPrediction:v2Testing.brainPrediction,
      evidence:v2Testing.evidence,
      contradictingEvidence:v2Testing.contradictingEvidence,
      entryPrice:candidateEntry, stopLoss:candidateStop,
      takeProfit1:candidateTarget, takeProfit2:candidateDirection>0?candidateEntry+3*candidateStopDistance:candidateEntry-3*candidateStopDistance,
      riskReward:2, decidedAt:result.generatedAt,
      candleCloseTime:result.candleCloseTime,
      durationMinutes:({"30m":30,"1h":60,"4h":240}[tf]||30),
      expectedEvaluationAt:new Date(Date.parse(result.candleCloseTime)+({"30m":30,"1h":60,"4h":240}[tf]||30)*60000).toISOString(),
      outcome:"PENDING"
    };
    try{
      const existingV2Record = await env.ANALYSIS_KV.get("v2paper:"+v2Id,"json");
      if (!existingV2Record) await env.ANALYSIS_KV.put("v2paper:"+v2Id,JSON.stringify(v2Record),{expirationTtl:60*60*24*30,metadata:{id:v2Record.id,symbol:v2Record.symbol,timeframe:v2Record.timeframe,decision:v2Record.decision,decidedAt:v2Record.decidedAt,outcome:v2Record.outcome}});
    }catch(error){
      result.storageWarnings=[...(result.storageWarnings||[]),"V2 paper ledger unavailable"];
      console.error("V2 paper ledger write failed",{v2Id,error:String(error)});
    }
  }
  // Existing notification behavior remains tied only to the legacy signal.
  await sendSignalPush(env, result);
  return result;
}

async function evaluateMaturedDecisions(env) {
  if (!env.ANALYSIS_KV) return;
  const now = Date.now();
  // Read every page: KV list() returns at most 1,000 keys per page.
  const listAll = async prefix => {
    const keys = [];
    let cursor;
    do {
      const page = await env.ANALYSIS_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      keys.push(...(page.keys || []));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return keys;
  };
  const [legacyKeys, v2Keys] = await Promise.all([
    listAll("decision:"),
    listAll("v2paper:")
  ]);
  const due = [];
  const intervalsForRecords = {"30m":1800000,"1h":3600000,"4h":14400000};
  for (const item of [...legacyKeys, ...v2Keys]) {
    let r;
    try { r = await env.ANALYSIS_KV.get(item.name, "json"); } catch (error) { console.error("Decision ledger read failed", {key:item.name,error:String(error)}); continue; }
    if (!r) r = item.metadata;
    if (r && (r.decision === "LONG" || r.decision === "SHORT")) {
      // Repair older records whose target was anchored to scheduler runtime.
      const duration = intervalsForRecords[r.timeframe];
      if (!duration) continue;
      const tolerance = Math.max(90000, duration * 0.25);
      // Retry scheduler-late results that the report excludes as UNVERIFIED.
      // KV metadata still retains the original CORRECT/WRONG result, so detect it by delay.
      const delayedResult = ["CORRECT","WRONG"].includes(r.outcome) &&
        !r.recheckedForDelayAt &&
        Number.isFinite(Number(r.evaluationDelayMs)) && Number(r.evaluationDelayMs) > tolerance;
      const missingCandleRetry = r.outcome === "UNVERIFIED" &&
        /নির্ধারিত সময়ের কাছাকাছি নিশ্চিত ক্যান্ডেল পাওয়া যায়নি/.test(r.evaluationNote || "") &&
        (!r.lastEvaluationAttemptAt || now - Date.parse(r.lastEvaluationAttemptAt) >= 5 * 60 * 1000);
      const retryable = r.outcome === "PENDING" || delayedResult || missingCandleRetry;
      if (!retryable) continue;
      const keyEpoch = Number(String(item.name).split(":").pop());
      const candleClose = Date.parse(r.candleCloseTime || "") || (Number.isFinite(keyEpoch) && keyEpoch > 0 ? keyEpoch : NaN);
      if (Number.isFinite(candleClose)) {
        r.candleCloseTime = new Date(candleClose).toISOString();
        r.expectedEvaluationAt = new Date(candleClose + duration).toISOString();
      }
      if (now >= Date.parse(r.expectedEvaluationAt)) due.push({ key: item.name, record: r });
    }
  }
  if (!due.length) return;
  // Use a confirmed historical candle near the target horizon, never a later live ticker quote.
  const symbols = [...new Set(due.map(x => x.record.symbol))];
  const markets = {};
  await Promise.all(symbols.map(async symbol => {
    try {
      const data = await loadMarketData(symbol);
      if (data?.candles) markets[symbol] = data.candles;
    } catch (error) {
      console.error("Matured decision market data unavailable", { symbol, error: String(error) });
    }
  }));
  const intervals = {"30m":1800000,"1h":3600000,"4h":14400000};
  for (const item of due) {
    const r = item.record, target = Date.parse(r.expectedEvaluationAt);
    const duration = intervals[r.timeframe];
    if (!duration) continue;
    const bars = markets[r.symbol]?.[r.timeframe] || [];
    let best = null, bestDelta = Infinity;
    for (const candle of bars) {
      if (!candle || candle.confirmed !== true || !Number.isFinite(Number(candle.time)) ||
          !Number.isFinite(Number(candle.close)) || Number(candle.close) <= 0) continue;
      const delta = Math.abs(Number(candle.time) + duration - target);
      if (delta < bestDelta) { best = candle; bestDelta = delta; }
    }
    // The live market endpoint only retains its latest candle window. Recover older missed
    // outcomes directly from Bybit's historical kline endpoint around the exact target.
    const tolerance = Math.max(30000, Math.min(60000, duration * 0.2));
    if (!best || bestDelta > tolerance) {
      const bybitIntervals = {"30m":"30","1h":"60","4h":"240"};
      const start = target - duration;
      const end = target + 1000;
      try {
        const url = "https://api.bybit.com/v5/market/kline?category=linear&symbol=" +
          encodeURIComponent(r.symbol + "USDT") + "&interval=" + bybitIntervals[r.timeframe] +
          "&start=" + start + "&end=" + end + "&limit=10";
        const response = await fetch(url, {headers:{Accept:"application/json"},signal:AbortSignal.timeout(4000)});
        if (response.ok) {
          const payload = await response.json();
          if (payload.retCode === 0 && Array.isArray(payload.result?.list)) {
            for (const row of payload.result.list) {
              const candle = {time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),confirmed:Number(row[0])+duration<=now};
              if (!candle.confirmed || !Number.isFinite(candle.close) || candle.close <= 0) continue;
              const delta = Math.abs(candle.time + duration - target);
              if (delta < bestDelta) {best=candle;bestDelta=delta;}
            }
          }
        }
      } catch (error) {
        console.warn("Historical outcome candle recovery failed", r.symbol, r.timeframe, String(error));
      }
    }
    r.evaluatedAt = new Date(now).toISOString();
    r.lastEvaluationAttemptAt = new Date(now).toISOString();
    r.evaluationDelayMs = Math.max(0, now - target);
    if (["CORRECT","WRONG","NEUTRAL"].includes(r.outcome) && r.evaluationDelayMs > Math.max(90000,duration*0.25)) {
      r.recheckedForDelayAt = new Date(now).toISOString();
    }
    if (!best || bestDelta > tolerance) {
      r.outcome = "UNVERIFIED";
      r.evaluationNote = "নির্ধারিত সময়ের কাছাকাছি নিশ্চিত ক্যান্ডেল পাওয়া যায়নি; সঠিকতা গণনায় অন্তর্ভুক্ত নয়";
    } else {
      const exitPrice = Number(best.close);
      r.exitPrice = exitPrice;
      r.exitCandleTime = new Date(Number(best.time) + duration).toISOString();
      r.exitPriceSource = "confirmed historical candle";
      r.horizonDeltaMs = bestDelta;
      const direction = r.decision === "LONG" ? 1 : -1;
      const marketMovePct = (exitPrice / r.entryPrice - 1) * 100;
      if (r.system === "V2") {
        // Paper trade evaluation uses the recorded stop/target, not only the final close.
        const high = Number(best.high), low = Number(best.low);
        const stop = Number(r.stopLoss), target1 = Number(r.takeProfit1);
        const stopHit = Number.isFinite(stop) && (direction > 0 ? low <= stop : high >= stop);
        const targetHit = Number.isFinite(target1) && (direction > 0 ? high >= target1 : low <= target1);
        if (stopHit && targetHit) {
          r.outcome = "UNVERIFIED";
          r.evaluationNote = "একই candle-এ stop-loss ও take-profit দুটিই স্পর্শ করেছে; intrabar ক্রম জানা যায় না";
        } else if (stopHit || targetHit) {
          const rawExit = stopHit ? stop : target1;
          const gross = (rawExit / r.entryPrice - 1) * direction * 100;
          r.pnlPct = gross - 0.18; // 6 bps fee + 3 bps slippage per side, round trip.
          r.exitPrice = rawExit;
          r.exitPriceSource = stopHit ? "stop-loss touched (conservative)" : "take-profit-1 touched";
          r.outcome = r.pnlPct > 0.01 ? "CORRECT" : r.pnlPct < -0.01 ? "WRONG" : "NEUTRAL";
          r.evaluationNote = (stopHit ? "Stop-loss" : "Take-profit-1") + " candle high/low touch; 0.18% round-trip friction deducted";
        } else {
          r.pnlPct = marketMovePct * direction - 0.18;
          r.outcome = r.pnlPct > 0.01 ? "CORRECT" : r.pnlPct < -0.01 ? "WRONG" : "NEUTRAL";
          r.evaluationNote = "সময় শেষে candle close; 0.18% round-trip fee/slippage deducted";
        }
      } else {
        // Legacy signal evaluation remains unchanged to avoid altering its historical rules.
        r.marketMovePct = marketMovePct;
        r.pnlPct = direction * marketMovePct;
        r.outcome = r.pnlPct > 0.01 ? "CORRECT" : r.pnlPct < -0.01 ? "WRONG" : "NEUTRAL";
        r.evaluationNote = Math.abs(r.pnlPct) <= 0.01
          ? "দামের পরিবর্তন ০.০১%-এর মধ্যে; নিরপেক্ষ ফল, সঠিকতা গণনায় ধরা হবে না"
          : "নির্ধারিত সময়ের সবচেয়ে কাছের নিশ্চিত ঐতিহাসিক ক্যান্ডেলের ক্লোজ দিয়ে যাচাই";
      }
    }
    try{
      await env.ANALYSIS_KV.put(item.key,JSON.stringify(r),{expirationTtl:60*60*24*11,metadata:{id:r.id,symbol:r.symbol,timeframe:r.timeframe,decision:r.decision,decidedAt:r.decidedAt,outcome:r.outcome}});
      try{await env.ANALYSIS_KV.delete("observations:cache:v1");}catch(cacheError){console.error("Observation cache invalidation failed",String(cacheError));}
    }catch(error){
      console.error("Matured decision ledger update failed",{key:item.key,error:String(error)});
    }
  }
}

async function trainV2Brain(env){
  if(!env.ANALYSIS_KV)return;
  const keys=[];let cursor;
  do{
    const page=await env.ANALYSIS_KV.list({prefix:"v2paper:",limit:1000,...(cursor?{cursor}:{})});
    keys.push(...(page.keys||[]));
    cursor=page.list_complete?undefined:page.cursor;
  }while(cursor);
  keys.sort((a,b)=>(Date.parse(b.metadata?.decidedAt||"")||0)-(Date.parse(a.metadata?.decidedAt||"")||0));
  const selected=keys.slice(0,1200),records=[];
  for(let offset=0;offset<selected.length;offset+=50){
    const batch=await Promise.all(selected.slice(offset,offset+50).map(async item=>{
      try{return await env.ANALYSIS_KV.get(item.name,"json");}catch(error){console.warn("Brain training record read failed",item.name,String(error));return null;}
    }));
    records.push(...batch.filter(Boolean));
  }
  const trained=trainBrainModel(records,Date.now());
  const previous=await env.ANALYSIS_KV.get("brain:model:v1","json");
  const status={...trained.status,activeModelAvailable:!!(trained.model||previous),activeModelTrainedAt:trained.model?.trainedAt||previous?.trainedAt||null,recordsScanned:selected.length};
  if(trained.model)await env.ANALYSIS_KV.put("brain:model:v1",JSON.stringify(trained.model),{expirationTtl:60*60*24*60});
  await env.ANALYSIS_KV.put("brain:status:v1",JSON.stringify(status),{expirationTtl:60*60*24*60});
  console.log("V2 shadow brain training",status);
  return status;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/brain/status"){
      if(!env.ANALYSIS_KV)return Response.json({error:"ANALYSIS_KV binding is missing"},{status:503});
      const status=await env.ANALYSIS_KV.get("brain:status:v1","json");
      const model=await env.ANALYSIS_KV.get("brain:model:v1","json");
      return Response.json({status:status||{status:"COLLECTING_DATA",message:"প্রথম প্রশিক্ষণ চক্র এখনো সম্পন্ন হয়নি"},modelAvailable:!!model,modelTrainedAt:model?.trainedAt||null,modelSamples:model?.samples||0,mode:"SHADOW_ONLY",liveDecisionImpact:false},{headers:{"Cache-Control":"no-store"}});
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "crypto-ai-market-worker",
        timestamp: new Date().toISOString(),
        analysisKv: !!env.ANALYSIS_KV,
        routes: ["/latest", "/analyze"]
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const protectedPostPaths = new Set(["/analyze","/push/subscribe","/push/unsubscribe","/push/test"]);
    if(request.method==="POST"&&protectedPostPaths.has(url.pathname)&&request.headers.get("Origin")!==PAGE_URL){
      return Response.json({error:"এই কাজটি শুধু অফিসিয়াল অ্যাপ থেকে করা যাবে"},{status:403,headers:{"Cache-Control":"no-store"}});
    }
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
      if(typeof subscription?.endpoint!=="string"||subscription.endpoint.length>2048||!isAllowedPushEndpoint(subscription.endpoint)){
        return Response.json({error:"Invalid or unsupported push endpoint"},{status:400});
      }
      let publicKeyBytes,authBytes;
      try{publicKeyBytes=unb64u(subscription?.keys?.p256dh);authBytes=unb64u(subscription?.keys?.auth);}catch(_){return Response.json({error:"Invalid push encryption keys"},{status:400});}
      if(publicKeyBytes.length!==65||authBytes.length!==16)return Response.json({error:"Invalid push encryption keys"},{status:400});
      const digest = await crypto.subtle.digest("SHA-256", utf8(subscription.endpoint));
      const id = b64u(new Uint8Array(digest)).slice(0, 32);
      try {
        await env.ANALYSIS_KV.put("push:sub:" + id, JSON.stringify(subscription), { expirationTtl: 60 * 60 * 24 * 180 });
      } catch(error) {
        console.error("Push subscription persistence failed",String(error));
        return Response.json({error:"Push subscription storage unavailable"},{status:503});
      }
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/push/test" && request.method === "POST") {
      if (!env.ANALYSIS_KV || !env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
        return Response.json({ error: "Push keys are not configured" }, { status: 503 });
      }
      let body;
      try { body = await request.json(); } catch (_) { return Response.json({ error: "Subscription endpoint required" }, { status: 400 }); }
      if(typeof body?.endpoint!=="string"||body.endpoint.length>2048)return Response.json({error:"Invalid subscription endpoint"},{status:400});
      const digest=await crypto.subtle.digest("SHA-256",utf8(body.endpoint));
      const id=b64u(new Uint8Array(digest)).slice(0,32);
      const key="push:sub:"+id;
      const subscription=await env.ANALYSIS_KV.get(key,"json");
      if(!subscription||subscription.endpoint!==body.endpoint)return Response.json({error:"This device is not subscribed"},{status:404});
      try{
        const response=await sendOnePush(env,subscription,{title:"নোটিফিকেশন পরীক্ষা",body:"সাউন্ড ও নোটিফিকেশন পরীক্ষা সফল",url:"/",tag:"crypto-ai-market-test-"+Date.now()});
        if(response.status===404||response.status===410){await env.ANALYSIS_KV.delete(key);return Response.json({error:"Subscription expired"},{status:410});}
        if(!response.ok)return Response.json({error:"Push provider HTTP "+response.status},{status:502});
        return Response.json({ok:true},{headers:{"Cache-Control":"no-store"}});
      }catch(error){console.error("Push test failed",String(error));return Response.json({error:"Push test delivery failed"},{status:502});}
    }
    if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
      if(typeof body?.endpoint!=="string"||!body.endpoint||body.endpoint.length>2048)return Response.json({error:"Subscription endpoint required"},{status:400});
      if(!env.ANALYSIS_KV)return Response.json({error:"ANALYSIS_KV binding is missing"},{status:503});
      const digest = await crypto.subtle.digest("SHA-256", utf8(body.endpoint));
      const id = b64u(new Uint8Array(digest)).slice(0, 32);
      try { await env.ANALYSIS_KV.delete("push:sub:" + id); }
      catch(error) { console.error("Push unsubscribe failed",String(error)); return Response.json({error:"Push subscription storage unavailable"},{status:503}); }
      return Response.json({ ok: true },{headers:{"Cache-Control":"no-store"}});
    }
    if (url.pathname === "/observations" && request.method === "GET") {
      try {
        if (!env.ANALYSIS_KV) return Response.json({error:"ANALYSIS_KV binding is missing"},{status:503});
        const days=Math.max(1,Math.min(5,Number(url.searchParams.get("days"))||5));
        // Reuse a short-lived KV cache so the dashboard does not consume KV list quota
        // on every one-minute browser refresh.
        const cached=await env.ANALYSIS_KV.get("observations:cache:v1","json");
        if(cached&&cached.days===days&&Number.isFinite(Date.parse(cached.generatedAt))&&Date.now()-Date.parse(cached.generatedAt)<300000) {
          return Response.json(cached,{headers:{"Cache-Control":"no-store","X-Observations-Cache":"HIT"}});
        }
        const now=Date.now(), mskNow=new Date(now+3*3600000);
        const mskMidnightUtc=Date.UTC(mskNow.getUTCFullYear(),mskNow.getUTCMonth(),mskNow.getUTCDate())-3*3600000;
        const since=mskMidnightUtc-(days-1)*86400000;
        const records=[];
        let cursor;
        do {
          const page=await env.ANALYSIS_KV.list({prefix:"decision:",limit:1000,...(cursor?{cursor}:{})});
          const keys=page.keys||[];
          // Read records in small batches; metadata lets us skip expired-window keys
          // before fetching full JSON and avoids a long serial KV read loop.
          for(let offset=0;offset<keys.length;offset+=40) {
            const batch=keys.slice(offset,offset+40).filter(item=>{
              const meta=item.metadata;
              if(!meta?.decidedAt)return true;
              const at=Date.parse(meta.decidedAt);
              return Number.isFinite(at)&&at>=since&&at<=now&&["LONG","SHORT"].includes(meta.decision);
            });
            const values=await Promise.all(batch.map(async item=>{
              try{return await env.ANALYSIS_KV.get(item.name,"json");}
              catch(error){console.error("Observation record read failed",{key:item.name,error:String(error)});return null;}
            }));
            for(const r of values) {
              if(!r||!["LONG","SHORT"].includes(r.decision))continue;
              const at=Date.parse(r.decidedAt||"");
              if(Number.isFinite(at)&&at>=since&&at<=now)records.push(r);
            }
          }
          cursor=page.list_complete?undefined:page.cursor;
        } while(cursor);
        records.sort((a,b)=>Date.parse(b.decidedAt)-Date.parse(a.decidedAt));
        const since24h=now-86400000;
        const last24h=records.filter(r=>Date.parse(r.decidedAt)>=since24h);
        const summary=list=>{
          const done=list.filter(r=>["CORRECT","WRONG"].includes(r.outcome));
          return {
            total:list.length,long:list.filter(r=>r.decision==="LONG").length,short:list.filter(r=>r.decision==="SHORT").length,
            btcLong:list.filter(r=>r.symbol==="BTC"&&r.decision==="LONG").length,
            btcShort:list.filter(r=>r.symbol==="BTC"&&r.decision==="SHORT").length,
            solLong:list.filter(r=>r.symbol==="SOL"&&r.decision==="LONG").length,
            solShort:list.filter(r=>r.symbol==="SOL"&&r.decision==="SHORT").length,
            correct:done.filter(r=>r.outcome==="CORRECT").length,wrong:done.filter(r=>r.outcome==="WRONG").length,
            neutral:list.filter(r=>r.outcome==="NEUTRAL").length,
            unverified:list.filter(r=>r.outcome==="UNVERIFIED").length,
            pending:list.filter(r=>!["CORRECT","WRONG","NEUTRAL","UNVERIFIED"].includes(r.outcome)||r.outcome==="PENDING").length,
            accuracy:done.length?done.filter(r=>r.outcome==="CORRECT").length/done.length*100:null
          };
        };
        const daily=Array.from({length:days},(_,i)=>{
          const dayStart=mskMidnightUtc-(days-1-i)*86400000;
          const key=new Date(dayStart+3*3600000).toISOString().slice(0,10);
          const list=records.filter(r=>new Date(Date.parse(r.decidedAt)+3*3600000).toISOString().slice(0,10)===key);
          const done=list.filter(r=>["CORRECT","WRONG"].includes(r.outcome));
          return {
            date:key,total:list.length,long:list.filter(r=>r.decision==="LONG").length,short:list.filter(r=>r.decision==="SHORT").length,
            correct:done.filter(r=>r.outcome==="CORRECT").length,wrong:done.filter(r=>r.outcome==="WRONG").length,
            neutral:list.filter(r=>r.outcome==="NEUTRAL").length,unverified:list.filter(r=>r.outcome==="UNVERIFIED").length,
            pending:list.filter(r=>!["CORRECT","WRONG","NEUTRAL","UNVERIFIED"].includes(r.outcome)||r.outcome==="PENDING").length,
            accuracy:done.length?done.filter(r=>r.outcome==="CORRECT").length/done.length*100:null,
            records:list.map(r=>({id:r.id,symbol:r.symbol,timeframe:r.timeframe,decision:r.decision,decidedAt:r.decidedAt,entryPrice:r.entryPrice,outcome:r.outcome,pnlPct:r.pnlPct??null,confidenceScore:r.confidenceScore,durationMinutes:r.durationMinutes,exitPrice:r.exitPrice??null}))
          };
        });
        const project=r=>({id:r.id,symbol:r.symbol,timeframe:r.timeframe,decision:r.decision,decidedAt:r.decidedAt,entryPrice:r.entryPrice,exitPrice:r.exitPrice??null,outcome:r.outcome,pnlPct:r.pnlPct??null,confidenceScore:r.confidenceScore,durationMinutes:r.durationMinutes});
        const payload={
          days,generatedAt:new Date().toISOString(),timezone:"Europe/Moscow",
          summary:summary(records),summary24h:summary(last24h),daily,
          records24h:last24h.map(project),records:records.map(project)
        };
        try{await env.ANALYSIS_KV.put("observations:cache:v1",JSON.stringify(payload),{expirationTtl:360});}
        catch(cacheError){console.error("Observations cache write failed",String(cacheError));}
        return Response.json(payload,{headers:{"Cache-Control":"no-store","X-Observations-Cache":"MISS"}});
      } catch(error) {
        console.error("Observations endpoint failed",String(error),error?.stack||"");
        return Response.json({error:"পর্যবেক্ষণের হিসাব তৈরি করা যায়নি",details:error instanceof Error?error.message:String(error)},{status:500,headers:{"Cache-Control":"no-store"}});
      }
    }
    if (url.pathname === "/v2/status" && request.method === "GET") {
      return Response.json({ version:"V2", mode:"TESTING_ONLY", liveTrading:false, legacySystem:"UNCHANGED", modules:["market-regime","multi-timeframe","trend","breakout","range","reversal-screen","weighted-validation","risk-check"], limitations:["V2 does not place orders or send trade notifications","Position size requires account equity input","BOS/CHoCH/liquidity-sweep strategy remains disabled until swing validation is implemented"] }, {headers:{"Cache-Control":"no-store"}});
    }
    if (url.pathname === "/analyze" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
      const { symbol, timeframe } = body || {};
      if (!["BTC", "SOL"].includes(symbol) || !["30m", "1h", "4h"].includes(timeframe)) {
        return Response.json({ error: "Unsupported symbol or timeframe" }, { status: 400 });
      }
      if (!env.ANALYSIS_KV) return Response.json({ error: "ANALYSIS_KV binding is missing" }, { status: 503 });
      try {
        const result = await runOne(env,symbol,timeframe,{persist:false});
        try{await persistLatestSnapshot(env,symbol,result);}
        catch(error){result.storageWarnings=[...(result.storageWarnings||[]),"Latest snapshot could not be persisted"];console.error("Manual latest snapshot persistence failed",{symbol,timeframe,error:String(error)});}
        return Response.json({items:[result],triggered:true},{headers:{"Cache-Control":"no-store"}});
      } catch (error) {
        console.error("Manual analysis failed", { symbol, timeframe, error: String(error) });
        return Response.json({ error: error instanceof Error ? error.message : "বিশ্লেষণ ব্যর্থ হয়েছে" }, { status: 502 });
      }
    }
    if (url.pathname !== "/latest") return Response.json({ error: "Not found" }, { status: 404 });
    const symbol = url.searchParams.get("symbol");
    const timeframe = url.searchParams.get("timeframe");
    if (!["BTC", "SOL"].includes(symbol) || !["30m", "1h", "4h"].includes(timeframe)) {
      return Response.json({ error: "Unsupported symbol or timeframe" }, { status: 400 });
    }
    if (!env.ANALYSIS_KV) return Response.json({ error: "ANALYSIS_KV binding is missing" }, { status: 503 });
    let snapshot,legacyLatest;
    try{snapshot=await env.ANALYSIS_KV.get("latest:" + symbol,"json");}catch(error){console.error("Latest snapshot read failed",String(error));}
    // Backward compatibility: read older per-timeframe keys during migration.
    try{legacyLatest=snapshot?.[timeframe]||await env.ANALYSIS_KV.get("latest:" + symbol + ":" + timeframe,"json");}catch(error){console.error("Legacy latest snapshot read failed",String(error));}
    const latest=legacyLatest;
    return Response.json({ items: latest ? [latest] : [] }, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  },
  async scheduled(controller, env, ctx) {
    const scheduledDate = new Date(controller.scheduledTime);
    const minute = scheduledDate.getUTCMinutes();
    if(minute===17){
      let brainStatus=null;
      try{brainStatus=await env.ANALYSIS_KV.get("brain:status:v1","json");}catch(_){}
      // Bootstrap as soon as the new ledger is deployed, then refresh every six hours.
      if(!brainStatus||scheduledDate.getUTCHours()%6===0){
        try{await trainV2Brain(env);}
        catch(error){console.error("V2 shadow brain training failed",String(error));}
      }
    }
    // Evaluate matured decisions every ten minutes. The dashboard cache is invalidated
    // whenever a result changes; this keeps the KV list quota within its daily budget.
    if(minute%10===0) {
      try{await evaluateMaturedDecisions(env);}
      catch(error){console.error("Matured-decision evaluation failed; scheduled analysis will continue",String(error));}
    }
    // Fetch each symbol's validated market snapshot once per cron tick. Reusing
    // it avoids 6 duplicate exchange fan-outs on 5-minute boundaries and keeps
    // every timeframe decision anchored to the same market-data observation.
    const marketDataBySymbol={};
    await Promise.all(["BTC","SOL"].map(async symbol=>{
      try{
        marketDataBySymbol[symbol]=await loadMarketData(symbol);
      }catch(error){marketDataBySymbol[symbol]={__fetchError:error instanceof Error?error.message:String(error)};}
    }));
    const tasks = [];
    for (const symbol of ["BTC", "SOL"]) {
      if (minute % 30 === 0) tasks.push({symbol,timeframe:"30m"});
      if (minute === 0) tasks.push({symbol,timeframe:"1h"});
      if (minute === 0 && scheduledDate.getUTCHours() % 4 === 0) tasks.push({symbol,timeframe:"4h"});
    }
    // The market feed is shared; keep CPU-heavy analysis work bounded.
    const outcomes = new Array(tasks.length);
    let nextTask = 0;
    const runners = Array.from({ length: 2 }, async () => {
      while (nextTask < tasks.length) {
        const index = nextTask++;
        const task=tasks[index];
        try { outcomes[index] = { status: "fulfilled", value: await runScheduledOne(env,task.symbol,task.timeframe,marketDataBySymbol[task.symbol]) }; }
        catch (reason) { outcomes[index] = { status: "rejected", reason }; }
      }
    });
    await Promise.all(runners);
    const successful = outcomes.filter(x => x.status === "fulfilled" && x.value && !x.value.skipped).map(x => x.value);
    const failed = outcomes.filter(x => x.status === "rejected");
    // Persist one combined snapshot per symbol every five minutes, instead of
    // writing latest + history + lock for every timeframe execution.
    if (minute % 5 === 0) {
      for (const symbol of ["BTC", "SOL"]) {
        const symbolResults = successful.filter(x => x.symbol === symbol);
        if (symbolResults.length) {
          // Keep one latest result per timeframe in a single KV object.
          let snapshot = {};
          try { snapshot = await env.ANALYSIS_KV.get("latest:" + symbol, "json") || {}; } catch (_) {}
          for (const result of symbolResults) snapshot[result.timeframe] = result;
          snapshot.updatedAt = new Date().toISOString();
          snapshot.storagePolicy = "batched-scheduler";
          try{await env.ANALYSIS_KV.put("latest:" + symbol,JSON.stringify(snapshot),{expirationTtl:60*60*24*90});}
          catch(error){console.error("Latest snapshot persistence failed",{symbol,error:String(error)});}
        }
      }
    }
    if (failed.length) console.error("Scheduled analysis failures:", failed.map(x => String(x.reason)));
    console.log("Scheduled analysis finished", { scheduledTime: controller.scheduledTime, success: successful.length, failed: failed.length, persistedSymbols: minute % 5 === 0 ? 2 : 0 });
  }
};
