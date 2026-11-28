import test from "node:test";
import assert from "node:assert/strict";
import { evaluateV2 } from "../trading-v2.js";
const STEP={"30m":1800000,"1h":3600000,"4h":14400000};
function makeBars(tf,count=240,direction=1,now=Date.now()){
 const step=STEP[tf],lastOpen=Math.floor(now/step)*step-step,first=lastOpen-(count-1)*step;
 return Array.from({length:count},(_,i)=>{
  const close=2000+direction*i*.02,open=close-direction*.005;
  return {time:first+i*step,open,high:Math.max(open,close)+.15,low:Math.min(open,close)-.15,close,volume:i===count-1?160:100,confirmed:true};
 });
}
function makeData(now=Date.now(),fourHourDirection=1){return {candles:{"4h":makeBars("4h",240,fourHourDirection,now),"1h":makeBars("1h",240,1,now),"30m":makeBars("30m",240,1,now)}};}
function makeMarket(data){const last=data.candles["30m"].at(-1).close;return {ticker:{last,bid:last-.01,ask:last+.01}};}

test("V2 emits a compact immutable feature snapshot for later model calibration",()=>{
 const now=Date.now(),data=makeData(now),market=makeMarket(data);
 const result=evaluateV2({symbol:"BTC",timeframe:"30m",data,market,now});
 assert.equal(result.featureSnapshot.schema,"v2-shadow-features-1");
 assert.ok(["LONG","SHORT","NO TRADE"].includes(result.featureSnapshot.candidateDirection));
 for(const tf of ["4h","1h","30m","entry"]){
  assert.equal(result.featureSnapshot.frames[tf].valid,true);
  assert.ok(Number.isFinite(result.featureSnapshot.frames[tf].rsi));
  assert.ok(Number.isFinite(result.featureSnapshot.frames[tf].adx));
 }
 assert.equal(result.confidenceMeaning,"Rule-based score; not a calibrated win probability");
});
test("V2 remains paper-only and does not trade with missing timeframe data",()=>{
 const now=Date.now(),result=evaluateV2({symbol:"BTC",timeframe:"30m",data:{candles:{}},market:{ticker:{last:100,bid:99.99,ask:100.01}},now});
 assert.equal(result.liveTrading,false);assert.equal(result.mode,"TESTING_ONLY");assert.equal(result.decision,"NO TRADE");assert.equal(result.entryPrice,null);assert.ok(result.contradictingEvidence.length>0);
});
test("V2 ignores unconfirmed and future candles",()=>{
 const now=Date.now(),data=makeData(now),market=makeMarket(data),baseline=evaluateV2({symbol:"BTC",timeframe:"30m",data,market,now}),altered=structuredClone(data);
 for(const tf of ["4h","1h","30m"]){const step=STEP[tf],last=altered.candles[tf].at(-1);altered.candles[tf].push({...last,time:last.time+step,close:last.close*100,high:last.high*100,open:last.open*100,low:last.low*100,confirmed:false});}
 const after=evaluateV2({symbol:"BTC",timeframe:"30m",data:altered,market,now});
 assert.equal(after.decision,baseline.decision);assert.equal(after.confidenceScore,baseline.confidenceScore);assert.deepEqual(after.dataQuality,baseline.dataQuality);assert.equal(after.liveTrading,false);
});
test("V2 blocks a long setup when the 4H trend conflicts",()=>{
 const now=Date.now(),data=makeData(now,-1),market=makeMarket(data),result=evaluateV2({symbol:"BTC",timeframe:"30m",data,market,now});
 assert.equal(result.decision,"NO TRADE");assert.ok(result.contradictingEvidence.some(x=>x.includes("4H ও 1H")));
});
test("V2 explicitly keeps the unvalidated reversal strategy disabled",()=>{
 const now=Date.now(),data=makeData(now),market=makeMarket(data),result=evaluateV2({symbol:"BTC",timeframe:"30m",data,market,now});
 assert.equal(result.strategies.reversal.direction,0);assert.equal(result.strategies.reversal.score,0);assert.ok(result.strategies.reversal.evidence.some(x=>x.includes("Disabled")));
});
test("V2 discards history before a candle gap instead of calculating across missing intervals",()=>{
 const now=Date.now(),data=makeData(now),bars=data.candles["30m"];
 bars.splice(80,1);
 const result=evaluateV2({symbol:"BTC",timeframe:"30m",data,market:makeMarket(data),now});
 assert.equal(result.dataQuality["30m"].valid,false);
 assert.ok(result.dataQuality["30m"].count<210);
 assert.equal(result.decision,"NO TRADE");
});
