import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
const ORIGIN="https://crypto-ai-market.pages.dev";
const env={ANALYSIS_KV:{put:async()=>{},delete:async()=>{}}};

test("Worker rejects mutation requests without the exact app Origin",async()=>{
 const request=new Request("https://worker.test/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:"BTC",timeframe:"30m"})});
 const response=await worker.fetch(request,env);
 assert.equal(response.status,403);
});

test("push subscription rejects non-standard ports even on an allowed provider hostname",async()=>{
 const subscription={endpoint:"https://fcm.googleapis.com:8443/fcm/send/example",keys:{p256dh:"A".repeat(88),auth:"A".repeat(24)}};
 const request=new Request("https://worker.test/push/subscribe",{method:"POST",headers:{"Content-Type":"application/json",Origin:ORIGIN},body:JSON.stringify(subscription)});
 const response=await worker.fetch(request,env);
 assert.equal(response.status,400);
});

test("push unsubscribe requires a bounded endpoint string",async()=>{
 const request=new Request("https://worker.test/push/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json",Origin:ORIGIN},body:JSON.stringify({endpoint:""})});
 const response=await worker.fetch(request,env);
 assert.equal(response.status,400);
});
