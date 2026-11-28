import test from "node:test";
import assert from "node:assert/strict";
import {brainFeatures,trainBrainModel,predictBrainModel} from "../brain-model.js";

function sample(i,label){
 const rsi=label?68:32, slope=label?.35:-.35;
 const frame={valid:true,emaSlope:slope,adx:28,plusDI:label?35:12,minusDI:label?12:35,choppiness:42,atrPct:.8,atrPercentile:35,rsi,cci:label?110:-110,relativeVolume:1.8,vwapDistancePct:label?.2:-.2,supertrend:label?"UP":"DOWN",ichimokuBull:!!label,ichimokuBear:!label,bull:!!label,bear:!label};
 return {id:String(i),symbol:"BTC",timeframe:"30m",strategy:"TREND",decidedAt:new Date(Date.UTC(2026,0,1)+i*1800000).toISOString(),outcome:label?"CORRECT":"WRONG",featureSnapshot:{schema:"v2-shadow-features-1",candidateDirection:"LONG",regime:label?"STRONG_BULLISH":"STRONG_BEARISH",spreadPct:.02,scoreBreakdown:{trend:25,structure:20,momentum:15,volume:15,multiTimeframe:15,regime:10},frames:{"4h":frame,"1h":frame,"30m":frame,entry:frame}}};
}

test("brain feature vector is fixed-width and direction-aware",()=>{
 const a=brainFeatures(sample(1,1)),b=brainFeatures(sample(2,0));
 assert.ok(Array.isArray(a));assert.equal(a.length,b.length);assert.notDeepEqual(a,b);
});
test("brain waits for enough verified historical outcomes",()=>{
 const result=trainBrainModel(Array.from({length:50},(_,i)=>sample(i,i%2)),Date.UTC(2026,1,1));
 assert.equal(result.status.status,"COLLECTING_DATA");assert.equal(result.model,null);
});
test("brain trains only after chronological validation beats baseline",()=>{
 const records=Array.from({length:240},(_,i)=>sample(i,i%2));
 const result=trainBrainModel(records,Date.UTC(2026,1,1));
 assert.equal(result.status.status,"SHADOW_MODEL_READY");
 assert.ok(result.status.validation.balancedAccuracy>=.53);
 const prediction=predictBrainModel(result.model,sample(300,1));
 assert.ok(prediction.scorePct>50);
 assert.equal(prediction.meaning.includes("not a calibrated win probability"),true);
});
test("brain prediction is unavailable for incompatible schema",()=>{
 assert.equal(predictBrainModel(null,sample(1,1)),null);
});
