import { fetchMarketWorker, readWorkerJson, proxyJson } from "../_shared/worker-proxy.js";
export async function onRequest({request,env}) {
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405});
  const incoming=new URL(request.url),days=incoming.searchParams.get("days")||"5";
  try{
    const response=await fetchMarketWorker(env,"/observations?days="+encodeURIComponent(days),{headers:{Accept:"application/json","Cache-Control":"no-cache"},signal:AbortSignal.timeout(15000)});
    const data=await readWorkerJson(response,"Worker observations endpoint");
    return proxyJson(data,response.status);
  }catch(error){console.error("Observations proxy failed",String(error));return proxyJson({error:"পর্যবেক্ষণের তথ্য আনা যায়নি",details:error instanceof Error?error.message:String(error)},error?.status||502);}
}