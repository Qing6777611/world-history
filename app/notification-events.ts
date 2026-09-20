import { hasCoordinates, type AtlasEvent } from "./demo-data";

// A small editorial selection for the interaction prototype. Priority is
// explicit; recency is not used as a substitute for historical importance.
const FEATURED = [
  {year:1894,match:/黄海|黃海/,title:"黄海海战",preview:"北洋水师与日本联合舰队在黄海交战。",priority:100},
  {year:1787,match:/宪法|憲法/,title:"美国宪法签署",preview:"制宪会议代表在费城签署美国宪法。",priority:95},
  {year:1978,match:/戴维营|戴維營/,title:"戴维营协议签署",preview:"埃及与以色列领导人在白宫签署协议。",priority:90},
  {year:1988,match:/奥林匹克|奧林匹克/,title:"汉城奥运会开幕",preview:"第 24 届夏季奥运会在今天的首尔开幕。",priority:85},
  {year:2011,match:/華爾街|华尔街/,title:"占领华尔街运动开始",preview:"示威者走进纽约金融区，一场运动由此展开。",priority:80},
  {year:2008,match:/残疾人奥运会|殘疾人奧運會/,title:"北京残奥会闭幕",preview:"第十三届夏季残奥会在北京落下帷幕。",priority:75},
  {year:1999,match:/首都.*機場|首都.*机场/,title:"首都机场 T2 航站楼启用",preview:"北京首都国际机场迎来新的航站楼。",priority:65},
  {year:2004,match:/帕拉林匹克/,title:"雅典残奥会开幕",priority:55},
  {year:1631,match:/布賴滕費爾德|布赖滕费尔德/,title:"布赖滕费尔德战役",priority:50},
  {year:1567,match:/稻葉山城|稻叶山城/,title:"信长攻陷稻叶山城",priority:45},
];
function featured(event:AtlasEvent) {
  return event.historical?.month===9 && event.historical.day===17 ? FEATURED.find(f=>f.year===event.start && f.match.test(event.title)) : undefined;
}
export function notificationCopy(event:AtlasEvent) {
  const copy=featured(event);
  return {title:copy?.title || event.title, preview:copy?.preview || (event.historical ? event.location : `${event.location} · ${event.category}的历史片段`)};
}
export type CountryMessages = { country: string; lat: number; lng: number; events: AtlasEvent[] };
function orderedEvents(events:AtlasEvent[], selectedId?:string) {
  return events.map((event,index)=>({event,index,priority:featured(event)?.priority || 0}))
    .sort((a,b)=>Number(b.event.id===selectedId)-Number(a.event.id===selectedId) || b.priority-a.priority || a.index-b.index);
}
export function countryMessages(events:AtlasEvent[], selectedCountry:string|null) {
  const ordered=orderedEvents(events);
  const groups=new Map<string,CountryMessages>();
  for(const {event} of ordered){
    const country=event.country==="TWN" ? "CHN" : event.country || `place:${event.location}`;
    if(!hasCoordinates(event) || (selectedCountry && country!==selectedCountry))continue;
    if(!groups.has(country))groups.set(country,{country,lat:event.lat,lng:event.lng,events:[]});
    const group=groups.get(country)!;
    if(group.events.length<3)group.events.push(event);
  }
  return [...groups.values()].slice(0,6);
}

// In a country close-up, a stack belongs to one recorded place, never to
// multiple cities. The selected event survives both display limits.
export function locationMessages(events:AtlasEvent[], country:string, selectedId?:string, fallback?:{lat:number;lng:number}) {
  const groups=new Map<string,CountryMessages>();
  for(const {event} of orderedEvents(events,selectedId)) {
    const code=event.country==="TWN" ? "CHN" : event.country || `place:${event.location}`;
    if(code!==country)continue;
    const point=hasCoordinates(event) ? event : fallback;
    if(!point)continue;
    const key=hasCoordinates(event) ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : "country";
    if(!groups.has(key))groups.set(key,{country,lat:point.lat,lng:point.lng,events:[]});
    const group=groups.get(key)!;
    if(group.events.length<3)group.events.push(event);
  }
  return [...groups.values()].slice(0,6);
}
