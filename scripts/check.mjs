import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root=process.cwd(),ignored=new Set([".git","node_modules",".wrangler"]),files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory()&&ignored.has(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else files.push(full);}}
walk(root);
const errors=[],jsFiles=files.filter(file=>/\.(?:js|mjs|cjs)$/.test(file));
for(const file of jsFiles){const r=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});if(r.status!==0)errors.push(path.relative(root,file)+": "+(r.stderr||r.stdout).trim());}
for(const file of files.filter(x=>/\.html$/.test(x))){
 const html=fs.readFileSync(file,"utf8"),scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
 for(let i=0;i<scripts.length;i++){const attrs=scripts[i][1]||"",source=scripts[i][2]||"";if(/type\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attrs)||!source.trim())continue;try{new Function(source);}catch(error){errors.push(path.relative(root,file)+" inline script #"+(i+1)+": "+error.message);}}
}
try{JSON.parse(fs.readFileSync(path.join(root,"manifest.webmanifest"),"utf8"));}catch(error){errors.push("manifest.webmanifest: "+error.message);}
const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
if(pkg.type!=="module"||!pkg.scripts?.test)errors.push("package.json: expected ES module and test script");
const wrangler=fs.readFileSync(path.join(root,"wrangler.toml"),"utf8");
for(const required of ['main = "worker.js"','binding = "ANALYSIS_KV"','crons = ["* * * * *"]'])if(!wrangler.includes(required))errors.push("wrangler.toml missing "+required);
for(const required of ["worker.js","trading-v2.js","index.html","performance.html","functions/api/market.js","functions/api/price.js","functions/api/scheduled.js","functions/api/push.js","functions/api/performance.js","functions/api/v2/backtest.js","functions/api/v2/performance.js"])if(!fs.existsSync(path.join(root,required)))errors.push("Required project file missing: "+required);
if(errors.length){console.error(errors.join("\n"));process.exit(1);}
console.log("Project checks passed: "+jsFiles.length+" JavaScript files, inline HTML scripts, manifest, Wrangler bindings and required routes.");
