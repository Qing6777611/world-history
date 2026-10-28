"use client";

import { useEffect, useRef, useState } from "react";
import type { PerspectiveCamera } from "three";
import type { GlobeInstance } from "globe.gl";
import { LoaderCircle, RotateCcw, X, ChevronRight } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { hasCoordinates, type AtlasEvent } from "./atlas-model";
import { countryMessages, locationMessages } from "./notification-events";
import { createGlobeBubble, eventMatchesCountry, historicalEventBubbles, type GlobeBubble } from "./globe-bubbles";
import { createGlobeSky } from "./globe-sky";
import { createGlobeLifetime } from "./globe-lifecycle";
import { adminColor, containsPlace, decodeCities, featureCenter, isAdmin, loadDivisions, type AdminFeature, type AdminCollection, type City, type RawCity } from "./admin-geography";
import { atlasCountries, countryCode, countryRegion, countryPalette, countryView, countryViewportView, historicalPickFeature, historicalSurfaceAltitude, isLandBackground, landBackground, orientHistoricalFeatures, type CountryFeature, type CountryRegion } from "./country-geometry";

export type GlobeCommand = { id: number; action: "in" | "out" | "reset" | "focus" | "country" | "back"; lat?: number; lng?: number; code?: string };
export type HoverInfo = { name: string; kind: "country" | "event" | "division" | "city"; events: AtlasEvent[]; x: number; y: number; hint?: string } | null;
export type HistoricalGeography = { year: number; features: CountryFeature[]; status: "loading" | "ready" | "error" | "unavailable" };
type GeographyView = { country: string; historical: boolean; province: AdminFeature | null; choices: AdminFeature[]; status: "loading" | "ready" | "error"; label: string; source: string; sourceUrl: string };
type MarkerDatum = { markerType: "city"; name: string; target: City } | { markerType: "division"; id: string; name: string; lat: number; lng: number; target: AdminFeature };
type HtmlElementDatum = GlobeBubble | MarkerDatum;
type Props = { locale: "zh" | "en"; historicalGeography?: HistoricalGeography | null; events: AtlasEvent[]; selectedEvent: AtlasEvent | null; spinning: boolean; command: GlobeCommand | null; onSelect: (events: AtlasEvent[]) => void; onHover: (info: HoverInfo) => void; selectedCountry: string | null; onRegionSelect: (region: CountryRegion) => void; onCountriesReady: (regions: CountryRegion[]) => void; onReset: () => void; onToggleSpin: () => void };

