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
