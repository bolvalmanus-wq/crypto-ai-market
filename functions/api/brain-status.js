import { fetchMarketWorker, readWorkerJson, proxyJson } from "../_shared/worker-proxy.js";
export async function onRequest({request,env}) {
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405});
  try{
    const response=await fetchMarketWorker(env,"/brain/status",{headers:{Accept:"application/json","Cache-Control":"no-cache"},signal:AbortSignal.timeout(10000)});
    const data=await readWorkerJson(response,"Worker brain status endpoint");
    return proxyJson(data,response.status);
  }catch(error){
    console.error("Brain status proxy failed",String(error));
    return proxyJson({error:"AI Brain-এর অবস্থা পাওয়া যায়নি",details:error instanceof Error?error.message:String(error)},error?.status||502);
  }
}
