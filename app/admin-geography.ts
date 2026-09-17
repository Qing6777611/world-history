import type { CountryFeature, Coordinate } from "./country-geometry";

export type City = { id: string; name: string; country: string; lat: number; lng: number; rank: number; capital: boolean; population: number };
export type AdminFeature = CountryFeature & { properties: { id: string; name: string; country: string; level: string; english?: string } };
export type AdminCollection = { features: AdminFeature[]; source: string; sourceUrl: string; label: string };
export const isAdmin = (f: CountryFeature): f is AdminFeature => !!f.properties.level;
export const featurePolygons = (f: CountryFeature) => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
const wrapped = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;

// Globe.GL's spherical polygons use clockwise exterior rings. DataV and
// geoBoundaries use the opposite convention; normalize without moving points.
export function orientDivision(feature: AdminFeature): AdminFeature {
  for(const polygon of featurePolygons(feature)) {
    polygon.forEach((ring,index)=>{
      const origin=ring[0][0];let area=0;
      for(let i=0;i<ring.length-1;i++)area+=(origin+wrapped(ring[i][0]-origin))*ring[i+1][1]-(origin+wrapped(ring[i+1][0]-origin))*ring[i][1];
      if((index===0 && area>0) || (index>0 && area<0))ring.reverse();
    });
  }
  return feature;
}

function insideRing(ring: Coordinate[], lng: number, lat: number) {
  let inside = false;
  const origin=ring[0][0], x=origin+wrapped(lng-origin);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = origin+wrapped(ring[i][0]-origin), xj = origin+wrapped(ring[j][0]-origin);
    const yi = ring[i][1], yj = ring[j][1];
    if (Math.abs(xi - xj) > 180) continue;
    if ((yi > lat) !== (yj > lat) && x < (xj-xi)*(lat-yi)/(yj-yi)+xi) inside = !inside;
  }
  return inside;
}
export function containsPlace(f: CountryFeature, place: { lat: number; lng: number }) {
  return featurePolygons(f).some(rings => insideRing(rings[0],place.lng,place.lat) && !rings.slice(1).some(r => insideRing(r,place.lng,place.lat)));
}
export function featureCenter(f: CountryFeature) {
  const rings = featurePolygons(f).map(p => p[0]);
  const ring = rings.reduce((a,b) => a.length>b.length ? a : b);
  const origin = ring[0][0];
  let area=0, x=0, y=0;
  for(let i=0;i<ring.length-1;i++) {
    const ax=origin+wrapped(ring[i][0]-origin), bx=origin+wrapped(ring[i+1][0]-origin);
    const ay=ring[i][1], by=ring[i+1][1], cross=ax*by-bx*ay;
    area+=cross; x+=(ax+bx)*cross; y+=(ay+by)*cross;
  }
  const candidate = area ? {lng:wrapped(x/(3*area)),lat:y/(3*area)} : {lng:ring[0][0],lat:ring[0][1]};
  return containsPlace(f,candidate) ? candidate : {lng:ring[0][0],lat:ring[0][1]};
}
export function childBelongsTo(child: CountryFeature, parent: CountryFeature) {
  if(containsPlace(parent,featureCenter(child))) return true;
  const ring=featurePolygons(child).reduce((a,b)=>a[0].length>b[0].length?a:b)[0];
  const samples=ring.filter((_,i)=>i%Math.max(1,Math.floor(ring.length/12))===0);
  return samples.filter(([lng,lat])=>containsPlace(parent,{lat,lng})).length > samples.length*.55;
}

export function adminColor(id: string) {
  const colors=["#94a99b","#afa68c","#8fabb4","#ac9ca9","#a5b28f","#b0a08c"];
  let hash=0; for(const char of id) hash=(hash*31+char.charCodeAt(0))|0;
  return colors[Math.abs(hash)%colors.length];
}

const cache = new Map<string, AdminCollection>();
export async function loadDivisions(country: string, parent: AdminFeature | null, signal: AbortSignal): Promise<AdminCollection> {
  const key = country + (parent ? `-${parent.properties.id}` : "");
  if(cache.has(key)) return cache.get(key)!;
  let data: AdminCollection;
  if(!parent || country === "CHN") {
    const response=await fetch(`/data/boundaries/${key}.json`,{signal});
    if(response.status===404) return {features:[],source:"Natural Earth",sourceUrl:"https://www.naturalearthdata.com/",label:"行政区划"};
    if(!response.ok) throw new Error("边界暂时无法加载");
    data=await response.json();
  } else {
    const countryKey=`${country}-ADM2`;
    let all=cache.get(countryKey);
    if(!all) {
      // A locally prepared layer is available for the most frequently used map.
      const response=await fetch(country==="USA" ? "/data/boundaries/USA-ADM2.json" : `/api/boundaries?country=${country}`,{signal});
      if(!response.ok) throw new Error("此地区的下一级边界暂时无法加载");
      all=await response.json() as AdminCollection;
      all.features=all.features.map(orientDivision);
      if(cache.size>28) cache.delete(cache.keys().next().value!);
      cache.set(countryKey,all);
    }
    data={...all,features:all.features.filter(f=>childBelongsTo(f,parent))};
  }
  data.features=data.features.map(orientDivision);
  if(cache.size>28) cache.delete(cache.keys().next().value!);
  cache.set(key,data);
  return data;
}
