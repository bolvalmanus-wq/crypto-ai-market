export async function onRequest({request,env}){
  if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});
  const workerUrl=env.MARKET_WORKER_URL||"https://crypto-ai-market-worker.bolvalmanus-wq.workers.dev";
  try{
    const body=await request.json();
    const response=await fetch(new URL("/v2/backtest",workerUrl),{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    const text=await response.text();let data;try{data=JSON.parse(text)}catch(_){return Response.json({error:"V2 backtest returned non-JSON",details:text.slice(0,250)},{status:502,headers:{"Cache-Control":"no-store"}})}
    return Response.json(data,{status:response.status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }catch(error){return Response.json({error:"V2 backtest unavailable",details:error instanceof Error?error.message:String(error)},{status:502,headers:{"Cache-Control":"no-store"}})}
}