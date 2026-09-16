"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { AtlasEvent } from "./demo-data";

export type GlobeCommand = { id: number; action: "in" | "out" | "reset" | "focus"; lat?: number; lng?: number };
export type HoverInfo = { name: string; events: AtlasEvent[]; x: number; y: number } | null;
type Props = { events: AtlasEvent[]; spinning: boolean; command: GlobeCommand | null; onSelect: (event: AtlasEvent) => void; onHover: (info: HoverInfo) => void };

// Rotation uses one camera state: direct pointer input wins over idle spin.
// Release velocity decays exponentially into a slow spin in the last direction.
export default function GlobeView({ events, spinning, command, onSelect, onHover }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<any>(null);
  const data = useRef(events);
  const reducedMotion = useRef(false);
  const callbacks = useRef({ onSelect, onHover });
  const spin = useRef(spinning);
  const camera = useRef({ lat: 21, lng: 68, altitude: 1.65, targetAltitude: 1.65, vx: -1.7, vy: 0, direction: -1 });
  const flight = useRef<{ lat: number; lng: number } | null>(null);
  const drag = useRef({ active: false, x: 0, y: 0, last: 0, moved: 0, ended: 0, pointer: -1 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  data.current = events; callbacks.current = { onSelect, onHover }; spin.current = spinning;

  useEffect(() => {
    let cancelled = false, frame = 0;
    let dispose = () => {};
    setStatus("loading");
    async function init() {
      try {
        const [{ default: Globe }, THREE, geography] = await Promise.all([
          import("globe.gl"), import("three"),
          fetch("/data/countries.geojson").then(r => { if (!r.ok) throw new Error("Geography unavailable"); return r.json() as Promise<{ features: any[] }>; }),
        ]);
        if (cancelled || !host.current) return;
        const element = host.current;
        reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let hovered: any = null;
        let cursor = { x: 0, y: 0 };
        const code = (f: any) => f.properties.ISO_A3_EH !== "-99" ? f.properties.ISO_A3_EH : f.properties.ADM0_A3;
        const colors = (f: any) => f === hovered ? "#779891" : data.current.some(e => e.country === code(f)) ? "#587972" : "#314c50";
        const globe: any = new Globe(element, { animateIn: false, rendererConfig: { antialias: true, alpha: true } })
          .backgroundColor("rgba(0,0,0,0)")
          .width(element.clientWidth).height(element.clientHeight)
          .globeMaterial(new THREE.MeshPhongMaterial({ color: "#122d3a", shininess: 9, specular: "#1f4653" }))
          .showAtmosphere(true).atmosphereColor("#658d9b").atmosphereAltitude(0.12)
          .showGraticules(false)
          .polygonsData(geography.features)
          .polygonAltitude(0.005).polygonCapColor(colors).polygonSideColor(() => "#203c43")
          .polygonStrokeColor(() => "#77908d77").polygonsTransitionDuration(230)
          .htmlElementsData(data.current).htmlLat("lat").htmlLng("lng").htmlAltitude(0.03)
          .htmlElement((item: any) => {
            const event = item as AtlasEvent;
            const pin = document.createElement("button");
            pin.type = "button"; pin.className = "globe-pin"; pin.textContent = event.location;
            pin.style.setProperty("--marker-color", event.color);
            pin.setAttribute("aria-label", `${event.location}：${event.title}，查看演示详情`);
            pin.onpointerenter = () => {
              const rect = pin.getBoundingClientRect(), bounds = element.getBoundingClientRect();
              callbacks.current.onHover({ name: event.location, events: [event], x: rect.x-bounds.x, y: rect.y-bounds.y });
            };
            pin.onpointerleave = () => callbacks.current.onHover(null);
            pin.onclick = () => callbacks.current.onSelect(event);
            return pin;
          })
          .ringsData(reducedMotion.current ? [] : data.current).ringLat("lat").ringLng("lng").ringAltitude(0.013)
          .ringColor((e: any) => (t: number) => new THREE.Color(e.color).getStyle().replace("rgb(", "rgba(").replace(")", `,${(1-t)*0.6})`))
          .ringMaxRadius(2.5).ringPropagationSpeed(0.65).ringRepeatPeriod(2600)
          .onPolygonHover((f: any) => {
            if (drag.current.active) return;
            hovered = f; globe.polygonCapColor(colors);
            callbacks.current.onHover(f ? { name: f.properties.NAME_ZH || f.properties.NAME_EN, events: data.current.filter(e => e.country === code(f)), ...cursor } : null);
          })
          .onLabelHover((e: any) => {
            if (drag.current.active) return;
            callbacks.current.onHover(e ? { name: e.location, events: [e], ...cursor } : null);
          })
          .onPolygonClick((f: any) => {
            if (drag.current.moved > 4 || performance.now() - drag.current.ended < 80) return;
            const event = data.current.find(e => e.country === code(f));
            if (event) callbacks.current.onSelect(event);
          })
          .onLabelClick((e: any) => {
            if (drag.current.moved > 4) return;
            callbacks.current.onSelect(e);
          });
        api.current = globe;
        globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));
        const controls = globe.controls();
        controls.enableRotate = false; controls.enableZoom = false; controls.enablePan = false;
        controls.enableDamping = false; controls.autoRotate = false;
        const { lat, lng, altitude } = camera.current;
        globe.pointOfView({ lat, lng, altitude }, 0);
        const canvas = globe.renderer().domElement as HTMLCanvasElement;
        canvas.setAttribute("aria-hidden", "true");
        const refresh = () => { globe.width(element.clientWidth).height(element.clientHeight); };
        const resize = new ResizeObserver(refresh); resize.observe(element);
        const down = (event: PointerEvent) => {
          if (event.button !== 0 || drag.current.active) return;
          flight.current = null;
          drag.current = { active: true, x: event.clientX, y: event.clientY, last: performance.now(), moved: 0, ended: 0, pointer: event.pointerId };
          camera.current.vx = 0; camera.current.vy = 0;
          canvas.setPointerCapture(event.pointerId); element.classList.add("is-dragging");
          callbacks.current.onHover(null);
        };
        const move = (event: PointerEvent) => {
          const rect = element.getBoundingClientRect(); cursor = { x: event.clientX-rect.left, y: event.clientY-rect.top };
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
          event.preventDefault(); camera.current.targetAltitude = Math.max(1.15, Math.min(3.3, camera.current.targetAltitude+event.deltaY*0.0015));
        };
        const lost = () => { if (drag.current.active) { camera.current.vx = 0; camera.current.vy = 0; } drag.current.active = false; element.classList.remove("is-dragging"); };
        canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", lost);
        canvas.addEventListener("pointerleave", leave); canvas.addEventListener("lostpointercapture", lost);
        canvas.addEventListener("wheel", wheel, { passive: false });
        let last = performance.now();
        function tick(now: number) {
          const dt = Math.min((now-last)/1000, 0.05); last = now;
          const c = camera.current;
          if (flight.current && !drag.current.active) {
            const f = flight.current, blend = 1-Math.exp(-dt*4.5);
            const delta = ((f.lng-c.lng+540)%360+360)%360-180;
            c.lng += delta*blend; c.lat += (f.lat-c.lat)*blend;
            if (Math.abs(delta)<0.2 && Math.abs(f.lat-c.lat)<0.2) flight.current = null;
          } else if (!drag.current.active) {
            const target = spin.current ? c.direction*1.7 : 0;
            c.vx = target+(c.vx-target)*Math.exp(-dt*1.45);
            c.vy *= Math.exp(-dt*3.8);
            c.lng += c.vx*dt; c.lat = Math.max(-78, Math.min(78, c.lat+c.vy*dt));
          }
          c.lng = ((c.lng+180)%360+360)%360-180;
          c.altitude += (c.targetAltitude-c.altitude)*(1-Math.exp(-dt*7));
          globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: c.altitude }, 0);
          element.dataset.longitude = c.lng.toFixed(3);
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
          globe._destructor(); api.current = null; element.replaceChildren();
        };
      } catch (err) { console.error("Globe could not initialize", err); if (!cancelled) setStatus("error"); }
    }
    init(); return () => { cancelled = true; dispose(); };
  }, [attempt]);

  useEffect(() => {
    if (!api.current) return;
    api.current.htmlElementsData(events).ringsData(reducedMotion.current ? [] : events);
    api.current.polygonCapColor((f: any) => events.some(e => e.country === (f.properties.ISO_A3_EH !== "-99" ? f.properties.ISO_A3_EH : f.properties.ADM0_A3)) ? "#587972" : "#314c50");
  }, [events]);

  useEffect(() => { if (!spinning) { camera.current.vx = 0; camera.current.vy = 0; } }, [spinning]);

  useEffect(() => {
    if (!command) return;
    const c = camera.current;
    if (command.action === "in") c.targetAltitude = Math.max(1.15, c.targetAltitude-0.3);
    if (command.action === "out") c.targetAltitude = Math.min(3.3, c.targetAltitude+0.3);
    if (command.action === "reset") { flight.current = { lat: 21, lng: 68 }; c.targetAltitude = 1.65; c.vx = -1.7; c.vy = 0; c.direction = -1; }
    if (command.action === "focus") { c.vx = c.direction*1.7; c.vy = 0; flight.current = { lat: command.lat ?? 21, lng: command.lng ?? 68 }; }
  }, [command]);

  return <div className="globe-wrap">
    <div ref={host} className="globe-canvas" data-testid="globe" tabIndex={0} role="application"
      aria-label="交互地球。方向键旋转，加减键缩放；也可按住鼠标或单指拖动，松手后惯性旋转。事件可从右侧列表访问。"
      onKeyDown={event => {
        const c = camera.current;
        flight.current = null;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(event.key)) event.preventDefault();
        if (event.key === "ArrowLeft") { c.lng += 8; c.direction = 1; }
        if (event.key === "ArrowRight") { c.lng -= 8; c.direction = -1; }
        if (event.key === "ArrowUp") c.lat = Math.min(78, c.lat+8);
        if (event.key === "ArrowDown") c.lat = Math.max(-78, c.lat-8);
        if (event.key === "+" || event.key === "=") c.targetAltitude = Math.max(1.15, c.targetAltitude-0.3);
        if (event.key === "-") c.targetAltitude = Math.min(3.3, c.targetAltitude+0.3);
      }} />
    {status === "loading" && <div className="globe-status"><LoaderCircle className="loading-icon" size={28}/><p>展开世界地图…</p></div>}
    {status === "error" && <div className="globe-status"><p>地球暂时未能加载</p><span>请确认浏览器已开启图形加速，或重新加载。</span><button className="text-button" onClick={() => setAttempt(a => a+1)}><RotateCcw size={16}/>重新加载</button></div>}
  </div>;
}
