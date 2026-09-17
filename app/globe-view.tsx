"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw, X, ChevronRight } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { type AtlasEvent } from "./demo-data";
import { countryMessages } from "./notification-events";
import { createGlobeBubble, type GlobeBubble } from "./globe-bubbles";
import { createGlobeSky } from "./globe-sky";
import { adminColor, containsPlace, featureCenter, isAdmin, loadDivisions, type AdminFeature, type AdminCollection, type City } from "./admin-geography";
import { atlasCountries, countryCode, countryRegion, countryPalette, countryView, type CountryFeature, type CountryRegion } from "./country-geometry";

export type GlobeCommand = { id: number; action: "in" | "out" | "reset" | "focus" | "country" | "back"; lat?: number; lng?: number; code?: string };
export type HoverInfo = { name: string; kind: "country" | "event" | "division" | "city"; events: AtlasEvent[]; x: number; y: number; hint?: string } | null;
type GeographyView = { country: string; parent: AdminFeature | null; child: AdminFeature | null; choices: AdminFeature[]; status: "loading" | "ready" | "error"; label: string; source: string; sourceUrl: string };
type Props = { events: AtlasEvent[]; spinning: boolean; command: GlobeCommand | null; onSelect: (events: AtlasEvent[]) => void; onHover: (info: HoverInfo) => void; selectedCountry: string | null; onRegionSelect: (region: CountryRegion) => void; onCountriesReady: (regions: CountryRegion[]) => void; onReset: () => void; onToggleSpin: () => void };

