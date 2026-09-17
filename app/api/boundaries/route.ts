import type { AdminCollection, AdminFeature } from "../../admin-geography";

const cache=new Map<string,{at:number;data:AdminCollection}>();
const pending=new Map<string,Promise<AdminCollection>>();
const sourceUrl="https://www.geoboundaries.org/";
async function limitedJson(response: Response) {
  if(!response.ok || !response.body) throw new Error("Boundary source unavailable");
  const reader=response.body.getReader(), chunks:Uint8Array[]=[];
  let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read(); if(done)break;
      size+=value.byteLength;
      if(size>12_000_000)throw new Error("Boundary layer exceeds display budget");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function load(country:string):Promise<AdminCollection> {
  const metadataResponse=await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${country}/ADM2/`,{signal:AbortSignal.timeout(15000)});
  if(metadataResponse.status===404) return {features:[],source:"geoBoundaries",sourceUrl,label:"市／县级行政区"};
  const metadata=await limitedJson(metadataResponse);
  const url=new URL(metadata.simplifiedGeometryGeoJSON);
  if(url.protocol!=="https:" || !["github.com","raw.githubusercontent.com","media.githubusercontent.com"].includes(url.hostname))throw new Error("Invalid boundary source");
  const raw=await limitedJson(await fetch(url,{signal:AbortSignal.timeout(40000)}));
  if(!Array.isArray(raw.features))throw new Error("Invalid boundary data");
  const features:AdminFeature[]=raw.features.filter((f:any)=>["Polygon","MultiPolygon"].includes(f.geometry?.type)).map((f:any)=>({
    type:"Feature",geometry:f.geometry,properties:{id:String(f.properties.shapeID),name:String(f.properties.shapeName),country,level:"2"},
  }));
  const label=country==="USA" ? "县级行政区" : "市／县级行政区";
  return {features,source:`geoBoundaries · ${metadata.boundaryYearRepresented || "现代"}`,sourceUrl,label};
}
export async function GET(request:Request) {
  const country=new URL(request.url).searchParams.get("country") || "";
  if(!/^[A-Z]{3}$/.test(country) || ["CHN","TWN","HKG","MAC"].includes(country)) return Response.json({error:"无效地区"},{status:400});
  const saved=cache.get(country);
  if(saved && Date.now()-saved.at<86400000)return Response.json(saved.data);
  try {
    let task=pending.get(country);
    if(!task){task=load(country);pending.set(country,task);}
    const data=await task;
    // Keep the Worker below its memory limit; larger layers are cached by
    // the browser, not retained as coordinate arrays in the server isolate.
    if(data.features.length<=750){cache.clear();cache.set(country,{at:Date.now(),data});}
    return Response.json(data,{headers:{"Cache-Control":"public, max-age=86400"}});
  } catch { return Response.json({error:"此地区的下一级边界暂时无法加载，请稍后重试。"},{status:503}); }
  finally {pending.delete(country);}
}
