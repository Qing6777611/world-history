import { CATEGORY_COLORS, type AtlasEvent } from "./demo-data";

export type WikiPage = { title: string; wikibase_item?: string; description?: string; coordinates?: { lat: number; lon: number }; content_urls?: { desktop?: { page?: string } } };
export type WikiEvent = { year: number; text: string; pages: WikiPage[] };
export type DayHistory = { month: number; day: number; events: AtlasEvent[]; fetchedAt: string; stale?: boolean; partial?: boolean };
export const wikiDayUrl = (month: number, day: number) => `https://zh.wikipedia.org/wiki/${month}%E6%9C%88${day}%E6%97%A5`;
const isYearPage = (page: WikiPage) => /^-?\d+年$/.test(page.title) || /^(前|公元)/.test(page.title);
const pageUrl = (page: WikiPage) => `https://zh.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll("_", " "))}`;
// Reviewed coordinates from the linked Wikidata records; only applied to the
// matching anniversary and entity, never used as a fallback for unrelated events.
const REVIEWED_PLACES = [
  {year:1894, id:"Q385180", location:"黄海", lat:39.213889, lng:123.126389, country:""},
  {year:1862, id:"Q719252", location:"安提顿", lat:39.473333, lng:-77.744722, country:"USA"},
  {year:1631, id:"Q205379", location:"布赖滕费尔德", lat:51.4, lng:12.333333, country:"DEU"},
  {year:2008, id:"Q216864", location:"北京", lat:39.90403, lng:116.40753, country:"CHN"},
  {year:1567, id:"Q1367052", location:"岐阜城", lat:35.433889, lng:136.782222, country:"JPN"},
];

// Only specific geographic features are eligible. A country's representative
// point, an institution's headquarters or a person's burial place is not an event location.
export function eventLocation(pages: WikiPage[]) {
  return pages.filter(p => p.coordinates && Number.isFinite(p.coordinates.lat) && Number.isFinite(p.coordinates.lon) && Math.abs(p.coordinates.lat)<=90 && Math.abs(p.coordinates.lon)<=180)
    .filter(p => !/國家|国家|政府|機構|机构|組織|组织|公司|協會|协会|總部|总部|出生|政治人物/.test(p.description || ""))
    .filter(p => /城市|首都|首府|街道|公園|公园|機場|机场|戰役|战役|地震|火山|海戰|海战|城鎮|城镇|鄉鎮|乡镇|建築|建筑|遺址|遗址|宫殿|宮殿|大橋|大桥|體育場|体育场|廣場|广场|证券交易所|證券交易所/.test(`${p.title} ${p.description || ""}`))
    .sort((a,b) => Number(/首都|首府|城市/.test(a.description || ""))-Number(/首都|首府|城市/.test(b.description || "")))[0];
}

export function normalizeDayHistory(raw: WikiEvent[], selected: WikiEvent[], month: number, day: number): AtlasEvent[] {
  const seen = new Set<string>();
  const curated = new Set(selected.flatMap(e => e.pages.filter(p => !isYearPage(p)).map(p => `${e.year}:${p.wikibase_item || p.title}`)));
  return raw.filter(e => Number.isInteger(e.year) && e.year!==0 && typeof e.text === "string" && Array.isArray(e.pages))
    .filter(e=>!/來源請求|来源请求|citation needed/i.test(e.text))
    // Known date errors in the upstream September 17 index; omit rather than repeat them.
    .filter(e => !(month===9 && day===17 && ((e.year===1933 && /水壩|水坝/.test(e.text)) || (e.year===1900 && /澳大利/.test(e.text)))))
    .map(e => {
      const pages = e.pages.filter(p => !isYearPage(p));
      const location = eventLocation(pages);
      const id = `otd-${month}-${day}-${e.year}-${pages.map(p=>p.wikibase_item || p.title).join("-") || e.text}`;
      const event: AtlasEvent = {
        id, title: e.text.replace(/（圖）|\(pictured\)/g, ""), summary: "", location: location?.title.replaceAll("_", " ") || "地点待考证",
        region: "", country: "", lat: location?.coordinates?.lat, lng: location?.coordinates?.lon,
        start: e.year, end: e.year, category: "社会", color: CATEGORY_COLORS.交流,
        historical: { year:e.year, month, day, sourceUrl:wikiDayUrl(month,day), locationUrl:location ? pageUrl(location) : undefined, locationEntity:location?.wikibase_item },
      };
      const reviewed=month===9 && day===17 ? REVIEWED_PLACES.find(p=>p.year===e.year && pages.some(page=>page.wikibase_item===p.id)) : undefined;
      if(reviewed) {
        Object.assign(event,{location:reviewed.location,lat:reviewed.lat,lng:reviewed.lng,country:reviewed.country});
        event.historical!.locationUrl=`https://www.wikidata.org/wiki/${reviewed.id}`;
        event.historical!.locationEntity=reviewed.id;
      }
      // The accords were signed in the White House, not at the retreat where negotiations took place.
      if (month===9 && day===17 && e.year===1978 && /协议|協議/.test(e.text)) {
        event.title="埃及总统萨达特与以色列总理贝京在美国白宫签署《戴维营协议》。";
        event.location="华盛顿 · 白宫"; event.lat=38.8977; event.lng=-77.0365; event.country="USA";
        event.historical!.sourceUrl="https://history.state.gov/historicaldocuments/frus1977-80v09Ed2/d57";
        event.historical!.locationUrl=undefined;
      }
      const important = pages.some(p=>curated.has(`${e.year}:${p.wikibase_item || p.title}`));
      return { event, important };
    }).filter(({event}) => { if(seen.has(event.id))return false; seen.add(event.id);return true; })
    .sort((a,b)=>Number(b.important)-Number(a.important) || b.event.start-a.event.start).map(({event})=>event);
}