// Rotation uses one camera state: direct pointer input wins over idle spin.
// Release velocity decays exponentially into a slow spin in the last direction.
export default function GlobeView({ events, spinning, command, onSelect, onHover, selectedCountry, onRegionSelect, onCountriesReady, onReset, onToggleSpin }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<any>(null);
  const data = useRef(events);
  const updateBubbles = useRef(() => {});
  const reducedMotion = useRef(false);
  const callbacks = useRef({ onSelect, onHover, onRegionSelect, onCountriesReady, onReset, onToggleSpin });
  const selectedCode = useRef(selectedCountry);
  const repaint = useRef(() => {});
  const focusCountry = useRef<(code: string) => void>(() => {});
  const syncGeography = useRef(() => {});
  const navigation = useRef({ back:()=>{}, country:()=>{}, parent:()=>{}, choose:(_id:string)=>{}, retry:()=>{} });
  const spin = useRef(spinning);
  const overview = useRef({ altitude: 1.65, active: true });
  const camera = useRef({ lat: 21, lng: 68, altitude: 1.65, targetAltitude: 1.65, vx: -1.7, vy: 0, direction: -1 });
  const flight = useRef<{ lat: number; lng: number } | null>(null);
  const drag = useRef({ active: false, x: 0, y: 0, last: 0, moved: 0, ended: 0, pointer: -1 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [geographyView, setGeographyView] = useState<GeographyView | null>(null);
  data.current = events; callbacks.current = { onSelect, onHover, onRegionSelect, onCountriesReady, onReset, onToggleSpin }; spin.current = spinning; selectedCode.current = selectedCountry;

  useEffect(() => {
    let cancelled = false, frame = 0;
    let dispose = () => {};
    setStatus("loading");
    async function init() {
      try {
        const [{ default: Globe }, THREE, geography, cities] = await Promise.all([
          import("globe.gl"), import("three"),
          fetch("/data/countries.geojson").then(r => { if (!r.ok) throw new Error("Geography unavailable"); return r.json() as Promise<{ features: CountryFeature[] }>; }),
          fetch("/data/cities.json").then(r => { if (!r.ok) throw new Error("Cities unavailable"); return r.json() as Promise<City[]>; }),
        ]);
        if (cancelled || !host.current) return;
        const element = host.current;
        const features = atlasCountries(geography.features);
        reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let hovered: any = null;
        let closeBubble=()=>{};
        let bubbleNodes:HTMLElement[]=[];
        let geographyNodes:HTMLElement[]=[];
        let adminParent:AdminFeature|null=null, adminChild:AdminFeature|null=null;
        let divisions:AdminFeature[]=[], provinceFeatures:AdminFeature[]=[];
        let boundaries:AdminCollection={features:[],source:"",sourceUrl:"",label:"省／州级行政区"};
        let boundaryStatus:GeographyView["status"]="ready", boundaryRequest:AbortController|null=null;
        let boundaryVersion=0;
        let altitudeScale=1;
        const knownCountries=new Set(features.map(countryCode));
        const globalCounts=new Map<string,number>();
        const globalCities=cities.filter(city=>{
          if(!knownCountries.has(city.country))return false;
          const count=globalCounts.get(city.country)||0;
          if(count>=3 || (count>=1 && city.rank>3))return false;
          globalCounts.set(city.country,count+1);return true;
        });
        let keyboardReading=false;
        let pointerOnCanvas=false;
        let cursor = { x: 0, y: 0 };
        const palette = countryPalette(features);
        const viewport=()=>{
          const width=element.clientWidth, height=element.clientHeight;
          const footer=parseFloat(getComputedStyle(element).getPropertyValue("--globe-footer")) || 116;
          return {width,height,footer,availableHeight:Math.max(160,height-footer)};
        };
        const colors = (f: CountryFeature) => isAdmin(f) ? f===adminChild ? "#ddbd78" : f===hovered ? "#d4dec7" : adminParent && f.properties.level==="1" && f!==adminParent ? "#899d95" : adminColor(f.properties.id) : countryCode(f)===selectedCode.current ? "#a9ad96" : f===hovered ? "#c9d8c4" : palette.get(countryCode(f))!;
        const surfaceAltitude = (f: CountryFeature) => altitudeScale*(isAdmin(f) ? f.properties.level==="2" ? .012 : .009 : countryCode(f)===selectedCode.current ? .005 : f===hovered ? .007 : .004);
        const stroke = (f: CountryFeature) => isAdmin(f) ? f===hovered || f===adminChild ? "#fff1ca" : "#e1e8d980" : countryCode(f)===selectedCode.current ? "#e3d4a0" : "#263e43";
        const localCities=()=>{
          if(!selectedCode.current)return globalCities;
          return cities.filter(city=>city.country===selectedCode.current && (!adminParent || containsPlace(adminParent,city)) && (!adminChild || containsPlace(adminChild,city))).slice(0,adminParent ? 100 : 60);
        };
        const bubbleData=():GlobeBubble[]=>countryMessages(data.current,selectedCode.current).map(group=>{
          const feature=features.find(f=>countryCode(f)===group.country);
          if(!feature)return {...group,name:group.events[0].location};
          // A country stack is anchored to its main landmass; event details
          // still fly to the event's own geographic location.
          const center=countryView(feature,1,50);
          return {...group,lat:center.lat,lng:center.lng,name:countryRegion(feature).name};
        });
        const flyToFeature = (f: CountryFeature, point?: {lat: number; lng: number}) => {
          overview.current.active = false;
          const {width,height,availableHeight}=viewport();
          const effectiveFov=2*Math.atan(Math.tan(globe.camera().fov*Math.PI/360)*availableHeight/height)*180/Math.PI;
          const view = countryView(f, width/availableHeight, effectiveFov, point, isAdmin(f) ? .025 : .16, isAdmin(f) ? .18 : 3);
          camera.current.vx = 0; camera.current.vy = 0;
          camera.current.targetAltitude = view.altitude;
          flight.current = { lat: view.lat, lng: view.lng };
          if (reducedMotion.current) Object.assign(camera.current, view);
          hovered = null;
          callbacks.current.onHover(null);
        };
        const publishGeography=()=>{
          const country=features.find(f=>countryCode(f)===selectedCode.current);
          setGeographyView(country ? {country:countryRegion(country).name,parent:adminParent,child:adminChild,choices:divisions,status:boundaryStatus,label:boundaries.label,source:boundaries.source,sourceUrl:boundaries.sourceUrl} : null);
        };
        const refreshGeography=()=>{
          // Detailed provinces replace the coarse country silhouette after
          // loading, so coastlines remain accurate when exploring a city.
          const countries=features.filter(f=>!provinceFeatures.length || countryCode(f)!==selectedCode.current);
          const detail=adminParent ? [...provinceFeatures,...divisions] : divisions.length ? divisions : provinceFeatures;
          globe.polygonsData([...countries,...detail]);
          updateBubbles.current();repaint.current();publishGeography();
        };
        const showDivisions=async(parent:AdminFeature|null)=>{
          boundaryRequest?.abort();const controller=new AbortController();boundaryRequest=controller;
          const version=++boundaryVersion, code=selectedCode.current;
          if(!code)return;
          adminParent=parent;adminChild=null;divisions=[];boundaryStatus="loading";
          boundaries={...boundaries,label:parent ? "市／县级行政区" : "省／州级行政区"};
          refreshGeography();
          try {
            const result=await loadDivisions(code,parent,controller.signal);
            if(cancelled || controller.signal.aborted || version!==boundaryVersion)return;
            boundaries=result;divisions=result.features;
            if(!parent)provinceFeatures=divisions;
            boundaryStatus="ready";refreshGeography();
          } catch {
            if(controller.signal.aborted || version!==boundaryVersion)return;
            boundaryStatus="error";refreshGeography();
          }
        };
        const selectCountry = (f: CountryFeature, point?: {lat: number; lng: number}) => {
          selectedCode.current=countryCode(f);provinceFeatures=[];
          flyToFeature(f,point);
          callbacks.current.onRegionSelect(countryRegion(f));
          void showDivisions(null);
        };
        const selectDivision=(f:AdminFeature,point?:{lat:number;lng:number})=>{
          closeBubble();flyToFeature(f,point);
          if(f.properties.level==="1")void showDivisions(f);
          else {adminChild=f;updateBubbles.current();repaint.current();publishGeography();}
        };
        const selectCity=(city:City)=>{
          if(!selectedCode.current || selectedCode.current!==city.country){
            const country=features.find(f=>countryCode(f)===city.country);if(country)selectCountry(country);return;
          }
          if(!adminParent){
            const province=provinceFeatures.find(f=>containsPlace(f,city));
            if(province){selectDivision(province);return;}
          }
          const district=divisions.find(f=>containsPlace(f,city));
          if(district){selectDivision(district);return;}
          overview.current.active=false;camera.current.vx=0;camera.current.vy=0;
          camera.current.targetAltitude=.045;flight.current={lat:city.lat,lng:city.lng};
        };
        const markerData=()=>!selectedCode.current ? [] : [
          ...localCities().slice(0,adminParent ? 40 : 24).map(city=>({...city,markerType:"city",target:city})),
          ...divisions.map(f=>({id:f.properties.id,name:f.properties.name,...featureCenter(f),markerType:"division",target:f})),
        ];
        const createMarker=(item:any)=>{
          const anchor=document.createElement("div");anchor.className="geo-label-anchor";
          const button=document.createElement("button");button.className=`geo-label geo-label--${item.markerType}`;
          button.textContent=item.name;button.setAttribute("aria-label",`${item.markerType==="city" ? "城市" : "行政区"}：${item.name}，点击放大`);
          button.addEventListener("pointerdown",e=>e.stopPropagation());
          button.addEventListener("click",e=>{e.stopPropagation();item.markerType==="city" ? selectCity(item.target) : selectDivision(item.target);});
          button.addEventListener("focus",()=>{keyboardReading=true;});
          button.addEventListener("blur",()=>{keyboardReading=false;});
          anchor.appendChild(button);geographyNodes.push(anchor);return anchor;
        };
        const globe: any = new Globe(element, { animateIn: false, rendererConfig: { antialias: true, alpha: true } })
          .backgroundColor("#020408")
          .width(element.clientWidth).height(element.clientHeight)
          .globeMaterial(new THREE.MeshPhongMaterial({ color: "#122d3a", shininess: 9, specular: "#1f4653" }))
          .showAtmosphere(true).atmosphereColor("#658d9b").atmosphereAltitude(0.08)
          .showGraticules(false)
          .polygonsData(features)
          .polygonAltitude(f=>surfaceAltitude(f as CountryFeature)).polygonCapColor(f=>colors(f as CountryFeature)).polygonSideColor(() => "#203c43")
          .polygonStrokeColor(f=>stroke(f as CountryFeature)).polygonsTransitionDuration(reducedMotion.current ? 0 : 230)
          .labelsData(localCities()).labelLat("lat").labelLng("lng").labelAltitude(.017)
          .labelText(()=>"").labelSize(.01).labelIncludeDot(true).labelDotRadius(.12).labelResolution(8)
          .labelColor(city=>(city as City).capital ? "#ffe1a0" : "#f5f5e6").labelsTransitionDuration(0)
          .onLabelClick(city=>{if(drag.current.moved<=4)selectCity(city as City);})
          .onLabelHover(item=>{if(!pointerOnCanvas || flight.current)return;const city=item as City|null;callbacks.current.onHover(city ? {name:city.name,kind:"city",events:[],hint:"城市 · 点击放大",...cursor} : null);})
          .htmlElementsData(bubbleData()).htmlLat("lat").htmlLng("lng").htmlAltitude(0.016).htmlTransitionDuration(0)
          .htmlElement((item: any) => {
            if(item.markerType)return createMarker(item);
            const node=createGlobeBubble(item as GlobeBubble,{
              select:event=>callbacks.current.onSelect([event]),
              enter:()=>{hovered=null;repaint.current();callbacks.current.onHover(null);},
              expand:close=>{closeBubble();closeBubble=close;},
              reading:active=>{keyboardReading=active;},
            });
            bubbleNodes.push(node);
            return node;
          })
          .onPolygonHover((f: any) => {
            if (drag.current.active || flight.current || !pointerOnCanvas) return;
            hovered = f; repaint.current();
            callbacks.current.onHover(f ? isAdmin(f) ? {name:f.properties.name,kind:"division",events:[],hint:f.properties.level==="1" ? "点击查看市／县级" : "点击放大",...cursor} : { ...countryRegion(f), kind: "country", events: data.current.filter(e => e.country === countryCode(f)), ...cursor } : null);
          })
          .onPolygonClick((f: object, _event: MouseEvent, point: {lat: number; lng: number}) => {
            if (drag.current.moved > 4 || performance.now() - drag.current.ended < 80) return;
            isAdmin(f as CountryFeature) ? selectDivision(f as AdminFeature,point) : selectCountry(f as CountryFeature, point);
          });
        repaint.current = () => globe.polygonCapColor(colors).polygonAltitude(surfaceAltitude).polygonStrokeColor(stroke);
        updateBubbles.current=()=>{closeBubble();keyboardReading=false;bubbleNodes=[];geographyNodes=[];globe.htmlElementsData([...bubbleData(),...markerData()]);globe.labelsData(localCities());};
        const returnToCountry=()=>{const f=features.find(f=>countryCode(f)===selectedCode.current);if(f)selectCountry(f);};
        const returnToParent=()=>{if(adminParent){adminChild=null;flyToFeature(adminParent);updateBubbles.current();repaint.current();publishGeography();}};
        navigation.current={country:returnToCountry,parent:returnToParent,back:()=>{if(adminChild)returnToParent();else if(adminParent)returnToCountry();else callbacks.current.onReset();},choose:id=>{const f=divisions.find(f=>f.properties.id===id);if(f)selectDivision(f);},retry:()=>{void showDivisions(adminParent);}};
        syncGeography.current=()=>{
          if(selectedCode.current)return;
          boundaryRequest?.abort();boundaryVersion++;adminParent=null;adminChild=null;divisions=[];provinceFeatures=[];
          refreshGeography();
        };
        focusCountry.current = code => { const f = features.find(f => countryCode(f) === code); if (f) selectCountry(f); };
        callbacks.current.onCountriesReady(features.map(countryRegion).sort((a,b) => a.name.localeCompare(b.name,"zh-CN")));
        api.current = globe;
        globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));
        const sky = createGlobeSky(THREE, globe.scene(), globe.camera());
        const controls = globe.controls();
        controls.enableRotate = false; controls.enableZoom = false; controls.enablePan = false;
        controls.enableDamping = false; controls.autoRotate = false;
        const fitOverview = () => {
          const {width:w,height:h,footer,availableHeight}=viewport();
          const padding = Math.min(24, Math.min(w,availableHeight)*.04);
          // Keep the globe above the timeline while the sky fills the canvas.
          globe.globeOffset([0,-footer/2]);
          const tangent = Math.tan(globe.camera().fov*Math.PI/360);
          const k = Math.min(tangent*(availableHeight-2*padding)/h, tangent*(w-2*padding)/h);
          overview.current.altitude = 1.08*Math.sqrt(1+1/(k*k))-1;
          if (overview.current.active) camera.current.targetAltitude = overview.current.altitude;
        };
        fitOverview();
        if (overview.current.active) camera.current.altitude = overview.current.altitude;
        const { lat, lng, altitude } = camera.current;
        globe.pointOfView({ lat, lng, altitude }, 0);
        const canvas = globe.renderer().domElement as HTMLCanvasElement;
        canvas.setAttribute("aria-hidden", "true");
        const refresh = () => { globe.width(element.clientWidth).height(element.clientHeight); fitOverview(); };
        const resize = new ResizeObserver(refresh); resize.observe(element);
        const down = (event: PointerEvent) => {
          if (event.button !== 0 || drag.current.active) return;
          closeBubble();
          flight.current = null;
          drag.current = { active: true, x: event.clientX, y: event.clientY, last: performance.now(), moved: 0, ended: 0, pointer: event.pointerId };
          camera.current.vx = 0; camera.current.vy = 0;
          canvas.setPointerCapture(event.pointerId); element.classList.add("is-dragging");
          callbacks.current.onHover(null);
        };
        const move = (event: PointerEvent) => {
          const rect = (element.closest(".globe-area") || element).getBoundingClientRect(); cursor = { x: event.clientX-rect.left, y: event.clientY-rect.top };
          if (!drag.current.active || event.pointerId !== drag.current.pointer) return;
          const d = drag.current, c = camera.current;
          const now = performance.now(), dt = Math.max(8, now-d.last)/1000;
          const dx = event.clientX-d.x, dy = event.clientY-d.y;
          const sensitivity = 110/Math.max(320, element.clientHeight) * (c.altitude/1.85);
          c.lng -= dx*sensitivity; c.lat = Math.max(-78, Math.min(78, c.lat+dy*sensitivity));
          c.vx = Math.max(-100, Math.min(100, -dx*sensitivity/dt));
          c.vy = Math.max(-60, Math.min(60, dy*sensitivity/dt));
          if (Math.abs(c.vx) > 0.3) c.direction = Math.sign(c.vx);
          d.x = event.clientX; d.y = event.clientY; d.last = now; d.moved += Math.abs(dx)+Math.abs(dy);
        };
        const up = (event: PointerEvent) => {
          if (!drag.current.active || event.pointerId !== drag.current.pointer) return;
          if (performance.now()-drag.current.last > 100) { camera.current.vx = 0; camera.current.vy = 0; }
          drag.current.active = false; drag.current.ended = drag.current.moved > 4 ? performance.now() : 0;
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          element.classList.remove("is-dragging");
        };
        const enter = () => { pointerOnCanvas=true; };
        const leave = () => { pointerOnCanvas=false;if (!drag.current.active) callbacks.current.onHover(null); };
        const wheel = (event: WheelEvent) => {
          event.preventDefault(); overview.current.active = false; camera.current.targetAltitude = Math.max(.025, Math.min(Math.max(3.3, overview.current.altitude*1.35), camera.current.targetAltitude*Math.exp(event.deltaY*.0015)));
        };
        const lost = () => { if (drag.current.active) { camera.current.vx = 0; camera.current.vy = 0; } drag.current.active = false; element.classList.remove("is-dragging"); };
        canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerenter", enter);
        canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", lost);
        canvas.addEventListener("pointerleave", leave); canvas.addEventListener("lostpointercapture", lost);
        canvas.addEventListener("wheel", wheel, { passive: false });
        let last = performance.now(), lastLabelLayout=0, lastDotRadius=.12;
        function layoutBubbles(){
          const bounds=element.getBoundingClientRect();
          const occupied:{left:number;right:number;top:number;bottom:number}[]=[];
          // Lift nearby labels along their stems, then omit a lower-priority
          // label only when no clear position remains. Keep an open stack still.
          const ordered=[...bubbleNodes].sort((a,b)=>Number(b.dataset.expanded==="true")-Number(a.dataset.expanded==="true") || Number(b.dataset.stacked==="true")-Number(a.dataset.stacked==="true"));
          for(const node of ordered){
            if(!node.isConnected || node.style.display==="none")continue;
            const panel=node.firstElementChild as HTMLElement;
            const anchorX=node.getBoundingClientRect().x;
            const half=panel.offsetWidth/2;
            const shift=Math.max(bounds.left+8+half-anchorX,Math.min(0,bounds.right-8-half-anchorX));
            node.style.setProperty("--bubble-shift",`${shift}px`);
            const previousLift=Number(node.dataset.lift || 0);
            const box=panel.getBoundingClientRect();
            const choices=node.dataset.expanded==="true" ? [previousLift] : [0,52,104];
            let chosen=previousLift, placed={left:box.left,right:box.right,top:box.top,bottom:box.bottom}, overlap=true;
            for(const lift of choices){
              const candidate={left:box.left,right:box.right,top:box.top+previousLift-lift,bottom:box.bottom+previousLift-lift};
              if(candidate.top<bounds.top+8)continue;
              if(!occupied.some(other=>candidate.left<other.right+8 && candidate.right+8>other.left && candidate.top<other.bottom+8 && candidate.bottom+8>other.top)){
                chosen=lift;placed=candidate;overlap=false;break;
              }
            }
            node.dataset.lift=String(chosen);
            node.style.setProperty("--bubble-lift",`${chosen}px`);
            node.dataset.obscured=String(overlap);
            node.inert=overlap;
            if(!overlap)occupied.push(placed);
          }
          for(const node of geographyNodes){
            if(!node.isConnected || node.style.display==="none")continue;
            const box=node.firstElementChild!.getBoundingClientRect();
            const hidden=box.top<bounds.top+100 || box.bottom>bounds.bottom-viewport().footer-8 || box.left<bounds.left+8 || box.right>bounds.right-8 || occupied.some(o=>box.left<o.right+5 && box.right+5>o.left && box.top<o.bottom+3 && box.bottom+3>o.top);
            node.dataset.obscured=String(hidden);node.inert=hidden;
            if(!hidden)occupied.push(box);
          }
        }
        function tick(now: number) {
          const dt = Math.min((now-last)/1000, 0.05); last = now;
          const c = camera.current;
          if (flight.current && !drag.current.active) {
            const f = flight.current, blend = 1-Math.exp(-dt*4.5);
            const delta = ((f.lng-c.lng+540)%360+360)%360-180;
            c.lng += delta*blend; c.lat += (f.lat-c.lat)*blend;
            if (Math.abs(delta)<0.05 && Math.abs(f.lat-c.lat)<0.05) { c.lng = f.lng; c.lat = f.lat; flight.current = null; }
          } else if (!drag.current.active) {
            const target = spin.current && !keyboardReading ? c.direction*1.7 : 0;
            c.vx = target+(c.vx-target)*Math.exp(-dt*1.45);
            c.vy *= Math.exp(-dt*3.8);
            c.lng += c.vx*dt; c.lat = Math.max(-78, Math.min(78, c.lat+c.vy*dt));
          }
          c.lng = ((c.lng+180)%360+360)%360-180;
          c.altitude += (c.targetAltitude-c.altitude)*(1-Math.exp(-dt*7));
          globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: c.altitude }, 0);
          sky.update(now);
          element.dataset.meteor = sky.active ? "visible" : "quiet";
          if(now-lastLabelLayout>120){
            layoutBubbles();
            const radius=Math.max(.004,Math.min(.18,c.altitude*.18));
            if(Math.abs(radius-lastDotRadius)>lastDotRadius*.12){globe.labelDotRadius(radius);lastDotRadius=radius;}
            // Keep close-up borders and their labels on the same ground plane;
            // fixed globe-scale extrusion would float them kilometres apart.
            const nextScale=Math.min(1,c.altitude/.7);
            if(Math.abs(nextScale-altitudeScale)>altitudeScale*.12){
              altitudeScale=nextScale;
              globe.polygonAltitude(surfaceAltitude).htmlAltitude(.016*altitudeScale).labelAltitude(.017*altitudeScale);
            }
            lastLabelLayout=now;
          }
          element.dataset.longitude = c.lng.toFixed(3);
          element.dataset.latitude = c.lat.toFixed(3);
          element.dataset.altitude = c.altitude.toFixed(3);
          element.dataset.velocity = c.vx.toFixed(3);
          frame = requestAnimationFrame(tick);
        }
        frame = requestAnimationFrame(tick);
        setStatus("ready");
        if(selectedCode.current)focusCountry.current(selectedCode.current);
        dispose = () => {
          cancelAnimationFrame(frame); resize.disconnect();
          boundaryRequest?.abort();boundaryVersion++;
          sky.dispose();
          canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
          canvas.removeEventListener("pointerenter", enter);
          canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", lost);
          canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("lostpointercapture", lost); canvas.removeEventListener("wheel", wheel);
          globe._destructor(); api.current = null; repaint.current = () => {}; updateBubbles.current=()=>{}; focusCountry.current = () => {}; syncGeography.current=()=>{}; element.replaceChildren();
        };
      } catch (err) { console.error("Globe could not initialize", err); if (!cancelled) setStatus("error"); }
    }
    init(); return () => { cancelled = true; dispose(); };
  }, [attempt]);

  useEffect(() => {
    updateBubbles.current();
  }, [events, selectedCountry]);

  useEffect(() => { repaint.current(); }, [selectedCountry]);
  useEffect(() => { syncGeography.current(); }, [selectedCountry]);

  useEffect(() => { if (!spinning) { camera.current.vx = 0; camera.current.vy = 0; } }, [spinning]);

  useEffect(() => {
    if (!command) return;
    const c = camera.current;
    if (command.action === "in" || command.action === "out") overview.current.active = false;
    if (command.action === "back") {navigation.current.back();return;}
    if (command.action === "in") c.targetAltitude = Math.max(.025, c.targetAltitude/1.28);
    if (command.action === "out") c.targetAltitude = Math.min(Math.max(3.3, overview.current.altitude*1.35), c.targetAltitude*1.28);
    if (command.action === "reset") { overview.current.active = true; flight.current = { lat: 21, lng: 68 }; c.targetAltitude = overview.current.altitude; c.vx = spin.current ? c.direction*1.7 : 0; c.vy = 0; }
    if (command.action === "focus") { overview.current.active = false; c.vx = 0; c.vy = 0; c.targetAltitude = Math.min(c.targetAltitude, .65); flight.current = { lat: command.lat ?? 21, lng: command.lng ?? 68 }; }
    if (command.action === "country" && command.code) focusCountry.current(command.code);
  }, [command]);

  return <div className="globe-wrap">
    <div ref={host} className="globe-canvas" data-testid="globe" tabIndex={0} role="application"
      aria-label="交互地球。方向键旋转，加减键缩放，空格暂停或继续自转，Home 返回全球，Enter 选择地区。也可拖动地球、悬停预览、点击国家放大。"
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const c = camera.current;
        flight.current = null;
        if (event.key === "Home") { event.preventDefault(); callbacks.current.onReset(); return; }
        if (event.key === " ") { event.preventDefault(); callbacks.current.onToggleSpin(); return; }
        if (event.key === "Enter") { event.preventDefault(); (document.querySelector(".keyboard-region-picker select") as unknown as HTMLSelectElement | null)?.focus(); return; }
        if (["+", "-", "="].includes(event.key)) overview.current.active = false;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(event.key)) event.preventDefault();
        if (event.key === "ArrowLeft") { c.lng += 8; c.direction = 1; }
        if (event.key === "ArrowRight") { c.lng -= 8; c.direction = -1; }
        if (event.key === "ArrowUp") c.lat = Math.min(78, c.lat+8);
        if (event.key === "ArrowDown") c.lat = Math.max(-78, c.lat-8);
        if (event.key === "+" || event.key === "=") c.targetAltitude = Math.max(.025, c.targetAltitude/1.28);
        if (event.key === "-") c.targetAltitude = Math.min(Math.max(3.3, overview.current.altitude*1.35), c.targetAltitude*1.28);
      }} />
    {geographyView && <div className="geography-navigation">
      <nav aria-label="地图层级" className="geography-breadcrumbs">
        <button onClick={()=>navigation.current.country()} aria-label={`返回${geographyView.country}全图`}>{geographyView.country}</button>
        {geographyView.parent && <><ChevronRight size={13}/><button onClick={()=>navigation.current.parent()}>{geographyView.parent.properties.name}</button></>}
        {geographyView.child && <><ChevronRight size={13}/><span>{geographyView.child.properties.name}</span></>}
        <button className="geography-close" onClick={()=>callbacks.current.onReset()} aria-label="返回全球"><X size={16}/></button>
      </nav>
      <div className="geography-context">
        {geographyView.status==="loading" ? <span role="status"><LoaderCircle size={12} className="loading-icon"/>加载{geographyView.label}…</span> : geographyView.status==="error" ? <button onClick={()=>navigation.current.retry()}>边界暂未加载 · 重试</button> : geographyView.choices.length ? <NativeSelect className="division-picker" value={geographyView.child?.properties.id || ""} aria-label={geographyView.parent ? "选择市或县" : "选择省或州"} onChange={e=>navigation.current.choose(e.target.value)}><NativeSelectOption value="">{geographyView.label} · 点击地图或选择</NativeSelectOption>{geographyView.choices.map(f=><NativeSelectOption key={f.properties.id} value={f.properties.id}>{f.properties.name}</NativeSelectOption>)}</NativeSelect> : <span role="status">此地区暂无可用的下一级边界</span>}
      </div>
      <p className="geography-source">现代行政区划 · <a href={geographyView.sourceUrl || "https://www.naturalearthdata.com/"} target="_blank" rel="noreferrer">{geographyView.source || "地图数据"} ↗</a></p>
    </div>}
    {status === "loading" && <div className="globe-status"><LoaderCircle className="loading-icon" size={28}/><p>展开世界地图…</p></div>}
    {status === "error" && <div className="globe-status"><p>地球暂时未能加载</p><span>请确认浏览器已开启图形加速，或重新加载。</span><button className="text-button" onClick={() => setAttempt(a => a+1)}><RotateCcw size={16}/>重新加载</button></div>}
  </div>;
}
