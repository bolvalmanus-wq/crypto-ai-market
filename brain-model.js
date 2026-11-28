// Lightweight, interpretable supervised-learning brain for V2 paper-trade research.
// It never authorizes or changes production LONG/SHORT decisions.
const FEATURE_SCHEMA="v2-brain-features-1";
const clamp=(x,lo=-5,hi=5)=>Math.max(lo,Math.min(hi,Number.isFinite(x)?x:0));
const num=(x)=>Number.isFinite(Number(x))?Number(x):0;
const sign=(x)=>x==="UP"?1:x==="DOWN"?-1:x===true?1:x===false?-1:0;

export function brainFeatures(record){
  const snap=record?.featureSnapshot;
  if(snap?.schema!=="v2-shadow-features-1")return null;
  const dir=snap.candidateDirection==="LONG"?1:snap.candidateDirection==="SHORT"?-1:0;
  if(!dir)return null;
  const out=[
    dir,
    record.symbol==="SOL"?1:0,
    record.timeframe==="1h"?1:0,
    record.timeframe==="4h"?1:0,
    record.strategy==="TREND"?1:0,
    record.strategy==="BREAKOUT"?1:0,
    record.strategy==="RANGE"?1:0,
    record.strategy==="REVERSAL"?1:0,
    snap.regime==="STRONG_BULLISH"?1:0,
    snap.regime==="STRONG_BEARISH"?1:0,
    snap.regime==="SIDEWAYS"?1:0,
    snap.regime==="MIXED"?1:0,
    clamp(num(snap.spreadPct)*10,0,5)
  ];
  for(const tf of ["4h","1h","30m","entry"]){
    const x=snap.frames?.[tf]||{};
    const valid=x.valid===true;
    out.push(valid?1:0);
    out.push(clamp(num(x.emaSlope)*dir,-5,5));
    out.push(clamp(num(x.adx)/50,0,2));
    out.push(clamp((num(x.plusDI)-num(x.minusDI))*dir/50,-2,2));
    out.push(clamp((num(x.rsi)-50)*dir/25,-2,2));
    out.push(clamp(num(x.cci)*dir/200,-3,3));
    out.push(clamp(num(x.atrPct),0,5));
    out.push(clamp(num(x.atrPercentile)/100,0,1));
    out.push(clamp((num(x.relativeVolume)-1)/2,-1,3));
    out.push(clamp(num(x.vwapDistancePct)*dir,-5,5));
    out.push(sign(x.supertrend)*dir);
    out.push((Number(x.ichimokuBull===true)-Number(x.ichimokuBear===true))*dir);
    out.push((Number(x.bull===true)-Number(x.bear===true))*dir);
  }
  const scores=snap.scoreBreakdown||{};
  for(const k of ["trend","structure","momentum","volume","multiTimeframe","regime"])out.push(clamp(num(scores[k])/25,0,1));
  return out;
}

function sigmoid(z){if(z>30)return 1;if(z< -30)return 0;return 1/(1+Math.exp(-z));}
function fit(rows,labels,iterations=250){
  const n=rows.length,p=rows[0].length;
  const means=Array(p).fill(0),scales=Array(p).fill(0);
  for(const row of rows)for(let j=0;j<p;j++)means[j]+=row[j]/n;
  for(const row of rows)for(let j=0;j<p;j++)scales[j]+=(row[j]-means[j])**2/n;
  for(let j=0;j<p;j++)scales[j]=Math.sqrt(scales[j])||1;
  const z=rows.map(row=>row.map((v,j)=>clamp((v-means[j])/scales[j],-8,8)));
  const weights=Array(p+1).fill(0),lr=.04,l2=.02;
  for(let step=0;step<iterations;step++){
    const grad=Array(p+1).fill(0);
    for(let i=0;i<n;i++){
      let score=weights[0];
      for(let j=0;j<p;j++)score+=weights[j+1]*z[i][j];
      const err=sigmoid(score)-labels[i];
      grad[0]+=err/n;
      for(let j=0;j<p;j++)grad[j+1]+=err*z[i][j]/n;
    }
    for(let j=1;j<weights.length;j++)grad[j]+=l2*weights[j];
    for(let j=0;j<weights.length;j++)weights[j]-=lr*grad[j];
  }
  return {means,scales,weights};
}
function probability(model,row){
  let z=model.weights[0];
  for(let j=0;j<row.length;j++)z+=model.weights[j+1]*clamp((row[j]-model.means[j])/model.scales[j],-8,8);
  return sigmoid(z);
}
function metrics(rows,labels,model){
  const probs=rows.map(x=>probability(model,x)),pred=probs.map(x=>x>=.5?1:0);
  const tp=pred.filter((x,i)=>x===1&&labels[i]===1).length;
  const tn=pred.filter((x,i)=>x===0&&labels[i]===0).length;
  const positives=labels.filter(x=>x===1).length,negatives=labels.length-positives;
  const accuracy=(tp+tn)/labels.length;
  const balancedAccuracy=((positives?tp/positives:0)+(negatives?tn/negatives:0))/2;
  const brier=probs.reduce((a,p,i)=>a+(p-labels[i])**2,0)/labels.length;
  const logLoss=probs.reduce((a,p,i)=>a-(labels[i]?Math.log(Math.max(1e-8,p)):Math.log(Math.max(1e-8,1-p))),0)/labels.length;
  const prevalence=positives/labels.length;
  const baselineLogLoss=-(prevalence*Math.log(Math.max(1e-8,prevalence))+(1-prevalence)*Math.log(Math.max(1e-8,1-prevalence)));
  return {samples:labels.length,accuracy:Number(accuracy.toFixed(4)),balancedAccuracy:Number(balancedAccuracy.toFixed(4)),brier:Number(brier.toFixed(4)),logLoss:Number(logLoss.toFixed(4)),baselineLogLoss:Number(baselineLogLoss.toFixed(4)),positive:positives,negative:negatives};
}

