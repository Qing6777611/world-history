import { hasCoordinates, type AtlasEvent } from "./demo-data";

export type EventMarker = { lat:number; lng:number; color:string; name:string; events:AtlasEvent[]; compact:boolean };
export function eventMarkers(events:AtlasEvent[], country:string|null):EventMarker[] {
  const markers:EventMarker[]=[];
  const radius=(country ? .6 : 7)*Math.PI/180;
  for(const event of events) {
    if(!hasCoordinates(event) || (country ? event.country!==country : !event.historical))continue;
    const nearby=markers.find(marker=>{
      if(marker.events[0].country!==event.country)return false;
      const a=marker.lat*Math.PI/180,b=event.lat*Math.PI/180,d=(marker.lng-event.lng)*Math.PI/180;
      return Math.acos(Math.max(-1,Math.min(1,Math.sin(a)*Math.sin(b)+Math.cos(a)*Math.cos(b)*Math.cos(d))))<radius;
    });
    if(nearby)nearby.events.push(event);
    else markers.push({lat:event.lat,lng:event.lng,color:event.color,name:event.location,events:[event],compact:!country});
  }
  return markers;
}
