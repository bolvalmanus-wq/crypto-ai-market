// Trading Analysis Software V2 — isolated research engine.
// This module never places orders and never changes the legacy decision.
const FRAMES = { "1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000 };
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,x));
const finite=x=>x!==null&&x!==undefined&&x!==""&&Number.isFinite(Number(x));
function confirmed(bars, tf, now=Date.now()){
  const step=FRAMES[tf];
  if(!step||!Array.isArray(bars))return [];
  const unique=new Map();
  for(const x of bars){
    if(!x||x.confirmed!==true||![x.time,x.open,x.high,x.low,x.close,x.volume].every(finite))continue;
    const time=Number(x.time),open=Number(x.open),high=Number(x.high),low=Number(x.low),close=Number(x.close),volume=Number(x.volume);
    if(!Number.isFinite(time)||time<=0||time+step>now||low<=0||high<low||open<low||open>high||close<low||close>high||volume<0)continue;
    unique.set(time,{...x,time,open,high,low,close,volume,confirmed:true});
  }
  return [...unique.values()].sort((a,b)=>a.time-b.time);
}
function ema(values,n){
  if(values.length<n)return NaN;
  const k=2/(n+1);let v=values.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function wilderRsi(values,period=14){
  if(values.length<=period)return 50;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}
  let avgGain=gain/period,avgLoss=loss/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgGain=(avgGain*(period-1)+Math.max(0,d))/period;avgLoss=(avgLoss*(period-1)+Math.max(0,-d))/period;}
  if(avgGain===0&&avgLoss===0)return 50;
  if(avgLoss===0)return 100;
  if(avgGain===0)return 0;
  return 100-100/(1+avgGain/avgLoss);
}
function stats(bars){
  const c=bars.map(x=>Number(x.close)),h=bars.map(x=>Number(x.high)),l=bars.map(x=>Number(x.low)),v=bars.map(x=>Math.max(0,Number(x.volume)||0));
  if(c.length<210)return {valid:false,count:c.length,reason:"EMA200-এর জন্য কমপক্ষে ২১০টি নিশ্চিত ক্যান্ডেল দরকার"};
  const e20=ema(c,20),e50=ema(c,50),e200=ema(c,200),prev20=ema(c.slice(0,-5),20);
  const trs=bars.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-bars[i].close),Math.abs(x.low-bars[i].close)));
  const atr=trs.slice(-14).reduce((a,b)=>a+b,0)/14;
  const tr14=trs.slice(-14),hh=Math.max(...h.slice(-14)),ll=Math.min(...l.slice(-14));
  const chop=hh>ll?100*Math.log10(tr14.reduce((a,b)=>a+b,0)/(hh-ll))/Math.log10(14):100;
  // Wilder-smoothed directional movement and ADX(14).
  const dmPlus=[],dmMinus=[],trAll=[];
  for(let i=1;i<bars.length;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i];dmPlus.push(up>dn&&up>0?up:0);dmMinus.push(dn>up&&dn>0?dn:0);trAll.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}
  let smTR=trAll.slice(0,14).reduce((a,b)=>a+b,0),smPlus=dmPlus.slice(0,14).reduce((a,b)=>a+b,0),smMinus=dmMinus.slice(0,14).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=14;i<trAll.length;i++){smTR=smTR-smTR/14+trAll[i];smPlus=smPlus-smPlus/14+dmPlus[i];smMinus=smMinus-smMinus/14+dmMinus[i];const pdi=smTR?smPlus/smTR*100:0,mdi=smTR?smMinus/smTR*100:0;dx.push(100*Math.abs(pdi-mdi)/Math.max(1e-12,pdi+mdi));}
  let adx=dx.length>=14?dx.slice(0,14).reduce((a,b)=>a+b,0)/14:dx.length?dx.reduce((a,b)=>a+b,0)/dx.length:0;
  for(let i=14;i<dx.length;i++)adx=(adx*13+dx[i])/14;
  const plusDI=smTR?smPlus/smTR*100:0,minusDI=smTR?smMinus/smTR*100:0;
  const atrPct=atr/c[c.length-1]*100;
  const atrHist=[];
  // Compare each historical ATR with that bar's own close, not today's close.
  for(let end=Math.max(14,trs.length-100);end<=trs.length;end++){
    const window=trs.slice(end-14,end);
    const closeAtEnd=c[end];
    if(window.length===14&&Number.isFinite(closeAtEnd)&&closeAtEnd>0){
      atrHist.push(window.reduce((a,b)=>a+b,0)/14/closeAtEnd*100);
    }
  }
  const atrRank=atrHist.length?atrHist.filter(x=>x<=atrPct).length/atrHist.length*100:50;
  const rsi=wilderRsi(c,14);
  const avgVol=v.slice(-21,-1).reduce((a,b)=>a+b,0)/20,relVol=avgVol>0?v[v.length-1]/avgVol:null;
  const last=bars[bars.length-1],prior=bars.slice(-21,-1);
  const dcHigh=Math.max(...prior.map(x=>x.high)),dcLow=Math.min(...prior.map(x=>x.low));
  const vwapVol=bars.slice(-20).reduce((a,x)=>a+x.volume,0);
  const vwap=vwapVol?bars.slice(-20).reduce((a,x)=>a+(x.high+x.low+x.close)/3*x.volume,0)/vwapVol:last.close;
  const price=last.close, slope=finite(prev20)&&prev20!==0?(e20/prev20-1)*100:0;
  const mid=n=>(Math.max(...h.slice(-n))+Math.min(...l.slice(-n)))/2;
  const tenkan=mid(9),kijun=mid(26),spanA=(tenkan+kijun)/2,spanB=mid(52),cloudHigh=Math.max(spanA,spanB),cloudLow=Math.min(spanA,spanB);
  const ichimokuBull=price>cloudHigh&&tenkan>kijun,ichimokuBear=price<cloudLow&&tenkan<kijun;
  const typical=bars.slice(-20).map(x=>(x.high+x.low+x.close)/3),typicalMean=typical.reduce((a,b)=>a+b,0)/typical.length,typicalDev=typical.reduce((a,b)=>a+Math.abs(b-typicalMean),0)/typical.length;
  const cci=typicalDev?(typical[typical.length-1]-typicalMean)/(.015*typicalDev):0;
  const keltnerUpper=e20+2*atr,keltnerLower=e20-2*atr;
  const start=Math.max(1,bars.length-40);
  let supertrend=c[start-1]>=ema(c.slice(Math.max(0,start-200),start),20)?"UP":"DOWN",stUpper=Infinity,stLower=-Infinity;
  for(let i=start;i<bars.length;i++){
    const mp=(h[i]+l[i])/2,previousUpper=stUpper,previousLower=stLower;
    const trWindow=trs.slice(Math.max(0,i-14),i),localAtr=trWindow.length?trWindow.reduce((a,b)=>a+b,0)/trWindow.length:atr;
    const basicUpper=mp+1.5*Math.max(localAtr,1e-12),basicLower=mp-1.5*Math.max(localAtr,1e-12);
    stUpper=i===start?basicUpper:(basicUpper<previousUpper||c[i-1]>previousUpper?basicUpper:previousUpper);
    stLower=i===start?basicLower:(basicLower>previousLower||c[i-1]<previousLower?basicLower:previousLower);
    if(supertrend==="DOWN"&&c[i]>previousUpper)supertrend="UP";
    else if(supertrend==="UP"&&c[i]<previousLower)supertrend="DOWN";
  }
  const bull=price>e20&&e20>e50&&e50>e200&&slope>0&&ichimokuBull&&supertrend==="UP";
  const bear=price<e20&&e20<e50&&e50<e200&&slope<0&&ichimokuBear&&supertrend==="DOWN";
  return {valid:true,count:c.length,price,ema20:e20,ema50:e50,ema200:e200,emaSlope:slope,adx,plusDI,minusDI,choppiness:chop,atr,atrPct,atrPercentile:atrRank,rsi,cci,relativeVolume:relVol,vwap,keltnerUpper,keltnerLower,ichimokuBull,ichimokuBear,supertrend,donchianHigh:dcHigh,donchianLow:dcLow,bull,bear,last,high20:Math.max(...h.slice(-20)),low20:Math.min(...l.slice(-20)),_prior10:bars.slice(-11,-1),_older10:bars.slice(-21,-11)};
}
function regimeOf(x){
  if(!x.valid)return "INSUFFICIENT_DATA";
  if(x.atrPercentile>=90||x.atrPct>=2.5)return "HIGH_VOLATILITY";
  if(x.bull&&x.adx>=22&&x.choppiness<61.8)return "STRONG_BULLISH";
  if(x.bear&&x.adx>=22&&x.choppiness<61.8)return "STRONG_BEARISH";
  if(x.choppiness>=61.8||x.adx<18)return "SIDEWAYS";
  return "MIXED";
}
function sign(x){return x>0?1:x<0?-1:0;}
function strategyScores(x, regime){
  if(!x?.valid||!x.last)return {
    trend:{direction:0,score:0,evidence:[]},
    breakout:{direction:0,score:0,evidence:[]},
    range:{direction:0,score:0,evidence:[]},
    reversal:{direction:0,score:0,evidence:[]}
  };
  const c=x.last,range=Math.max(1e-12,c.high-c.low),closePos=(2*c.close-c.high-c.low)/range;
  const trend=x.bull?1:x.bear?-1:0;
  const pullback=Math.abs(c.close-x.ema20)<=x.atr*1.25;
  const trendScore=trend&&sign(x.rsi-50)===trend&&sign(c.close-x.vwap)===trend&&pullback&&sign(closePos)===trend?trend:0;
  const breakout=c.close>x.donchianHigh&&x.relativeVolume>=1.3?1:c.close<x.donchianLow&&x.relativeVolume>=1.3?-1:0;
  const nearLow=c.close<=x.low20+x.atr*.35,nearHigh=c.close>=x.high20-x.atr*.35;
  const rangeScore=regime==="SIDEWAYS"?(nearLow&&x.rsi<38&&x.cci<-80&&c.close>x.keltnerLower&&closePos>0.25?1:nearHigh&&x.rsi>62&&x.cci>80&&c.close<x.keltnerUpper&&closePos<-.25?-1:0):0;
  // BOS/CHoCH and liquidity-sweep logic is deliberately disabled until
  // swing points and post-sweep confirmation are independently validated.
  const reversal=0;
  return {
    trend:{direction:trendScore,score:trendScore?78:0,evidence:["EMA20/50/200 alignment","EMA slope","RSI and VWAP confirmation"]},
    breakout:{direction:breakout,score:breakout?82:0,evidence:["Close beyond previous 20-candle Donchian level","Relative volume >= 1.3"]},
    range:{direction:rangeScore,score:rangeScore?76:0,evidence:["Sideways regime","Support/resistance proximity","RSI rejection and candle close position"]},
    reversal:{direction:reversal,score:0,evidence:["Disabled pending independent swing-point and CHoCH validation"]}
  };
}
function evaluateV2({symbol,timeframe,data,market,now=Date.now(),accountEquity=null,config={}}){
  const frames=data?.candles||{};
  const four=confirmed(frames["4h"],"4h",now);
  const one=confirmed(frames["1h"],"1h",now);
  const fifteen=confirmed(frames["15m"],"15m",now);
  const entryTf=["1m","5m","15m","30m","1h","4h"].includes(timeframe)?timeframe:"15m";
  const entry=confirmed(frames[entryTf],entryTf,now);
  const s4=stats(four),s1=stats(one),s15=stats(fifteen),se=stats(entry);
  const regimes=[regimeOf(s4),regimeOf(s1),regimeOf(s15)];
  const regime=[...regimes,regimeOf(se)].includes("HIGH_VOLATILITY")?"HIGH_VOLATILITY":regimes[0];
  const strategies=strategyScores(se,regime);
  const eligible=Object.entries(strategies).filter(([k,v])=>v.direction!==0&&v.score>0);
  eligible.sort((a,b)=>b[1].score-a[1].score);
  const selected=eligible[0]||null;
  const direction=selected?selected[1].direction:0;
  const directionName=direction>0?"LONG":direction<0?"SHORT":"NO TRADE";
  const price=Number(market?.ticker?.last);
  const bid=Number(market?.ticker?.bid),ask=Number(market?.ticker?.ask);
  const spreadPct=bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*100:null;
  const reasons=[];
  if(!s4.valid||!s1.valid||!s15.valid||!se.valid)reasons.push("4H/1H/15M/entry timeframe-এ পর্যাপ্ত নিশ্চিত candle নেই");
  if(regime==="HIGH_VOLATILITY")reasons.push("High-volatility regime: নতুন trade বন্ধ");
  if(!selected)reasons.push("কোনো strategy-তে পূর্ণ entry setup নেই");
  const htfAligned=direction!==0&&(
    selected?.[0]==="range"
      ? regimes[0]==="SIDEWAYS"&&regimes[1]==="SIDEWAYS"
      : (direction>0&&s4.bull&&s1.bull)||(direction<0&&s4.bear&&s1.bear)
  );
  if(direction!==0&&!htfAligned)reasons.push("4H ও 1H trend একই দিকে নিশ্চিত নয়");
  const s15Entry=strategyScores(s15,regimes[2])[selected?.[0]||"trend"];
  const entryAligned=direction!==0&&(
    selected?.[0]==="range"
      ? regimes[2]==="SIDEWAYS"&&s15Entry?.direction===direction
      : selected?.[0]==="breakout"
        ? s15Entry?.direction===direction
        : direction>0?s15.bull: s15.bear
  );
  if(direction!==0&&!entryAligned)reasons.push("15M entry confirmation অনুপস্থিত");
  if(!finite(price)||price<=0)reasons.push("Live ticker price অনুপস্থিত বা অবৈধ");
  if(spreadPct===null)reasons.push("Bid/Ask spread data অনুপস্থিত");
  else if(spreadPct>Number(config.maxSpreadPct??0.10))reasons.push("Spread অনুমোদিত সীমার বেশি");
  if(se.atr<=0||!finite(se.atr))reasons.push("ATR/stop distance অবৈধ");
  const scoreParts={
    trend:htfAligned?25:0,
    structure:selected?20:0,
    momentum:selected&&sign(se.rsi-50)===direction?15:0,
    volume:selected&&finite(se.relativeVolume)&&se.relativeVolume>=(selected[0]==="reversal"?1.1:1.3)?15:0,
    multiTimeframe:htfAligned&&entryAligned?15:0,
    regime:regime!=="HIGH_VOLATILITY"&&regime!=="INSUFFICIENT_DATA"?10:0
  };
  const score=Object.values(scoreParts).reduce((a,b)=>a+b,0);
  const confidenceScore=score;
  const entryPrice=price;
  const stopDistance=Math.max(se.atr*Number(config.atrStopMultiple??1.5),entryPrice*0.001);
  const stopLoss=direction>0?entryPrice-stopDistance:direction<0?entryPrice+stopDistance:null;
  const tp1=direction>0?entryPrice+2*stopDistance:direction<0?entryPrice-2*stopDistance:null;
  const tp2=direction>0?entryPrice+3*stopDistance:direction<0?entryPrice-3*stopDistance:null;
  const rr=direction?Math.abs(tp1-entryPrice)/Math.abs(entryPrice-stopLoss):0;
  if(direction&&rr+1e-9<2)reasons.push("Risk/Reward 1:2-এর কম");
  const mandatoryOk=reasons.length===0&&score>=75&&direction!==0;
  const decision=mandatoryOk?directionName:"NO TRADE";
  const equity=Number(accountEquity);
  const riskFraction=clamp(Number(config.riskPct??0.5),0.01,1)/100;
  const riskAmount=finite(equity)&&equity>0?equity*riskFraction:null;
  const positionSize=riskAmount!==null&&stopDistance>0?riskAmount/stopDistance:null;
  return {
    version:"V2",mode:"TESTING_ONLY",liveTrading:false,symbol,timeframe,
    marketRegime:regime,regimeByTimeframe:{ "4h":regimes[0],"1h":regimes[1],"15m":regimes[2]},
    mainTrend:s4.bull?"BULLISH":s4.bear?"BEARISH":"SIDEWAYS",
    selectedStrategy:selected?selected[0].toUpperCase():"NONE",
    strategies:Object.fromEntries(Object.entries(strategies).map(([k,v])=>[k,{...v}])),
    decision,confidenceScore,confidenceMeaning:"Rule-based score; not a calibrated win probability",
    entryPrice:decision==="NO TRADE"?null:entryPrice,stopLoss:decision==="NO TRADE"?null:stopLoss,
    takeProfit1:decision==="NO TRADE"?null:tp1,takeProfit2:decision==="NO TRADE"?null:tp2,
    riskReward:decision==="NO TRADE"?null:rr,riskPct:Number(config.riskPct??0.5),
    riskAmount,positionSize,spreadPct,scoreBreakdown:scoreParts,
    timeframeAgreement:{ "4h":s4.bull?"LONG":s4.bear?"SHORT":"NEUTRAL","1h":s1.bull?"LONG":s1.bear?"SHORT":"NEUTRAL","15m":s15.bull?"LONG":s15.bear?"SHORT":"NEUTRAL"},
    evidence:selected?.[1].evidence||[],contradictingEvidence:reasons,
    invalidation:decision==="LONG"?"Entry timeframe close below stop-loss / confirmed structure break":decision==="SHORT"?"Entry timeframe close above stop-loss / confirmed structure break":"No valid entry; remain flat",
    dataQuality:{ "4h":{valid:s4.valid,count:s4.count},"1h":{valid:s1.valid,count:s1.count},"15m":{valid:s15.valid,count:s15.count},entry:{valid:se.valid,count:se.count}},
    createdAt:new Date(now).toISOString()
  };
}
function backtestV2({candles,timeframe="15m",feeBps=6,slippageBps=3,holdBars=1,minimumTrades=500}={}){
  const bars=confirmed(candles,timeframe,Date.now());
  if(bars.length<220)return {status:"INSUFFICIENT_DATA",timeframe,bars:bars.length,requiredBars:220,trades:0,note:"কমপক্ষে ২২০টি নিশ্চিত candle দরকার; ৫০০ independent trade না হলে লক্ষ্য যাচাই হবে না"};
  const warmup=210,signals=[];
  for(let i=warmup;i<bars.length-1;i++){
    const sample=bars.slice(Math.max(0,i-999),i+1),x=stats(sample),regime=regimeOf(x),st=strategyScores(x,regime);
    const candidate=Object.entries(st).filter(([k,v])=>v.direction&&v.score>=76).sort((a,b)=>b[1].score-a[1].score)[0];
    if(!candidate)continue;
    const entry=bars[i+1].open,exitIndex=Math.min(bars.length-1,i+Math.max(1,holdBars));
    const exit=bars[exitIndex].close,dir=candidate[1].direction;
    const gross=(exit/entry-1)*dir*100,friction=2*(feeBps+slippageBps)/100;
    const net=gross-friction;
    signals.push({entryTime:bars[i+1].time,exitTime:bars[exitIndex].time,direction:dir>0?"LONG":"SHORT",strategy:candidate[0],grossPct:gross,netPct:net,outcome:net>0?"WIN":net<0?"LOSS":"FLAT"});
    i=exitIndex-1;
  }
  const wins=signals.filter(x=>x.netPct>0),losses=signals.filter(x=>x.netPct<0),grossWin=wins.reduce((a,x)=>a+x.netPct,0),grossLoss=Math.abs(losses.reduce((a,x)=>a+x.netPct,0));
  const net=signals.reduce((a,x)=>a+x.netPct,0),avg=signals.length?net/signals.length:0;
  const split=Math.floor(signals.length*.7),oos=signals.slice(split),oosWins=oos.filter(x=>x.netPct>0).length,oosLoss=oos.filter(x=>x.netPct<0).length;
  let equity=1,peak=1,maxDd=0;for(const x of signals){equity*=1+x.netPct/100;peak=Math.max(peak,equity);maxDd=Math.max(maxDd,(peak-equity)/peak*100);}
  const count=signals.length;
  return {status:"NOT_VALIDATED",sampleSizeReached:count>=minimumTrades,timeframe,bars:bars.length,trades:count,minimumTrades,winRate:count?wins.length/count*100:null,profitFactor:grossLoss?grossWin/grossLoss:null,expectancyPct:avg,netReturnPct:(equity-1)*100,maxDrawdownPct:maxDd,outOfSample:{trades:oos.length,winRate:oos.length?oosWins/oos.length*100:null,netPct:oos.reduce((a,x)=>a+x.netPct,0),expectancyPct:oos.length?oos.reduce((a,x)=>a+x.netPct,0)/oos.length:null,positiveNet:oos.reduce((a,x)=>a+x.netPct,0)>0},costModel:{feeBps,slippageBps},long:{trades:signals.filter(x=>x.direction==="LONG").length},short:{trades:signals.filter(x=>x.direction==="SHORT").length},validation:"NOT_VALIDATED: single-timeframe simulation only; live-equivalent multi-timeframe walk-forward and independent paper-trade validation are required.",note:"Single-timeframe preliminary simulation; does not replace walk-forward, multi-timeframe, paper trading, or independent validation.",sample:signals.slice(-100)};
}
export { evaluateV2, backtestV2 };