// Rotation uses one camera state: direct pointer input wins over idle spin.
// Release velocity decays exponentially into a slow spin in the last direction.
export default function GlobeView({ locale, historicalGeography = null, events, selectedEvent, spinning, command, onSelect, onHover, selectedCountry, onRegionSelect, onCountriesReady, onReset, onToggleSpin }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<GlobeInstance | null>(null);
  const data = useRef(events);
  const activeEvent = useRef(selectedEvent);
  const history = useRef(historicalGeography);
  const language = useRef(locale);
  const updateBubbles = useRef(() => {});
  const reducedMotion = useRef(false);
  const callbacks = useRef({ onSelect, onHover, onRegionSelect, onCountriesReady, onReset, onToggleSpin });
  const selectedCode = useRef(selectedCountry);
  const repaint = useRef(() => {});
  const focusCountry = useRef<(code: string) => void>(() => {});
  const syncGeography = useRef(() => {});
  const syncExternalGeography = useRef(() => {});
  const navigation = useRef<{ back: () => void; country: () => void; choose: (id: string) => void; retry: () => void }>({ back:()=>{}, country:()=>{}, choose:()=>{}, retry:()=>{} });
  const spin = useRef(spinning);
  const overview = useRef({ altitude: 1.65, active: true });
  const camera = useRef({ lat: 21, lng: 68, altitude: 1.65, targetAltitude: 1.65, vx: -1.7, vy: 0, direction: -1 });
  const flight = useRef<{ lat: number; lng: number } | null>(null);
  const fittedRegion = useRef<{ country: string | null; division: string | null; point?: { lat: number; lng: number } } | null>(null);
  const drag = useRef({ active: false, x: 0, y: 0, last: 0, moved: 0, ended: 0, pointer: -1 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [cityStatus, setCityStatus] = useState<"loading" | "ready" | "error">("loading");
  const retryCities = useRef(() => {});
  const [geographyView, setGeographyView] = useState<GeographyView | null>(null);

  // Mirror props into refs after commit; the animation loop and DOM handlers read them.
  useEffect(() => {
    data.current = events;
    activeEvent.current = selectedEvent;
    history.current = historicalGeography;
    language.current = locale;
    callbacks.current = { onSelect, onHover, onRegionSelect, onCountriesReady, onReset, onToggleSpin };
    spin.current = spinning;
    selectedCode.current = selectedCountry;
  });

  useEffect(() => {
    let cancelled = false, frame = 0;
    const lifetime = createGlobeLifetime();
    lifetime.add(() => {
      cancelAnimationFrame(frame);
      api.current = null;
      repaint.current = () => {};
      updateBubbles.current = () => {};
      focusCountry.current = () => {};
      syncGeography.current = () => {};
      syncExternalGeography.current = () => {};
      retryCities.current = () => {};
      navigation.current = { back: () => {}, country: () => {}, choose: () => {}, retry: () => {} };
    });
    async function init() {
      try {
        const [{ default: Globe }, THREE, geography, land] = await Promise.all([
          import("globe.gl"), import("three"),
          fetch("/data/countries.geojson", { signal: lifetime.signal }).then(r => { if (!r.ok) throw new Error("Geography unavailable"); return r.json() as Promise<{ features: CountryFeature[] }>; }),
          // A dissolved coastline avoids seams along modern internal borders.
          // Its failure must not prevent the modern map from opening.
          fetch("/data/land.geojson", { signal: lifetime.signal }).then(r => r.ok ? r.json() as Promise<{ features: CountryFeature[] }> : null).catch(() => null),
        ]);
        if (cancelled || !host.current) return;
        const element = host.current;
        const modernFeatures = atlasCountries(geography.features);
        const backdrop = landBackground(land?.features || geography.features);
        const historicalMode = () => history.current !== null;
        let features = history.current ? history.current.status === "ready" ? orientHistoricalFeatures(history.current.features) : [] : modernFeatures;
        let sourceFeatures = history.current?.features;
        let sourceStatus = history.current?.status;
        let previousMode = historicalMode();
        let previousYear = history.current?.year;
        let publishedLocale: "zh" | "en" | undefined;
        reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let hovered: CountryFeature | null = null;
        let closeBubble=()=>{};
        let bubbleNodes:HTMLElement[]=[];
        let geographyNodes:HTMLElement[]=[];
        let selectedProvince:AdminFeature|null=null;
        let divisions:AdminFeature[]=[];
        let boundaries:AdminCollection={features:[],source:"",sourceUrl:"",label:"省／州级行政区"};
        let boundaryStatus:GeographyView["status"]="ready", boundaryRequest:AbortController|null=null;
        let boundaryVersion=0;
        lifetime.add(() => { boundaryRequest?.abort(); boundaryVersion++; });
        let altitudeScale=1;
        let cities: City[] = [], globalCities: City[] = [];
        let citiesPending = false;
        let labelsDirty = true, labelsSettlingUntil = 0;
        const invalidateLabels = () => { labelsDirty = true; labelsSettlingUntil = performance.now() + 300; };
        const knownCountries=new Set(modernFeatures.map(countryCode));
        const loadCities = async () => {
          if (historicalMode() || citiesPending || lifetime.signal.aborted) return;
          citiesPending = true;
          setCityStatus("loading");
          try {
            const response = await fetch("/data/cities.json", { signal: lifetime.signal });
            if (!response.ok) throw new Error("Cities unavailable");
            const raw: RawCity[] = await response.json();
            if (lifetime.signal.aborted) return;
            cities = decodeCities(raw);
            const globalCounts = new Map<string, number>();
            globalCities = cities.filter(city => {
              if (!knownCountries.has(city.country)) return false;
              const count = globalCounts.get(city.country) || 0;
              if (count >= 3 || (count >= 1 && city.rank > 3)) return false;
              globalCounts.set(city.country, count + 1);
              return true;
            });
            updateBubbles.current();
            setCityStatus("ready");
          } catch {
            if (!lifetime.signal.aborted) setCityStatus("error");
          } finally {
            citiesPending = false;
          }
        };
        retryCities.current = () => { void loadCities(); };
        let keyboardReading=false;
        let pointerOnCanvas=false;
        let cursor = { x: 0, y: 0 };
        let canvasCursor = { x: 0, y: 0 };
        let palette = countryPalette(features);
        const viewport=()=>{
          const width=element.clientWidth, height=element.clientHeight;
          const footer=parseFloat(getComputedStyle(element).getPropertyValue("--globe-footer")) || 116;
          return {width,height,footer,availableHeight:Math.max(160,height-footer)};
        };
        const colors = (f: CountryFeature) => isLandBackground(f) ? "#526963" : isAdmin(f) ? f===selectedProvince ? "#ddbd78" : f===hovered ? "#d4dec7" : selectedProvince && f!==selectedProvince ? "#899d95" : adminColor(f.properties.id) : countryCode(f)===selectedCode.current ? "#a9ad96" : f===hovered ? "#c9d8c4" : palette.get(countryCode(f))!;
        const surfaceAltitude = (f: CountryFeature) => {
          const selected = countryCode(f) === selectedCode.current;
          const altitude = historicalMode() ? historicalSurfaceAltitude(f, selected, f === hovered)
            : isAdmin(f) ? .009 : selected ? .005 : f === hovered ? .007 : .004;
          return altitudeScale * altitude;
        };
        const stroke = (f: CountryFeature) => isLandBackground(f) ? "" : isAdmin(f) ? f===hovered || f===selectedProvince ? "#fff1ca" : "#e1e8d980" : countryCode(f)===selectedCode.current ? "#e3d4a0" : "#263e43";
        const localCities=()=>{
          if (historicalMode()) return [];
          if(!selectedCode.current)return globalCities;
          return cities.filter(city=>city.country===selectedCode.current && (!selectedProvince || containsPlace(selectedProvince,city))).slice(0,selectedProvince ? 100 : 60);
        };
        const bubbleData=():GlobeBubble[]=>{
          const event=activeEvent.current;
          if (history.current) return history.current.status === "ready" ? historicalEventBubbles(data.current, features, {
            country: selectedCode.current || (event && features.some(feature => countryCode(feature) === event.country) ? event.country : null),
            selectedId: event?.id, locale: language.current,
          }) : [];
          const country=selectedCode.current || (event ? event.country==="TWN" ? "CHN" : event.country || `place:${event.location}` : null);
          if(country){
            const feature=features.find(f=>countryCode(f)===country);
            const fallback=feature ? countryView(feature,1,50) : undefined;
            return locationMessages(data.current,country,event?.id,fallback).map(group=>({
              ...group,
              name:hasCoordinates(group.events[0]) ? group.events[0].location : feature ? countryRegion(feature, language.current).name : group.events[0].location,
              selected:group.events.some(item=>item.id===event?.id),
            }));
          }
          return countryMessages(data.current,null).map(group=>{
            const feature=features.find(f=>countryCode(f)===group.country);
            if(!feature)return {...group,name:group.events[0].location};
            const center=countryView(feature,1,50);
            return {...group,lat:center.lat,lng:center.lng,name:countryRegion(feature, language.current).name};
          });
        };
        const flyToFeature = (f: CountryFeature, point?: {lat: number; lng: number}) => {
          overview.current.active = false;
          fittedRegion.current = { country: isAdmin(f) ? selectedCode.current : countryCode(f), division: isAdmin(f) ? f.properties.id : null, point };
          const view = countryViewportView(f, viewport(), (globe.camera() as PerspectiveCamera).fov, point, isAdmin(f) ? .025 : .16, isAdmin(f) ? .18 : 3);
          camera.current.vx = 0; camera.current.vy = 0;
          camera.current.targetAltitude = view.altitude;
          flight.current = { lat: view.lat, lng: view.lng };
          if (reducedMotion.current) Object.assign(camera.current, view);
          hovered = null;
          callbacks.current.onHover(null);
        };
        const publishGeography=()=>{
          const country=features.find(f=>countryCode(f)===selectedCode.current);
          setGeographyView(country ? {country:countryRegion(country, language.current).name,historical:historicalMode(),province:selectedProvince,choices:divisions,status:boundaryStatus,label:boundaries.label,source:boundaries.source,sourceUrl:boundaries.sourceUrl} : null);
        };
        const refreshGeography=()=>{
          // Detailed provinces replace the coarse country silhouette after
          // loading, so coastlines remain accurate when exploring a province.
          const countries=features.filter(f=>!divisions.length || countryCode(f)!==selectedCode.current);
          globe.polygonsData(historicalMode() ? [backdrop, ...features] : [...countries,...divisions]);
          updateBubbles.current();repaint.current();publishGeography();
        };
        const showDivisions=async()=>{
          if (historicalMode()) return;
          boundaryRequest?.abort();const controller=new AbortController();boundaryRequest=controller;
          const version=++boundaryVersion, code=selectedCode.current;
          if(!code)return;
          selectedProvince=null;divisions=[];boundaryStatus="loading";
          boundaries={features:[],source:"",sourceUrl:"",label:"省／州级行政区"};
          refreshGeography();
          try {
            const result=await loadDivisions(code,controller.signal);
            if(cancelled || controller.signal.aborted || version!==boundaryVersion)return;
            boundaries=result;divisions=result.features;
            boundaryStatus="ready";refreshGeography();
          } catch {
            if(controller.signal.aborted || version!==boundaryVersion)return;
            boundaryStatus="error";refreshGeography();
          }
        };
        const selectCountry = (f: CountryFeature, point?: {lat: number; lng: number}) => {
          if (isLandBackground(f)) return;
          selectedCode.current=countryCode(f);
          flyToFeature(f,point);
          callbacks.current.onRegionSelect(countryRegion(f, language.current));
          if (historicalMode()) refreshGeography();
          else void showDivisions();
        };
        const selectDivision=(f:AdminFeature,point?:{lat:number;lng:number})=>{
          if (historicalMode()) return;
          closeBubble();flyToFeature(f,point);
          selectedProvince=f;updateBubbles.current();repaint.current();publishGeography();
        };
        const selectCity=(city:City)=>{
          if (historicalMode()) return;
          if(!selectedCode.current || selectedCode.current!==city.country){
            const country=features.find(f=>countryCode(f)===city.country);if(country)selectCountry(country);return;
          }
          const province=divisions.find(f=>containsPlace(f,city));
          if(province)selectDivision(province);
        };
        const markerData=()=>historicalMode() || !selectedCode.current ? [] : [
          ...localCities().slice(0,selectedProvince ? 40 : 24).map(city=>({...city,markerType:"city",target:city})),
          ...divisions.map(f=>({id:f.properties.id,name:f.properties.name,...featureCenter(f),markerType:"division",target:f})),
        ];
        const createMarker=(item:MarkerDatum)=>{
          const anchor=document.createElement("div");anchor.className="geo-label-anchor";
          const button=document.createElement("button");button.className=`geo-label geo-label--${item.markerType}`;
          button.textContent=item.name;button.setAttribute("aria-label",`${item.markerType==="city" ? "城市" : "行政区"}：${item.name}，点击放大`);
          button.addEventListener("pointerdown",e=>e.stopPropagation());
          button.addEventListener("click",e=>{e.stopPropagation();if(item.markerType==="city")selectCity(item.target);else selectDivision(item.target);});
          button.addEventListener("focus",()=>{keyboardReading=true;});
          button.addEventListener("blur",()=>{keyboardReading=false;});
          anchor.appendChild(button);geographyNodes.push(anchor);return anchor;
        };
        lifetime.add(() => { element.classList.remove("is-dragging"); element.replaceChildren(); });
        const globe: GlobeInstance = new Globe(element, { animateIn: false, rendererConfig: { antialias: true, alpha: true } });
        lifetime.add(() => globe._destructor());
        globe.backgroundColor("#020408")
          .width(element.clientWidth).height(element.clientHeight)
          .globeMaterial(new THREE.MeshPhongMaterial({ color: "#122d3a", shininess: 9, specular: "#1f4653" }))
          .showAtmosphere(true).atmosphereColor("#658d9b").atmosphereAltitude(0.08)
          .showGraticules(false)
          .polygonsData(historicalMode() ? [backdrop, ...features] : features)
          .polygonAltitude(f=>surfaceAltitude(f as CountryFeature)).polygonCapColor(f=>colors(f as CountryFeature)).polygonSideColor(() => "#203c43")
          .polygonStrokeColor(f=>stroke(f as CountryFeature)).polygonsTransitionDuration(historicalMode() || reducedMotion.current ? 0 : 230)
          .labelsData(localCities()).labelLat("lat").labelLng("lng").labelAltitude(.017)
          .labelText(()=>"").labelSize(.01).labelIncludeDot(true).labelDotRadius(.12).labelResolution(8)
          .labelColor(city=>(city as City).capital ? "#ffe1a0" : "#f5f5e6").labelsTransitionDuration(0)
          .onLabelClick(city=>{if(drag.current.moved<=4)selectCity(city as City);})
          .onLabelHover(item=>{if(!pointerOnCanvas || flight.current)return;const city=item as City|null;callbacks.current.onHover(city ? {name:city.name,kind:"city",events:[],hint:"城市 · 点击放大",...cursor} : null);})
          .htmlElementsData(bubbleData()).htmlLat("lat").htmlLng("lng").htmlAltitude(0.016).htmlTransitionDuration(0)
          .htmlElement((item: object) => {
            const datum = item as HtmlElementDatum;
            if("markerType" in datum)return createMarker(datum);
            const node=createGlobeBubble(datum,{
              select:event=>callbacks.current.onSelect([event]),
              enter:()=>{hovered=null;repaint.current();callbacks.current.onHover(null);},
              expand:close=>{closeBubble();closeBubble=close;invalidateLabels();},
              reading:active=>{keyboardReading=active;},
            }, language.current);
            bubbleNodes.push(node);
            return node;
          })
          .onPolygonHover((feature: object | null) => {
            if (drag.current.active || flight.current || !pointerOnCanvas) return;
            let candidate = feature as CountryFeature | null;
            if (candidate && historicalMode() && !isLandBackground(candidate)) {
              const point = globe.toGlobeCoords(canvasCursor.x, canvasCursor.y);
              if (point) candidate = historicalPickFeature(candidate, features, point, selectedCode.current);
            }
            const f = candidate && !isLandBackground(candidate) ? candidate : null;
            hovered = f; repaint.current();
            callbacks.current.onHover(f ? isAdmin(f) ? {name:f.properties.name,kind:"division",events:[],hint:"点击放大省／州",...cursor} : { ...countryRegion(f, language.current), kind: "country", events: data.current.filter(e => eventMatchesCountry(e, countryCode(f), historicalMode())), hint: language.current === "en" ? "Click to explore" : "点击放大", ...cursor } : null);
          })
          .onPolygonClick((f: object, _event: MouseEvent, point: {lat: number; lng: number}) => {
            if (isLandBackground(f as CountryFeature) || drag.current.moved > 4 || performance.now() - drag.current.ended < 80) return;
            if (isAdmin(f as CountryFeature)) selectDivision(f as AdminFeature, point);
            else selectCountry(historicalMode() ? historicalPickFeature(f as CountryFeature, features, point, selectedCode.current) : f as CountryFeature, point);
          });
        repaint.current = () => {
          globe.polygonCapColor(f => colors(f as CountryFeature))
            .polygonAltitude(f => surfaceAltitude(f as CountryFeature))
            .polygonStrokeColor(f => stroke(f as CountryFeature));
          invalidateLabels();
        };
        updateBubbles.current=()=>{closeBubble();keyboardReading=false;bubbleNodes=[];geographyNodes=[];globe.htmlElementsData([...bubbleData(),...markerData()]);globe.labelsData(localCities());invalidateLabels();};
        const returnToCountry=()=>{
          const f=features.find(f=>countryCode(f)===selectedCode.current);
          if(f){selectedProvince=null;flyToFeature(f);updateBubbles.current();repaint.current();publishGeography();}
        };
        navigation.current={country:returnToCountry,back:()=>{if(selectedProvince)returnToCountry();else callbacks.current.onReset();},choose:id=>{if(!id){returnToCountry();return;}const f=divisions.find(f=>f.properties.id===id);if(f)selectDivision(f);},retry:()=>{void showDivisions();}};
        syncGeography.current=()=>{
          if(selectedCode.current)return;
          boundaryRequest?.abort();boundaryVersion++;selectedProvince=null;divisions=[];
          refreshGeography();
        };
        focusCountry.current = code => { const f = features.find(f => countryCode(f) === code); if (f) selectCountry(f); };
        syncExternalGeography.current = () => {
          const current = history.current;
          const modeChanged = previousMode !== historicalMode();
          const geometryChanged = modeChanged || sourceFeatures !== current?.features || sourceStatus !== current?.status;
          const localeChanged = publishedLocale !== language.current;
          const yearChanged = previousYear !== current?.year;
          if (geometryChanged) {
            // A response for a modern country must never restore province
            // polygons after a year/mode change. Preserve the camera itself.
            boundaryRequest?.abort(); boundaryVersion++;
            selectedProvince = null; divisions = []; boundaryStatus = "ready";
            boundaries = { features: [], source: "", sourceUrl: "", label: "省／州级行政区" };
            features = current ? current.status === "ready" ? orientHistoricalFeatures(current.features) : [] : modernFeatures;
            palette = countryPalette(features);
            if (selectedCode.current && !features.some(feature => countryCode(feature) === selectedCode.current)) selectedCode.current = null;
            globe.polygonsTransitionDuration(current || reducedMotion.current ? 0 : 230);
            refreshGeography();
          } else if (localeChanged) {
            updateBubbles.current(); publishGeography();
          }
          if (geometryChanged || localeChanged || yearChanged) {
            hovered = null; closeBubble(); callbacks.current.onHover(null); repaint.current();
          }
          if (geometryChanged || localeChanged) {
            callbacks.current.onCountriesReady(features.map(feature => countryRegion(feature, language.current)).sort((a, b) => a.name.localeCompare(b.name, language.current === "en" ? "en" : "zh-CN")));
          }
          element.dataset.geographyMode = current ? "historical" : "modern";
          element.dataset.geographyYear = current ? String(current.year) : "";
          element.dataset.geographyStatus = current?.status || "ready";
          element.dataset.polityCount = String(current ? features.length : 0);
          sourceFeatures = current?.features; sourceStatus = current?.status;
          previousYear = current?.year; previousMode = historicalMode(); publishedLocale = language.current;
          if (modeChanged && !current) {
            if (!cities.length) void loadCities();
            if (selectedCode.current) void showDivisions();
          }
        };
        syncExternalGeography.current();
        api.current = globe;
        globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));
        const sky = createGlobeSky(THREE, globe.scene(), globe.camera() as PerspectiveCamera);
        lifetime.add(() => sky.dispose());
        const controls = globe.controls();
        controls.enableRotate = false; controls.enableZoom = false; controls.enablePan = false;
        controls.enableDamping = false; controls.autoRotate = false;
        const fitOverview = () => {
          const {width:w,height:h,footer,availableHeight}=viewport();
          const padding = Math.min(24, Math.min(w,availableHeight)*.04);
          // Keep the globe above the timeline while the sky fills the canvas.
          globe.globeOffset([0,-footer/2]);
          const tangent = Math.tan((globe.camera() as PerspectiveCamera).fov*Math.PI/360);
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
        const refresh = () => {
          globe.width(element.clientWidth).height(element.clientHeight); fitOverview();
          const target = fittedRegion.current;
          if (!overview.current.active && target && target.country === selectedCode.current) {
            const feature = target.division ? divisions.find(f => f.properties.id === target.division) : features.find(f => countryCode(f) === target.country);
            if (feature) flyToFeature(feature, target.point);
          }
          // Clamp against the new viewport immediately, before the next
          // throttled label pass, while the camera settles into its new fit.
          layoutBubbles(); invalidateLabels();
        };
        const resize = new ResizeObserver(refresh);
        lifetime.add(() => resize.disconnect());
        resize.observe(element);
        const down = (event: PointerEvent) => {
          if (event.button !== 0 || drag.current.active) return;
          closeBubble();
          fittedRegion.current = null;
          flight.current = null;
          drag.current = { active: true, x: event.clientX, y: event.clientY, last: performance.now(), moved: 0, ended: 0, pointer: event.pointerId };
          camera.current.vx = 0; camera.current.vy = 0;
          canvas.setPointerCapture(event.pointerId); element.classList.add("is-dragging");
          callbacks.current.onHover(null);
        };
        const move = (event: PointerEvent) => {
          const rect = (element.closest(".globe-area") || element).getBoundingClientRect(); cursor = { x: event.clientX-rect.left, y: event.clientY-rect.top };
          const canvasRect = element.getBoundingClientRect(); canvasCursor = { x: event.clientX-canvasRect.left, y: event.clientY-canvasRect.top };
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
          event.preventDefault(); fittedRegion.current = null; overview.current.active = false; camera.current.targetAltitude = Math.max(.025, Math.min(Math.max(3.3, overview.current.altitude*1.35), camera.current.targetAltitude*Math.exp(event.deltaY*.0015)));
        };
        const lost = () => { if (drag.current.active) { camera.current.vx = 0; camera.current.vy = 0; } drag.current.active = false; element.classList.remove("is-dragging"); };
        lifetime.add(() => {
          canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
          canvas.removeEventListener("pointerenter", enter);
          canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", lost);
          canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("lostpointercapture", lost); canvas.removeEventListener("wheel", wheel);
        });
        canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerenter", enter);
        canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", lost);
        canvas.addEventListener("pointerleave", leave); canvas.addEventListener("lostpointercapture", lost);
        canvas.addEventListener("wheel", wheel, { passive: false });
        let last = performance.now(), lastLabelLayout=0, lastDotRadius=.12, lastLabelState="";
        let renderedView = { ...camera.current };
        function layoutBubbles(){
          const bounds=element.getBoundingClientRect(), footer=viewport().footer;
          const occupied:{left:number;right:number;top:number;bottom:number}[]=[];
          // Lift nearby labels along their stems, then omit a lower-priority
          // label only when no clear position remains. Keep an open stack still.
          const ordered=[...bubbleNodes].sort((a,b)=>Number(b.dataset.selected==="true")-Number(a.dataset.selected==="true") || Number(b.dataset.expanded==="true")-Number(a.dataset.expanded==="true") || Number(b.dataset.stacked==="true")-Number(a.dataset.stacked==="true"));
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
            const hidden=box.top<bounds.top+100 || box.bottom>bounds.bottom-footer-8 || box.left<bounds.left+8 || box.right>bounds.right-8 || occupied.some(o=>box.left<o.right+5 && box.right+5>o.left && box.top<o.bottom+3 && box.bottom+3>o.top);
            node.dataset.obscured=String(hidden);node.inert=hidden;
            if(!hidden)occupied.push(box);
          }
        }
        function tick(now: number) {
          const dt = Math.min((now-last)/1000, 0.05); last = now;
          if (document.hidden) { frame = requestAnimationFrame(tick); return; }
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
            if (!target && Math.abs(c.vx) < .001) c.vx = 0;
            if (Math.abs(c.vy) < .001) c.vy = 0;
            c.lng += c.vx*dt; c.lat = Math.max(-78, Math.min(78, c.lat+c.vy*dt));
          }
          c.lng = ((c.lng+180)%360+360)%360-180;
          c.altitude += (c.targetAltitude-c.altitude)*(1-Math.exp(-dt*7));
          if (Math.abs(c.targetAltitude-c.altitude) < .00001) c.altitude = c.targetAltitude;
          if (c.lat !== renderedView.lat || c.lng !== renderedView.lng || c.altitude !== renderedView.altitude) {
            globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: c.altitude }, 0);
            renderedView = { ...c };
            labelsDirty = true;
          }
          sky.update(now);
          const meteor = sky.active ? "visible" : "quiet";
          if (element.dataset.meteor !== meteor) element.dataset.meteor = meteor;
          if(now-lastLabelLayout>120){
            // Expansion may change on pointer leave or Escape without moving
            // the camera. Reading data attributes avoids layout while paused.
            const labelState = bubbleNodes.map(node => node.dataset.expanded).join(",");
            if (labelState !== lastLabelState) invalidateLabels();
            if (labelsDirty || now < labelsSettlingUntil) layoutBubbles();
            labelsDirty = false;
            lastLabelState = labelState;
            const radius=Math.max(.004,Math.min(.18,c.altitude*.18));
            if(Math.abs(radius-lastDotRadius)>lastDotRadius*.12){globe.labelDotRadius(radius);lastDotRadius=radius;}
            // Keep close-up borders and their labels on the same ground plane;
            // fixed globe-scale extrusion would float them kilometres apart.
            const nextScale=Math.min(1,c.altitude/.7);
            if(Math.abs(nextScale-altitudeScale)>altitudeScale*.12){
              altitudeScale=nextScale;
              globe.polygonAltitude(f => surfaceAltitude(f as CountryFeature)).htmlAltitude(.016*altitudeScale).labelAltitude(.017*altitudeScale);
            }
            lastLabelLayout=now;
          }
          const diagnostics = { longitude: c.lng, latitude: c.lat, altitude: c.altitude, velocity: c.vx };
          for (const [key, value] of Object.entries(diagnostics)) {
            const next = value.toFixed(3);
            if (element.dataset[key] !== next) element.dataset[key] = next;
          }
          frame = requestAnimationFrame(tick);
        }
        frame = requestAnimationFrame(tick);
        setStatus("ready");
        if(selectedCode.current)focusCountry.current(selectedCode.current);
        // City detail is optional and never holds the interactive globe behind
        // a slow or failed request. A later retry updates the current region.
        void loadCities();
      } catch (err) {
        lifetime.dispose();
        if (!cancelled) { console.error("Globe could not initialize", err); setStatus("error"); }
      }
    }
    void init(); return () => { cancelled = true; lifetime.dispose(); };
  }, [attempt]);

  useEffect(() => { syncExternalGeography.current(); }, [historicalGeography, locale]);

  useEffect(() => {
    updateBubbles.current();
  }, [events, selectedCountry, selectedEvent]);

  useEffect(() => { repaint.current(); }, [selectedCountry]);
  useEffect(() => { syncGeography.current(); }, [selectedCountry]);

  useEffect(() => { if (!spinning) { camera.current.vx = 0; camera.current.vy = 0; } }, [spinning]);

  useEffect(() => {
    if (!command) return;
    const c = camera.current;
    if (["in", "out", "reset"].includes(command.action)) fittedRegion.current = null;
    if (command.action === "in" || command.action === "out") overview.current.active = false;
    if (command.action === "back") {navigation.current.back();return;}
    if (command.action === "in") c.targetAltitude = Math.max(.025, c.targetAltitude/1.28);
    if (command.action === "out") c.targetAltitude = Math.min(Math.max(3.3, overview.current.altitude*1.35), c.targetAltitude*1.28);
    if (command.action === "reset") { overview.current.active = true; flight.current = { lat: 21, lng: 68 }; c.targetAltitude = overview.current.altitude; c.vx = spin.current ? c.direction*1.7 : 0; c.vy = 0; }
    if (command.action === "focus") {
      const hasPoint=Number.isFinite(command.lat) && Number.isFinite(command.lng);
      if(command.code && (command.code!==selectedCode.current || !hasPoint))focusCountry.current(command.code);
      if(hasPoint){
        fittedRegion.current = null;
        overview.current.active=false;c.vx=0;c.vy=0;
        c.targetAltitude=Math.min(c.targetAltitude,.65);
        flight.current={lat:command.lat!,lng:command.lng!};
      }
    }
    if (command.action === "country" && command.code) focusCountry.current(command.code);
  }, [command]);

  return <div className="globe-wrap">
    <div ref={host} className="globe-canvas" data-testid="globe" tabIndex={0} role="application"
      aria-label={locale === "en" ? "Interactive globe. Arrow keys rotate, plus and minus zoom, Space toggles rotation, Home returns to the world, and Enter selects a region. Drag to rotate, hover to preview, or click a region to explore." : "交互地球。方向键旋转，加减键缩放，空格暂停或继续自转，Home 返回全球，Enter 选择地区。也可拖动地球、悬停预览、点击地区放大。"}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const c = camera.current;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(event.key)) fittedRegion.current = null;
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
      <nav aria-label={locale === "en" ? "Map level" : "地图层级"} className="geography-breadcrumbs">
        <button onClick={()=>navigation.current.country()} aria-label={locale === "en" ? `Show all of ${geographyView.country}` : `返回${geographyView.country}全图`}>{geographyView.country}</button>
        {geographyView.province && <><ChevronRight size={13}/><span>{geographyView.province.properties.name}</span></>}
        <button className="geography-close" onClick={()=>callbacks.current.onReset()} aria-label={locale === "en" ? "Return to the world" : "返回全球"}><X size={16}/></button>
      </nav>
      {!historicalGeography && !geographyView.historical && <><div className="geography-context">
        {geographyView.status==="loading" ? <span role="status"><LoaderCircle size={12} className="loading-icon"/>加载{geographyView.label}…</span> : geographyView.status==="error" ? <button onClick={()=>navigation.current.retry()}>边界暂未加载 · 重试</button> : geographyView.choices.length ? <NativeSelect className="division-picker" value={geographyView.province?.properties.id || ""} aria-label="选择省或州" onChange={e=>navigation.current.choose(e.target.value)}><NativeSelectOption value="">{geographyView.label} · 点击地图或选择</NativeSelectOption>{geographyView.choices.map(f=><NativeSelectOption key={f.properties.id} value={f.properties.id}>{f.properties.name}</NativeSelectOption>)}</NativeSelect> : <span role="status">此地区暂无可用的省／州级边界</span>}
      </div>
      {cityStatus === "error" && <p className="geography-source" role="status">城市暂未加载 · <button className="text-button" onClick={() => retryCities.current()}>重试</button></p>}
      <p className="geography-source">现代行政区划 · <a href={geographyView.sourceUrl || "https://www.naturalearthdata.com/"} target="_blank" rel="noreferrer">{geographyView.source || "地图数据"} ↗</a></p></>}
    </div>}
    {status === "loading" && <div className="globe-status"><LoaderCircle className="loading-icon" size={28}/><p>展开世界地图…</p></div>}
    {status === "error" && <div className="globe-status"><p>地球暂时未能加载</p><span>请确认浏览器已开启图形加速，或重新加载。</span><button className="text-button" onClick={() => { setStatus("loading"); setAttempt(a => a+1); }}><RotateCcw size={16}/>重新加载</button></div>}
  </div>;
}
