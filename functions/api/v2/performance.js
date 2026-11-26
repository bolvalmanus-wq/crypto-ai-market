export async function onRequest({request,env}){
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405});
  const workerUrl=env.MARKET_WORKER_URL||"https://crypto-ai-market-worker.bolvalmanus-wq.workers.dev";
  try{
    const response=await fetch(new URL("/v2/performance",workerUrl),{headers:{Accept:"application/json","Cache-Control":"no-cache"},signal:AbortSignal.timeout(12000)});
    const body=await response.text();let data;try{data=JSON.parse(body)}catch(_){return Response.json({error:"V2 scheduler returned non-JSON",details:body.slice(0,250)},{status:502,headers:{"Cache-Control":"no-store"}})}
    return Response.json(data,{status:response.status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }catch(error){return Response.json({error:"V2 paper report unavailable",details:error instanceof Error?error.message:String(error)},{status:502,headers:{"Cache-Control":"no-store"}})}
}