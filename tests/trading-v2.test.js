import test from "node:test";
import assert from "node:assert/strict";
import { evaluateV2, backtestV2 } from "../trading-v2.js";
const STEP={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000};
function makeBars(tf,count=240,direction=1,now=Date.now()){
 const step=STEP[tf],lastOpen=Math.floor(now/step)*step-step,first=lastOpen-(count-1)*step;
 return Array.from({length:count},(_,i)=>{
  const close=2000+direction*i*.02,open=close-direction*.005;
  return {time:first+i*step,open,high:Math.max(open,close)+.15,low:Math.min(open,close)-.15,close,volume:i===count-1?160:100,confirmed:true};
 });
}
function makeData(now=Date.now(),fourHourDirection=1){return {candles:{"4h":makeBars("4h",240,fourHourDirection,now),"1h":makeBars("1h",240,1,now),"15m":makeBars("15m",240,1,now)}};}
function makeMarket(data){const last=data.candles["15m"].at(-1).close;return {ticker:{last,bid:last-.01,ask:last+.01}};}

test("V2 remains paper-only and does not trade with missing timeframe data",()=>{
 const now=Date.now(),result=evaluateV2({symbol:"BTC",timeframe:"15m",data:{candles:{}},market:{ticker:{last:100,bid:99.99,ask:100.01}},now});
 assert.equal(result.liveTrading,false);assert.equal(result.mode,"TESTING_ONLY");assert.equal(result.decision,"NO TRADE");assert.equal(result.entryPrice,null);assert.ok(result.contradictingEvidence.length>0);
});
test("V2 ignores unconfirmed and future candles",()=>{
 const now=Date.now(),data=makeData(now),market=makeMarket(data),baseline=evaluateV2({symbol:"BTC",timeframe:"15m",data,market,now}),altered=structuredClone(data);
 for(const tf of ["4h","1h","15m"]){const step=STEP[tf],last=altered.candles[tf].at(-1);altered.candles[tf].push({...last,time:last.time+step,close:last.close*100,high:last.high*100,open:last.open*100,low:last.low*100,confirmed:false});}
 const after=evaluateV2({symbol:"BTC",timeframe:"15m",data:altered,market,now});
 assert.equal(after.decision,baseline.decision);assert.equal(after.confidenceScore,baseline.confidenceScore);assert.deepEqual(after.dataQuality,baseline.dataQuality);assert.equal(after.liveTrading,false);
});
test("V2 blocks a long setup when the 4H trend conflicts",()=>{
 const now=Date.now(),data=makeData(now,-1),market=makeMarket(data),result=evaluateV2({symbol:"BTC",timeframe:"15m",data,market,now});
 assert.equal(result.decision,"NO TRADE");assert.ok(result.contradictingEvidence.some(x=>x.includes("4H ও 1H")));
});
test("V2 explicitly keeps the unvalidated reversal strategy disabled",()=>{
 const now=Date.now(),data=makeData(now),market=makeMarket(data),result=evaluateV2({symbol:"BTC",timeframe:"15m",data,market,now});
 assert.equal(result.strategies.reversal.direction,0);assert.equal(result.strategies.reversal.score,0);assert.ok(result.strategies.reversal.evidence.some(x=>x.includes("Disabled")));
});
test("backtest never labels a preliminary sample as validated",()=>{
 const now=Date.now(),report=backtestV2({candles:makeBars("15m",600,1,now),timeframe:"15m",feeBps:6,slippageBps:3,holdBars:1,minimumTrades:500});
 assert.equal(report.status,"NOT_VALIDATED");assert.equal(report.validation.startsWith("NOT_VALIDATED"),true);assert.equal(report.costModel.feeBps,6);assert.equal(report.costModel.slippageBps,3);assert.equal(report.sampleSizeReached,report.trades>=500);
});
test("backtest reports insufficient history without fabricating trades",()=>{
 const report=backtestV2({candles:makeBars("15m",100),timeframe:"15m"});assert.equal(report.status,"INSUFFICIENT_DATA");assert.equal(report.trades,0);assert.equal(report.winRate,undefined);
});
