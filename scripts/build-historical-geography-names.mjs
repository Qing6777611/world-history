#!/usr/bin/env node
/** Refresh the committed Chinese-name snapshot. Geometry builds never call this service. */
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Converter } from 'opencc-js';
import { createTranslator, atomicJson, readCache } from './translate-events.mjs';
import { packBatches, hasChinese } from './translation-utils.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const run=promisify(execFile);
const normalize=s=>s.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const keyFor=name=>createHash('sha256').update(name).digest('hex').slice(0,16);
const toSimplified=Converter({from:'tw',to:'cn'});
async function wikidataRequest(url){
  const headersPath=resolve(ROOT,'.cache/history/wikidata-response.headers');
  for(let attempt=0;attempt<4;attempt++){
    const {stdout}=await run('curl',['-sSL','--max-time','45','-D',headersPath,'-w','\n%{http_code}','-A','WorldHistoryAtlas/1.0 data build',url.href],{maxBuffer:5e6});
    const split=stdout.lastIndexOf('\n'),status=Number(stdout.slice(split+1));
    if(status>=200&&status<300)return JSON.parse(stdout.slice(0,split));
    if(![408,429,500,502,503,504].includes(status)||attempt===3)throw new Error(`Wikidata HTTP ${status}; saved labels remain intact`);
    const headers=await readFile(headersPath,'utf8');
    const retryAfter=[...headers.matchAll(/^retry-after:\s*(.+)$/gim)].at(-1)?.[1].trim();
    const requested=retryAfter?/^\d+$/.test(retryAfter)?Number(retryAfter)*1000:Math.max(0,Date.parse(retryAfter)-Date.now()):0;
    let remaining=Math.max(requested||0,30_000*2**attempt);
    console.log(`Wikidata HTTP ${status}; waiting ${Math.ceil(remaining/1000)}s before retry`);
    while(remaining>0){const step=Math.min(remaining,60_000);await new Promise(r=>setTimeout(r,step));remaining-=step;}
  }
}
export function chooseWikidataName(polity,labels){
  // Relations often inherit the QID of only one component. Different English
  // source names must not collapse to that component or a modern successor.
  if(polity.type!=='POLITY'||polity.wikidataIds.length!==1)return null;
  const item=labels[polity.wikidataIds[0]];
  if(!item||!hasChinese(item.zh)||![item.en,...item.aliases??[]].some(n=>normalize(n)===normalize(polity.nameEn)))return null;
  return {name: item.zh, source:'wikidata', wikidataId:polity.wikidataIds[0]};
}
export async function buildNames({offline=false}={}){
  const polities=JSON.parse(await readFile(resolve(ROOT,'.cache/history/polities.json'),'utf8'));
  const dir=resolve(ROOT,'data/history');await mkdir(dir,{recursive:true});
  const labels=await readCache(resolve(dir,'wikidata-zh.json'));
  const reviewed=await readCache(resolve(dir,'name-overrides.json'));
  const mt=await readCache(resolve(dir,'names-mt.json'));
  const missing=[...new Set(polities.flatMap(p=>p.wikidataIds))].filter(id=>!(id in labels));
  if(offline&&missing.length)throw new Error(`${missing.length} Wikidata entries missing; refresh names without --offline first`);
  for(let i=0;i<missing.length;i+=50){
    const ids=missing.slice(i,i+50),url=new URL('https://www.wikidata.org/w/api.php');
    url.search=new URLSearchParams({action:'wbgetentities',ids:ids.join('|'),props:'labels|aliases',languages:'en|zh-hans|zh-cn|zh',format:'json'});
    const entities=(await wikidataRequest(url)).entities;if(!entities)throw new Error('Wikidata returned no entities');
    for(const id of ids){const e=entities[id];labels[id]={en:e?.labels?.en?.value??'',zh:e?.labels?.['zh-hans']?.value??e?.labels?.['zh-cn']?.value??e?.labels?.zh?.value??'',aliases:e?.aliases?.en?.map(a=>a.value)??[]};}
    await atomicJson(resolve(dir,'wikidata-zh.json'),labels);console.log(`Wikidata ${Math.min(i+50,missing.length)}/${missing.length}`);
    await new Promise(r=>setTimeout(r,2500));
  }
  const pending=polities.filter(p=>!hasChinese(reviewed[p.nameEn])&&!chooseWikidataName(p,labels)&&!hasChinese(mt[p.nameEn]));
  if(offline&&pending.length)throw new Error(`${pending.length} Chinese names missing; refresh names without --offline first`);
  const translate=createTranslator({interval:700});let completed=0;
  for(const batch of packBatches(pending.map(p=>({key:keyFor(p.nameEn),source:p.nameEn})),2500)){
    const result=await translate(batch);
    for(const item of result){if(item.valid)mt[item.source]=item.text;else console.error(`Name needs review: ${item.source}: ${item.reasons.join(',')} (${item.text})`);}
    await atomicJson(resolve(dir,'names-mt.json'),mt);completed+=batch.length;console.log(`Names translated ${completed}/${pending.length}`);
  }
  const names={};const failures=[];
  for(const p of polities){const wd=chooseWikidataName(p,labels);const value=hasChinese(reviewed[p.nameEn])?{name:reviewed[p.nameEn],source:'reviewed'}:wd??(hasChinese(mt[p.nameEn])?{name:mt[p.nameEn],source:'mt'}:null);if(value)names[p.nameEn]={...value,name:toSimplified(value.name)};else failures.push(p.nameEn);}
  await atomicJson(resolve(dir,'names-zh.json'),names);console.log(JSON.stringify({total:polities.length,covered:Object.keys(names).length,failures,sources:Object.values(names).reduce((a,n)=>(a[n.source]=(a[n.source]??0)+1,a),{})}));
  if(failures.length)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.some(a=>a!=='--offline'))throw new Error('Usage: node scripts/build-historical-geography-names.mjs [--offline]');
 buildNames({offline:args.includes('--offline')}).catch(e=>{console.error(e);process.exitCode=1});
}
