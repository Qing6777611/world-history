import { hasCoordinates, yearLabel, type AtlasEvent } from "./atlas-model";
import { countryCode, countryRegion, countryView, type CountryFeature } from "./country-geometry";
import { notificationCopy, type CountryMessages } from "./notification-events";

export type GlobeBubble = CountryMessages & { name: string; selected?: boolean };

export function eventMatchesCountry(event: AtlasEvent, code: string, historical = false) {
  return historical ? event.country === code || !!event.polityIds?.includes(code)
    : (event.country === "TWN" ? "CHN" : event.country) === (code === "TWN" ? "CHN" : code);
}

/** Overview uses one primary polity per event; a polity close-up also includes
 * overlapping allegiances. Original event objects survive grouping unchanged. */
export function historicalEventBubbles(events: AtlasEvent[], features: CountryFeature[], {
  country = null, selectedId, locale = "zh",
}: { country?: string | null; selectedId?: string; locale?: "zh" | "en" } = {}): GlobeBubble[] {
  const byCode = new Map(features.map(feature => [countryCode(feature), feature]));
  const ordered = [...events].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
  const groups = new Map<string, GlobeBubble>();
  let fallback: { lat: number; lng: number } | undefined;
  for (const event of ordered) {
    if (country && !eventMatchesCountry(event, country, true)) continue;
    const primary = byCode.has(event.country) ? event.country : event.polityIds?.find(id => byCode.has(id));
    const code = country || primary || `place:${event.location}`;
    const feature = byCode.get(code);
    if (!hasCoordinates(event) && (!country || !feature)) continue;
    if (!hasCoordinates(event) && !fallback && feature) fallback = countryView(feature, 1, 50);
    const point = hasCoordinates(event) ? event : fallback!;
    const key = country ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : code;
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 6) continue;
      const center = !country && feature ? countryView(feature, 1, 50) : point;
      group = {
        country: code, lat: center.lat, lng: center.lng, events: [], selected: false,
        name: country && hasCoordinates(event) ? event.location : feature ? countryRegion(feature, locale).name : event.location,
      };
      groups.set(key, group);
    }
    if (group.events.length < 3) {
      group.events.push(event);
      if (event.id === selectedId) group.selected = true;
    }
  }
  return [...groups.values()];
}

// The renderer owns the anchor's transform. All presentation and folding stay
// inside it, so the speech bubble follows the country's surface as it rotates.
export function createGlobeBubble(group:GlobeBubble, callbacks:{
  select:(event:AtlasEvent)=>void;
  enter:()=>void;
  expand:(close:()=>void)=>void;
  reading:(active:boolean)=>void;
}, locale: "zh" | "en" = "zh") {
  const anchor=document.createElement("div");
  anchor.className="globe-bubble-anchor";
  anchor.dataset.country=group.country;
  anchor.dataset.latitude=String(group.lat);
  anchor.dataset.longitude=String(group.lng);
  anchor.dataset.selected=String(!!group.selected);
  anchor.dataset.stacked=String(group.events.length>1);
  const panel=document.createElement("div");
  panel.className="globe-bubble-panel";
  panel.setAttribute("role","group");
  panel.setAttribute("aria-label", locale === "en" ? `Historical events in ${group.name}` : `${group.name}的历史消息`);
  panel.style.setProperty("--bubble-count",String(group.events.length));
  const deck=document.createElement("div");
  deck.className="globe-bubble-deck";
  let expanded=false, suppressFocus=false;
  const buttons=group.events.map((event,index)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="globe-bubble";
    button.dataset.eventId=event.id;
    button.style.setProperty("--bubble-index",String(index));
    const title=notificationCopy(event).title;
    const eventYear=event.historical?.year ?? event.start;
    const labelYear = locale === "en" ? `${Math.abs(eventYear)} ${eventYear < 0 ? "BCE" : "CE"}` : yearLabel(eventYear);
    button.setAttribute("aria-label", locale === "en" ? `${group.name}: ${title}, ${labelYear}, ${index === 0 && group.events.length > 1 ? "expand events or view details" : "view details"}` : `${group.name}：${title}，${labelYear}${index===0 && group.events.length>1 ? "，展开消息或查看详情" : "，查看详情"}`);
    const label=document.createElement("span");
    label.className="globe-bubble-title";
    label.textContent=title;
    const year=document.createElement("span");
    year.className="globe-bubble-year";
    year.textContent=locale === "en" ? labelYear : `${eventYear<0 ? "公元前" : ""}${Math.abs(eventYear)}年`;
    year.setAttribute("aria-hidden","true");
    button.appendChild(year);button.appendChild(label);
    button.onclick=input=>{
      input.stopPropagation();
      if(group.events.length>1 && !expanded){expand();return;}
      callbacks.select(event);
    };
    deck.appendChild(button);
    return button;
  });
  function setExpanded(next:boolean){
    expanded=next && buttons.length>1;
    anchor.dataset.expanded=String(expanded);
    if(buttons.length>1)buttons[0].setAttribute("aria-expanded",String(expanded));
    buttons.forEach((button,index)=>{
      button.tabIndex=index===0 || expanded ? 0 : -1;
      if(index>0)button.setAttribute("aria-hidden",String(!expanded));
    });
  }
  function close(){setExpanded(false);}
  function expand(){if(!expanded){callbacks.expand(close);setExpanded(true);}}
  anchor.onpointerdown=input=>input.stopPropagation();
  anchor.onpointermove=input=>input.stopPropagation();
  anchor.onpointerenter=input=>{callbacks.enter();if(input.pointerType==="mouse")expand();};
  anchor.onpointerleave=input=>{if(input.pointerType==="mouse" && !buttons.some(button=>button.matches(":focus-visible")))close();};
  anchor.addEventListener("focusin",()=>{const keyboard=buttons.some(button=>button.matches(":focus-visible"));callbacks.reading(keyboard);if(!suppressFocus && keyboard)expand();});
  anchor.addEventListener("focusout",input=>{if(!(input.relatedTarget instanceof Node) || !anchor.contains(input.relatedTarget)){callbacks.reading(false);close();}});
  anchor.onkeydown=input=>{
    if(input.key!=="Escape" || !expanded)return;
    input.preventDefault();input.stopPropagation();close();
    suppressFocus=true;buttons[0].focus({preventScroll:true});suppressFocus=false;
  };
  panel.appendChild(deck);
  const dot=document.createElement("span");
  dot.className="globe-bubble-dot";dot.setAttribute("aria-hidden","true");
  anchor.appendChild(panel);anchor.appendChild(dot);
  setExpanded(false);
  return anchor;
}
