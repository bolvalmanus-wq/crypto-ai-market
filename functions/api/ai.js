const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorMessage(payload, status) {
  return payload?.error?.message || payload?.message || `Gemini API HTTP ${status}`;
}

async function callModel(model, prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError = "AI service unavailable";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 500,
            responseMimeType: "application/json"
          }
        }),
        signal: AbortSignal.timeout(18000)
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        const raw = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        if (!raw) throw new Error("AI returned an empty answer");
        let analysis;
        try { analysis = JSON.parse(raw); }
        catch { throw new Error("AI returned invalid JSON"); }
        if (!["LONG", "SHORT", "WAIT"].includes(analysis.decision) ||
            !["UPWARD", "DOWNWARD", "SIDEWAYS"].includes(analysis.direction) ||
            typeof analysis.reason !== "string" || typeof analysis.risk !== "string" ||
            !["GOOD", "LIMITED"].includes(analysis.dataQuality)) {
          throw new Error("AI answer failed validation");
        }
        return { analysis, model };
      }
      lastError = errorMessage(payload, response.status);
      // Retry only transient server overload once. Other models are tried below.
      if (response.status === 503 && attempt === 0) {
        await sleep(900 + Math.floor(Math.random() * 500));
        continue;
      }
      const error = new Error(lastError);
      error.status = response.status;
      throw error;
    } catch (error) {
      if (error?.status) throw error;
      lastError = error instanceof Error ? error.message : "AI network error";
      if (attempt === 0) {
        await sleep(700 + Math.floor(Math.random() * 400));
        continue;
      }
    }
  }
  const error = new Error(lastError);
  error.status = 503;
  throw error;
}

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) {
    return Response.json({ error: "Cloudflare-এ GEMINI_API_KEY সেট করা নেই।" }, { status: 503 });
  }
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON request." }, { status: 400 }); }

  if (!["BTC", "SOL"].includes(body?.symbol) ||
      !["30m", "1h"].includes(body?.timeframe) || !body?.market) {
    return Response.json({ error: "Invalid symbol, timeframe, or market data." }, { status: 400 });
  }

  const market = body.market;
  const primaryModel = (env.GEMINI_MODEL || "gemini-2.5-flash").trim();
  const fallbackModel = (env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite").trim();
  // Keep configured choices, then retain two documented free-tier fallbacks if an old model ID is retired.
  const models = [...new Set([primaryModel, fallbackModel, "gemini-2.5-flash", "gemini-2.5-flash-lite"].filter(Boolean))];
  const prompt = `তুমি একটি সতর্ক, তথ্য-ভিত্তিক ক্রিপ্টো পারপেচুয়াল ফিউচার্স বিশ্লেষক। ${body.symbol}/USDT-এর ${body.timeframe} সময়সীমা বিশ্লেষণ করো।

কাজের নিয়ম:
- কেবল দেওয়া মার্কেট ডেটা ব্যবহার করবে; কোনো দাম, সংবাদ, সূচক বা ঘটনা বানাবে না।
- ক্যান্ডেলের ধারাবাহিকতা, EMA9/EMA21 ট্রেন্ড, RSI, ATR/ভোলাটিলিটি, MACD histogram, ADX/DI, Bollinger অবস্থান, Relative Volume, সাপোর্ট-রেজিস্ট্যান্স, ওপেন ইন্টারেস্ট, লং-শর্ট অনুপাত, অর্ডারবুক ও ফান্ডিং একসঙ্গে বিচার করবে।
- market.higherTimeframe.fourHour এবং market.riskEngine থাকলে ৪ ঘণ্টার EMA20/EMA50, RSI, সাপোর্ট ব্রেকডাউন ও রেজিস্ট্যান্স ব্রেকআউটকে বিশেষ গুরুত্ব দেবে। ৩০ মিনিট/১ ঘণ্টার সাময়িক bounce-কে বড় bearish trend reversal ধরে নেবে না।
- আগাম bearish warning-এর জন্য lower highs/lower lows, দাম EMA20-এর নিচে থাকা, EMA20<EMA50, RSI দুর্বল হওয়া, MACD histogram নেগেটিভ হওয়া, ভলিউম বেড়ে support breakdown—এগুলো একত্রে যাচাই করবে। একইভাবে bullish reversal-এর বিপরীত শর্ত যাচাই করবে।
- ৪ ঘণ্টার ডেটা অনুপস্থিত/অপর্যাপ্ত হলে dataQuality LIMITED দেবে এবং সিদ্ধান্তে অতিরিক্ত সতর্ক থাকবে।
- একাধিক সূচক একমত না হলে WAIT বলবে। RSI বেশি মানেই SHORT নয়, RSI কম মানেই LONG নয়।
- উচ্চতর সময়সীমা বিপরীত হলে বা ডেটা সীমিত/পুরোনো হলে সতর্ক হবে।
- market.performanceFeedback-এ একই কয়েন ও টাইমফ্রেমের গত ১০ দিনের ২৪ ঘণ্টা-পরবর্তী যাচাইকৃত LONG/SHORT ফল থাকলে সেগুলো বিবেচনা করবে। কোন ধরনের সিদ্ধান্তে ভুল বেশি হয়েছে তা দেখবে, কিন্তু ছোট নমুনাকে নিশ্চিত নিয়ম ধরবে না; অতীতের ফলকে বর্তমান মার্কেট ডেটার চেয়ে বেশি গুরুত্ব দেবে না।
- সিদ্ধান্ত অবশ্যই LONG, SHORT অথবা WAIT-এর একটি। LONG মানে BUY/লং পজিশন, SHORT মানে SELL/শর্ট পজিশন; ট্রেড না নেওয়াও বৈধ সিদ্ধান্ত।
- জয়ের সম্ভাবনা বা নির্ভুলতার শতাংশ বানাবে না। নির্দিষ্ট Entry/SL/TP বানিয়ে দেবে না।
- সহজ বাংলায় কারণ ও ঝুঁকি লিখবে; সর্বোচ্চ ২টি ছোট বাক্য করে।
- কেবল নিচের JSON কাঠামো ফেরত দেবে।

মার্কেট ডেটা:
${JSON.stringify(market)}

JSON: {"decision":"LONG|SHORT|WAIT","direction":"UPWARD|DOWNWARD|SIDEWAYS","reason":"বাংলায় সংক্ষিপ্ত কারণ","risk":"বাংলায় সংক্ষিপ্ত ঝুঁকি","dataQuality":"GOOD|LIMITED"}`;

  let success = null;
  const failures = [];
  for (const model of models) {
    try { success = await callModel(model, prompt, env.GEMINI_API_KEY); break; }
    catch (error) { failures.push(`${model}: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
  if (success) {
    return Response.json({
      symbol: body.symbol, timeframe: body.timeframe, provider: "Google Gemini",
      model: success.model, analysis: success.analysis,
      councilOpinions: [{ agent: "Gemini " + success.model, model: success.model, ...success.analysis }],
      generatedAt: new Date().toISOString()
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const detail = failures.join(" | ") || "Gemini service unavailable";
  return Response.json({
    error: "সব Gemini মডেল থেকে উত্তর পাওয়া যায়নি। " + detail,
    provider: "Google Gemini"
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
