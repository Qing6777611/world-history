import { normalizeDayHistory, type DayHistory, type WikiEvent } from "../../on-this-day";
import type { AtlasEvent } from "../../demo-data";

const cache = new Map<string, { expires: number; data: DayHistory }>();
const inFlight = new Map<string, Promise<DayHistory>>();
const MAX_AGE = 6*60*60*1000;
const HEADERS = { "User-Agent": "WorldHistoryAtlas/1.0 (https://world-history-atlas.lucky6777611.chatgpt.site/)", Accept: "application/json" };
type Statement = { rank?:string; qualifiers?:Record<string,unknown>; mainsnak?:{datavalue?:{value?:string | {id?:string}}} };
type Entity = {claims?:Record<string,Statement[]>};
async function entities(ids:string[]):Promise<Record<string,Entity>> {
  if(!ids.length)return {};
  const params=new URLSearchParams({action:"wbgetentities",ids:ids.join("|"),props:"claims",format:"json"});
  const response=await fetch(`https://www.wikidata.org/w/api.php?${params}`,{headers:HEADERS,signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error("Country metadata unavailable");
  return ((await response.json()) as {entities:Record<string,Entity>}).entities || {};
}
async function addCountries(events:AtlasEvent[]) {
  // Country membership comes from the location's current metadata, not from
  // coarse map boundaries (which misclassify cities near borders and coasts).
  const ids=[...new Set(events.filter(e=>!e.country).map(e=>e.historical?.locationEntity).filter((id):id is string=>!!id))].slice(0,50);
  try {
    const places=await entities(ids), placeCountries=new Map<string,string>();
    for(const [id,entity] of Object.entries(places)) {
      let claims=(entity.claims?.P17 || []).filter(c=>c.rank!=="deprecated" && !c.qualifiers?.P582);
      if(claims.some(c=>c.rank==="preferred")) claims=claims.filter(c=>c.rank==="preferred");
      const countries=[...new Set(claims.map(c=>c.mainsnak?.datavalue?.value).map(v=>typeof v==="object" ? v.id : undefined).filter((v):v is string=>!!v))];
      if(countries.length===1)placeCountries.set(id,countries[0]);
    }
    const countries=await entities([...new Set(placeCountries.values())]);
    for(const event of events) {
      if(event.country)continue;
      const id=placeCountries.get(event.historical?.locationEntity || "");
      const code=id ? countries[id]?.claims?.P298?.find(c=>c.rank!=="deprecated")?.mainsnak?.datavalue?.value : undefined;
      if(typeof code==="string" && /^[A-Z]{3}$/.test(code)) event.country=code==="TWN" ? "CHN" : code;
    }
  } catch { return {events,partial:true}; }
  return {events,partial:false};
}

async function feed(type: "events" | "selected", month: number, day: number): Promise<WikiEvent[]> {
  const url=`https://zh.wikipedia.org/api/rest_v1/feed/onthisday/${type}/${String(month).padStart(2,"0")}/${String(day).padStart(2,"0")}`;
  const response=await fetch(url, {headers:HEADERS, signal:AbortSignal.timeout(12_000)});
  if(!response.ok) throw new Error(`History source returned ${response.status}`);
  const data=await response.json() as Record<string, WikiEvent[]>;
  if(!Array.isArray(data[type])) throw new Error("History source returned invalid data");
  return data[type];
}

export async function GET(request: Request) {
  const params=new URL(request.url).searchParams, month=Number(params.get("month")), day=Number(params.get("day"));
  const date=new Date(Date.UTC(2000,month-1,day));
  if(!Number.isInteger(month)||!Number.isInteger(day)||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)
    return Response.json({error:"日期无效"},{status:400});
  const key=`${month}-${day}`, saved=cache.get(key);
  if(saved && saved.expires>Date.now()) return Response.json(saved.data);
  try {
    let pending=inFlight.get(key);
    if(!pending) {
      pending=Promise.all([feed("events",month,day),feed("selected",month,day).catch(()=>[])]).then(async ([raw,selected])=>{
        const enriched=await addCountries(normalizeDayHistory(raw,selected,month,day));
        const data: DayHistory={month,day,...enriched,fetchedAt:new Date().toISOString()};
        if(cache.size>=16) cache.delete(cache.keys().next().value!);
        cache.set(key,{data,expires:Date.now()+(data.partial ? 60_000 : MAX_AGE)});
        return data;
      });
      inFlight.set(key,pending);
    }
    return Response.json(await pending);
  } catch {
    if(saved) return Response.json({...saved.data,stale:true});
    return Response.json({error:"历史资料暂时无法加载，请稍后重试。"},{status:503});
  } finally { inFlight.delete(key); }
}