export function trainBrainModel(records,now=Date.now()){
  const rows=[];
  for(const r of records||[]){
    if(!["CORRECT","WRONG"].includes(r?.outcome))continue;
    const features=brainFeatures(r);
    if(!features)continue;
    rows.push({features,label:r.outcome==="CORRECT"?1:0,time:Date.parse(r.decidedAt||"")||0});
  }
  rows.sort((a,b)=>a.time-b.time);
  const usable=rows.slice(-1200);
  const positives=usable.filter(x=>x.label===1).length,negatives=usable.length-positives;
  const base={schema:FEATURE_SCHEMA,trainedAt:new Date(now).toISOString(),samples:usable.length,positive:positives,negative:negatives};
  if(usable.length<200||positives<60||negatives<60){
    return {status:{...base,status:"COLLECTING_DATA",minimumSamples:200,minimumPerClass:60,message:"প্রশিক্ষণের জন্য অন্তত ২০০টি যাচাইকৃত ফল এবং প্রতিটি শ্রেণিতে ৬০টি করে নমুনা প্রয়োজন"},model:null};
  }
  const split=Math.floor(usable.length*.8),train=usable.slice(0,split),valid=usable.slice(split);
  const validPos=valid.filter(x=>x.label===1).length,validNeg=valid.length-validPos;
  if(valid.length<40||validPos<10||validNeg<10){
    return {status:{...base,status:"COLLECTING_VALIDATION_DATA",validationSamples:valid.length,message:"সময়-অনুযায়ী আলাদা পরীক্ষার জন্য আরও সঠিক ও ভুল ফল প্রয়োজন"},model:null};
  }
  const validationFit=fit(train.map(x=>x.features),train.map(x=>x.label));
  const validation=metrics(valid.map(x=>x.features),valid.map(x=>x.label),validationFit);
  const improves=validation.logLoss<validation.baselineLogLoss*.99;
  const passes=validation.balancedAccuracy>=.53&&improves;
  if(!passes){
    return {status:{...base,status:"NOT_PROMOTED",validation,minimumBalancedAccuracy:.53,message:"পরীক্ষার ফল উন্নতির প্রমাণ দেয়নি; আগের মডেল অপরিবর্তিত রাখা হবে"},model:null};
  }
  const finalFit=fit(usable.map(x=>x.features),usable.map(x=>x.label));
  return {
    status:{...base,status:"SHADOW_MODEL_READY",validation,trainingSamples:train.length,validationSamples:valid.length,minimumBalancedAccuracy:.53,message:"সময়-অনুযায়ী পরীক্ষায় baseline-এর চেয়ে উন্নতি পাওয়া গেছে; মডেল শুধু shadow বিশ্লেষণে ব্যবহৃত হবে"},
    model:{schema:FEATURE_SCHEMA,trainedAt:new Date(now).toISOString(),samples:usable.length,means:finalFit.means,scales:finalFit.scales,weights:finalFit.weights,validation}
  };
}

export function predictBrainModel(model,record){
  if(model?.schema!==FEATURE_SCHEMA)return null;
  const row=brainFeatures(record);
  if(!row||!Array.isArray(model.weights)||model.weights.length!==row.length+1||model.means?.length!==row.length||model.scales?.length!==row.length)return null;
  const score=probability(model,row);
  return {modelSchema:FEATURE_SCHEMA,trainedAt:model.trainedAt,samples:model.samples,scorePct:Math.round(score*100),band:score>=.65?"HIGHER_HISTORICAL_SCORE":score<=.45?"LOWER_HISTORICAL_SCORE":"UNCERTAIN",meaning:"Historical paper-trade model score; not a calibrated win probability and not used to change decisions"};
}
