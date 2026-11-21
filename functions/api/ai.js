export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) {
    return Response.json({ error: "Gemini API key is not configured on the server." }, { status: 503 });
  }
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON request." }, { status: 400 }); }

  const allowed = ["BTC", "SOL"];
  if (!allowed.includes(body?.symbol) || !["30m", "1h"].includes(body?.timeframe) || !body?.market) {
    return Response.json({ error: "Invalid symbol, timeframe, or market data." }, { status: 400 });
  }

  const market = body.market;
  const prompt = `তুমি একটি সতর্ক ক্রিপ্টো পারপেচুয়াল ফিউচার্স বাজার বিশ্লেষক। নিচের তথ্য ${body.symbol} USDT-এর ${body.timeframe} সময়সীমার। তথ্যের বাইরে কোনো দাম বা ঘটনা বানাবে না। এটি আর্থিক পরামর্শ নয়। একক AI মতামত; জয়ের সম্ভাবনা বা নিশ্চিত সংকেত দাবি করবে না। সিদ্ধান্ত LONG, SHORT বা WAIT-এর একটি হবে। RSI অতিরিক্ত হলে শুধু সেই কারণে বিপরীত দিকে ট্রেড সাজেস্ট করবে না। সংক্ষিপ্ত সহজ বাংলায় উত্তর দাও। নিচের JSON schema হুবহু অনুসরণ করো।

মার্কেট ডেটা:
${JSON.stringify(market)}

JSON schema: {"decision":"LONG|SHORT|WAIT","direction":"UPWARD|DOWNWARD|SIDEWAYS","reason":"বাংলায় সর্বোচ্চ ২টি ছোট বাক্য","risk":"বাংলায় একটি ছোট বাক্য","dataQuality":"GOOD|LIMITED"}`;

  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 350, responseMimeType: "application/json" }
      }),
      signal: AbortSignal.timeout(20000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json({ error: result?.error?.message || "Gemini API request failed." }, { status: response.status === 429 ? 429 : 502 });
    }
    const raw = result?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    if (!raw) return Response.json({ error: "Gemini returned an empty answer." }, { status: 502 });
    let analysis;
    try { analysis = JSON.parse(raw); } catch { return Response.json({ error: "Gemini returned an invalid structured answer." }, { status: 502 }); }
    if (!["LONG","SHORT","WAIT"].includes(analysis.decision) || !["UPWARD","DOWNWARD","SIDEWAYS"].includes(analysis.direction) || typeof analysis.reason !== "string" || typeof analysis.risk !== "string") return Response.json({ error: "Gemini answer failed validation." }, { status: 502 });
    return Response.json({ symbol: body.symbol, timeframe: body.timeframe, model: "gemini-3.8-flash", analysis, generatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gemini request timed out." }, { status: 502 });
  }
}
