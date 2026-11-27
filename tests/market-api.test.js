import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as getPrice } from "../functions/api/price.js";
import { onRequestGet as getMarket } from "../functions/api/market.js";

test("price API rejects a crossed Bybit book and falls back to a valid OKX quote",async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes("api.bybit.com"))return Response.json({retCode:0,time:Date.now(),result:{list:[{lastPrice:"100",prevPrice24h:"99",bid1Price:"100",ask1Price:"99"}]}});
  if(url.includes("www.okx.com"))return Response.json({code:"0",data:[{last:"101",open24h:"99",bidPx:"100.9",askPx:"101.1",ts:String(Date.now())}]});
  throw new Error("Unexpected provider URL "+url);
 };
 try{
  const response=await getPrice({request:new Request("https://app.test/api/price?symbol=BTC")});
  const data=await response.json();
  assert.equal(response.status,200);assert.equal(data.source,"OKX");assert.equal(data.last,101);
 }finally{globalThis.fetch=original;}
});

test("price API rejects unsupported symbols before making provider requests",async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error("Fetch must not run");};
 try{
  const response=await getPrice({request:new Request("https://app.test/api/price?symbol=ETH")});
  assert.equal(response.status,400);assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});

test("market API rejects a crossed Bybit book even when prices are numeric strings",async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes("api.bybit.com")){
   if(url.includes("/v5/market/tickers"))return Response.json({retCode:0,result:{list:[{lastPrice:"100",bid1Price:"100",ask1Price:"99"}]}});
   return Response.json({retCode:0,result:{list:[]}});
  }
  if(url.includes("okx.com"))return Response.json({code:"1",msg:"test fallback unavailable",data:[]});
  throw new Error("Unexpected provider URL "+url);
 };
 try{
  const response=await getMarket({request:new Request("https://app.test/api/market?symbol=BTC")});
  assert.equal(response.status,502);
  const data=await response.json();
  assert.match(data.error,/OKX/);
 }finally{globalThis.fetch=original;}
});

test("price API rejects a future-dated OKX quote",async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes("api.bybit.com"))return Response.json({retCode:10001,retMsg:"test",result:{}});
  if(url.includes("www.okx.com"))return Response.json({code:"0",data:[{last:"101",open24h:"99",bidPx:"100.9",askPx:"101.1",ts:String(Date.now()+120000)}]});
  throw new Error("Unexpected provider URL "+url);
 };
 try{
  const response=await getPrice({request:new Request("https://app.test/api/price?symbol=BTC")});
  assert.equal(response.status,502);
 }finally{globalThis.fetch=original;}
});

test("market API rejects stale Bybit server time and falls back to fresh OKX data",async()=>{
 const original=globalThis.fetch,now=Date.now();
 const bybitBars=Array.from({length:40},(_,i)=>[String(now-40*60000+i*60000),"100","101","99","100","10"]);
 const okxBars=Array.from({length:40},(_,i)=>[String(now-40*60000+i*60000),"100","101","99","100","10","10","0","1"]);
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes("api.bybit.com")){
   if(url.includes("/tickers"))return Response.json({retCode:0,time:now-600000,result:{list:[{lastPrice:"100",prevPrice24h:"99",bid1Price:"99.9",ask1Price:"100.1"}]}});
   if(url.includes("/kline"))return Response.json({retCode:0,time:now-600000,result:{list:bybitBars}});
   return Response.json({retCode:10001,retMsg:"optional endpoint",result:{}});
  }
  if(url.includes("okx.com")){
   if(url.includes("/ticker?"))return Response.json({code:"0",data:[{last:"100",open24h:"99",bidPx:"99.9",askPx:"100.1",ts:String(Date.now())}]});
   const bar=url.includes("bar=30m")?1800000:url.includes("bar=1H")?3600000:14400000;
   const rows=Array.from({length:40},(_,i)=>[String(Math.floor((now-40*bar+i*bar)/bar)*bar),"100","101","99","100","10","10","0","1"]);
   return Response.json({code:"0",data:rows});
  }
  throw new Error("Unexpected provider URL "+url);
 };
 try{
  const response=await getMarket({request:new Request("https://app.test/api/market?symbol=BTC")});
  const data=await response.json();
  assert.equal(response.status,200);assert.match(data.source,/OKX/);
 }finally{globalThis.fetch=original;}
});

test("market API rejects future-dated OKX ticker data from every regional host",async()=>{
 const original=globalThis.fetch,now=Date.now();
 const bybitBars=Array.from({length:40},(_,i)=>[String(now-40*60000+i*60000),"100","101","99","100","10"]);
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes("api.bybit.com")){
   if(url.includes("/tickers"))return Response.json({retCode:0,time:now-600000,result:{list:[{lastPrice:"100",prevPrice24h:"99",bid1Price:"99.9",ask1Price:"100.1"}]}});
   if(url.includes("/kline"))return Response.json({retCode:0,time:now-600000,result:{list:bybitBars}});
   return Response.json({retCode:10001,retMsg:"optional",result:{}});
  }
  if(url.includes("okx.com")){
   if(url.includes("/ticker?"))return Response.json({code:"0",data:[{last:"100",open24h:"99",bidPx:"99.9",askPx:"100.1",ts:String(Date.now()+120000)}]});
   const bar=url.includes("bar=1m")?60000:url.includes("bar=5m")?300000:url.includes("bar=15m")?900000:url.includes("bar=30m")?1800000:url.includes("bar=1H")?3600000:14400000;
   const rows=Array.from({length:40},(_,i)=>[String(Math.floor((now-40*bar+i*bar)/bar)*bar),"100","101","99","100","10","10","0","1"]);
   return Response.json({code:"0",data:rows});
  }
  throw new Error("Unexpected provider URL "+url);
 };
 try{
  const response=await getMarket({request:new Request("https://app.test/api/market?symbol=BTC")});
  assert.equal(response.status,502);
 }finally{globalThis.fetch=original;}
});
