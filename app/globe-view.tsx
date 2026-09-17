"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { type AtlasEvent } from "./demo-data";
import { countryMessages } from "./notification-events";
import { createGlobeBubble, type GlobeBubble } from "./globe-bubbles";
import { atlasCountries, countryCode, countryRegion, countryPalette, countryView, type CountryFeature, type CountryRegion } from "./country-geometry";

export type GlobeCommand = { id: number; action: "in" | "out" | "reset" | "focus" | "country"; lat?: number; lng?: number; code?: string };
export type HoverInfo = { name: string; kind: "country" | "event"; events: AtlasEvent[]; x: number; y: number } | null;
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
  const spin = useRef(spinning);
  const overview = useRef({ altitude: 1.65, active: true });
  const camera = useRef({ lat: 21, lng: 68, altitude: 1.65, targetAltitude: 1.65, vx: -1.7, vy: 0, direction: -1 });
  const flight = useRef<{ lat: number; lng: number } | null>(null);
  const drag = useRef({ active: false, x: 0, y: 0, last: 0, moved: 0, ended: 0, pointer: -1 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  data.current = events; callbacks.current = { onSelect, onHover, onRegionSelect, onCountriesReady, onReset, onToggleSpin }; spin.current = spinning; selectedCode.current = selectedCountry;

  useEffect(() => {
    let cancelled = false, frame = 0;
    let dispose = () => {};
    setStatus("loading");
    async function init() {
      try {
        const [{ default: Globe }, THREE, geography] = await Promise.all([
          import("globe.gl"), import("three"),
          fetch("/data/countries.geojson").then(r => { if (!r.ok) throw new Error("Geography unavailable"); return r.json() as Promise<{ features: CountryFeature[] }>; }),
        ]);
        if (cancelled || !host.current) return;
        const element = host.current;
        const features = atlasCountries(geography.features);
        reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let hovered: any = null;
        let closeBubble=()=>{};
        let bubbleNodes:HTMLElement[]=[];
        let keyboardReading=false;
        let cursor = { x: 0, y: 0 };
        const palette = countryPalette(features);
        const viewport=()=>{
          const width=element.clientWidth, height=element.clientHeight;
          const footer=parseFloat(getComputedStyle(element).getPropertyValue("--globe-footer")) || 116;
          return {width,height,footer,availableHeight:Math.max(160,height-footer)};
        };
        const colors = (f: object) => countryCode(f as CountryFeature) === selectedCode.current ? "#ddbd78" : f === hovered ? "#c9d8c4" : palette.get(countryCode(f as CountryFeature))!;
        const surfaceAltitude = (f: object) => countryCode(f as CountryFeature) === selectedCode.current ? .012 : f === hovered ? .009 : .005;
        const stroke = (f: object) => countryCode(f as CountryFeature) === selectedCode.current ? "#fff1ca" : f === hovered ? "#eff3df" : "#263e43";
        const bubbleData=():GlobeBubble[]=>countryMessages(data.current,selectedCode.current).map(group=>{
          const feature=features.find(f=>countryCode(f)===group.country);
          if(!feature)return {...group,name:group.events[0].location};
          // A country stack is anchored to its main landmass; event details
          // still fly to the event's own geographic location.
          const center=countryView(feature,1,50);
          return {...group,lat:center.lat,lng:center.lng,name:countryRegion(feature).name};
        });
        const selectCountry = (f: CountryFeature, point?: {lat: number; lng: number}) => {
          overview.current.active = false;
          const {width,height,availableHeight}=viewport();
          const effectiveFov=2*Math.atan(Math.tan(globe.camera().fov*Math.PI/360)*availableHeight/height)*180/Math.PI;
          const view = countryView(f, width/availableHeight, effectiveFov, point);
          camera.current.vx = 0; camera.current.vy = 0;
          camera.current.targetAltitude = view.altitude;
          flight.current = { lat: view.lat, lng: view.lng };
          if (reducedMotion.current) Object.assign(camera.current, view);
          hovered = null;
          callbacks.current.onHover(null);
          callbacks.current.onRegionSelect(countryRegion(f));
        };
        const globe: any = new Globe(element, { animateIn: false, rendererConfig: { antialias: true, alpha: true } })
          .backgroundColor("#020408")
          // Globe.GL wraps this texture around the scene. The globe and the
          // surrounding stars share the same camera during drag and inertia.
          .backgroundImageUrl("/textures/night-sky.png")
          .width(element.clientWidth).height(element.clientHeight)
          .globeMaterial(new THREE.MeshPhongMaterial({ color: "#122d3a", shininess: 9, specular: "#1f4653" }))
          .showAtmosphere(true).atmosphereColor("#658d9b").atmosphereAltitude(0.08)
          .showGraticules(false)
          .polygonsData(features)
          .polygonAltitude(surfaceAltitude).polygonCapColor(colors).polygonSideColor(() => "#203c43")
          .polygonStrokeColor(stroke).polygonsTransitionDuration(reducedMotion.current ? 0 : 230)
          .htmlElementsData(bubbleData()).htmlLat("lat").htmlLng("lng").htmlAltitude(0.016).htmlTransitionDuration(0)
          .htmlElement((item: any) => {
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
            if (drag.current.active) return;
            hovered = f; repaint.current();
            callbacks.current.onHover(f ? { ...countryRegion(f), kind: "country", events: data.current.filter(e => e.country === countryCode(f)), ...cursor } : null);
          })
          .onPolygonClick((f: object, _event: MouseEvent, point: {lat: number; lng: number}) => {
            if (drag.current.moved > 4 || performance.now() - drag.current.ended < 80) return;
            selectCountry(f as CountryFeature, point);
          });
        repaint.current = () => globe.polygonCapColor(colors).polygonAltitude(surfaceAltitude).polygonStrokeColor(stroke);
        updateBubbles.current=()=>{closeBubble();keyboardReading=false;bubbleNodes=[];globe.htmlElementsData(bubbleData());};
        focusCountry.current = code => { const f = features.find(f => countryCode(f) === code); if (f) selectCountry(f); };
        callbacks.current.onCountriesReady(features.map(countryRegion).sort((a,b) => a.name.localeCompare(b.name,"zh-CN")));
        api.current = globe;
        globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
        const leave = () => { if (!drag.current.active) callbacks.current.onHover(null); };
        const wheel = (event: WheelEvent) => {
          event.preventDefault(); overview.current.active = false; camera.current.targetAltitude = Math.max(.16, Math.min(Math.max(3.3, overview.current.altitude*1.35), camera.current.targetAltitude+event.deltaY*0.0015));
        };
        const lost = () => { if (drag.current.active) { camera.current.vx = 0; camera.current.vy = 0; } drag.current.active = false; element.classList.remove("is-dragging"); };
        canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", lost);
        canvas.addEventListener("pointerleave", leave); canvas.addEventListener("lostpointercapture", lost);
        canvas.addEventListener("wheel", wheel, { passive: false });
        let last = performance.now(), lastLabelLayout=0;
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
          if(now-lastLabelLayout>90){layoutBubbles();lastLabelLayout=now;}
          element.dataset.longitude = c.lng.toFixed(3);
          element.dataset.latitude = c.lat.toFixed(3);
          element.dataset.altitude = c.altitude.toFixed(3);
          element.dataset.velocity = c.vx.toFixed(3);
          frame = requestAnimationFrame(tick);
        }
        frame = requestAnimationFrame(tick);
        setStatus("ready");
        dispose = () => {
          cancelAnimationFrame(frame); resize.disconnect();
          canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
          canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", lost);
          canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("lostpointercapture", lost); canvas.removeEventListener("wheel", wheel);
          globe._destructor(); api.current = null; repaint.current = () => {}; updateBubbles.current=()=>{}; focusCountry.current = () => {}; element.replaceChildren();
        };
      } catch (err) { console.error("Globe could not initialize", err); if (!cancelled) setStatus("error"); }
    }
    init(); return () => { cancelled = true; dispose(); };
  }, [attempt]);

  useEffect(() => {
    updateBubbles.current();
  }, [events, selectedCountry]);

  useEffect(() => { repaint.current(); }, [selectedCountry]);

  useEffect(() => { if (!spinning) { camera.current.vx = 0; camera.current.vy = 0; } }, [spinning]);

  useEffect(() => {
    if (!command) return;
    const c = camera.current;
    if (command.action === "in" || command.action === "out") overview.current.active = false;
    if (command.action === "in") c.targetAltitude = Math.max(.16, c.targetAltitude/1.28);
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
        if (event.key === "+" || event.key === "=") c.targetAltitude = Math.max(.16, c.targetAltitude/1.28);
        if (event.key === "-") c.targetAltitude = Math.min(Math.max(3.3, overview.current.altitude*1.35), c.targetAltitude*1.28);
      }} />
    {status === "loading" && <div className="globe-status"><LoaderCircle className="loading-icon" size={28}/><p>展开世界地图…</p></div>}
    {status === "error" && <div className="globe-status"><p>地球暂时未能加载</p><span>请确认浏览器已开启图形加速，或重新加载。</span><button className="text-button" onClick={() => setAttempt(a => a+1)}><RotateCcw size={16}/>重新加载</button></div>}
  </div>;
}
