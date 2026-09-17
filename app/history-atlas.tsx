"use client";

/* Visual direction: one large globe, one quiet line of time.
 * Keep geography and date immediately available; reveal all details on interaction.
 * Remove permanent panels, labels, toolbar, era bands and playback controls.
 */
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import GlobeView, { type GlobeCommand, type HoverInfo } from "./globe-view";
import type { CountryRegion } from "./country-geometry";
import { DAY, MAX_TIME, MIN_TIME, clampTime, dateParts, eventsAt, timestamp, yearLabel, type AtlasEvent } from "./demo-data";

export default function HistoryAtlas() {
  const [time, setTime] = useState(timestamp(1450, 6, 15));
  const [spinning, setSpinning] = useState(true);
  const [region, setRegion] = useState<CountryRegion | null>(null);
  const [regionSpinning, setRegionSpinning] = useState(false);
  const [countries, setCountries] = useState<CountryRegion[]>([]);
  const [selected, setSelected] = useState<{ event: AtlasEvent; time: number } | null>(null);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [command, setCommand] = useState<GlobeCommand | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateError, setDateError] = useState("");
  const [restored, setRestored] = useState(false);
  const timeRef = useRef(time); timeRef.current = time;
  const regionRef = useRef(region); regionRef.current = region;
  const globeArea = useRef<HTMLDivElement>(null);
  const parts = dateParts(time);
  const events = useMemo(() => eventsAt(time), [parts.year]);
  const regionEvents = region ? events.filter(e => e.country === region.code) : [];
  const changeTime = useCallback((t: number) => { setTime(clampTime(Math.round(t/DAY)*DAY)); setHover(null); }, []);
  const sendCommand = useCallback((action: GlobeCommand["action"], lat?: number, lng?: number) => setCommand({ id: performance.now(), action, lat, lng }), []);
  const selectRegion = useCallback((next: CountryRegion) => { setRegion(next); setRegionSpinning(false); setHover(null); }, []);
  const returnToWorld = useCallback(() => { setRegion(null); setHover(null); sendCommand("reset"); }, [sendCommand]);
  const selectEvent = useCallback((event: AtlasEvent) => { setSelected({ event, time: timeRef.current }); setHover(null); sendCommand("focus", event.lat, event.lng); }, [sendCommand]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("world-atlas-state") || "null");
      if (saved && Number.isFinite(saved.time)) setTime(clampTime(saved.time));
      if (saved && typeof saved.spinning === "boolean") setSpinning(saved.spinning);
      else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setSpinning(false);
    } catch { /* Storage is optional. */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const timeout = setTimeout(() => { try { localStorage.setItem("world-atlas-state", JSON.stringify({time, spinning})); } catch {} }, 250);
    return () => clearTimeout(timeout);
  }, [time, spinning, restored]);
  useEffect(() => {
    const thumb = document.querySelector('.time-slider [role="slider"]');
    thumb?.setAttribute("aria-label", "历史日期");
    thumb?.setAttribute("aria-valuetext", `${yearLabel(parts.year)} ${parts.month}月${parts.day}日`);
  }, [time, parts.year, parts.month, parts.day]);
  useEffect(() => {
    if (!region || selected || dateOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") returnToWorld(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [region, selected, dateOpen, returnToWorld]);
  useEffect(() => {
    const context = (document as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: unknown) => { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
    register({ name: "read_atlas_state", description: "Read the selected date, region and illustrative events. All events are demo scenarios, not verified history.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute() { return { date: dateParts(timeRef.current), region:regionRef.current, demo:true, events:eventsAt(timeRef.current).filter(e => !regionRef.current || e.country === regionRef.current.code).map(e => ({id:e.id,title:e.title,location:e.location})) }; } });
    register({ name: "navigate_history_date", description: "Change the visible globe and timeline to a date. Negative years mean BCE; no year zero. Supports -500 through 2025.", inputSchema: { type:"object", properties:{year:{type:"integer",minimum:-500,maximum:2025},month:{type:"integer",minimum:1,maximum:12},day:{type:"integer",minimum:1,maximum:31}}, required:["year","month","day"],additionalProperties:false }, annotations:{readOnlyHint:false}, execute(input:{year:number;month:number;day:number}) { const {year,month,day}=input; if (![year,month,day].every(Number.isInteger) || year===0 || year < -500 || year > 2025) throw new Error("Invalid historical date"); const t=timestamp(year,month,day), checked=dateParts(t); if (checked.year!==year || checked.month!==month || checked.day!==day) throw new Error("Invalid calendar date"); flushSync(()=>changeTime(t)); return {date:checked,demo:true}; } });
    return () => lifecycle.abort();
  }, [changeTime]);

  const percent = (time-MIN_TIME)/(MAX_TIME-MIN_TIME)*100;
  return <main className="atlas-app">
    <h1 className="sr-only">纪元 · 世界历史地图</h1>
    <section className="globe-area" ref={globeArea} aria-label="世界历史探索">
      <div className="keyboard-region-picker"><NativeSelect aria-label="选择国家或地区" disabled={!countries.length} value={region?.code || ""} onChange={e => e.target.value ? setCommand({id:performance.now(),action:"country",code:e.target.value}) : returnToWorld()}><NativeSelectOption value="">全球视图</NativeSelectOption>{countries.map(c => <NativeSelectOption key={c.code} value={c.code}>{c.name}</NativeSelectOption>)}</NativeSelect></div>
      <GlobeView events={events} spinning={region ? regionSpinning : spinning} command={command} selectedCountry={region?.code || null} onRegionSelect={selectRegion} onCountriesReady={setCountries} onSelect={selectEvent} onHover={setHover} onReset={returnToWorld} onToggleSpin={() => region ? setRegionSpinning(v => !v) : setSpinning(v => !v)}/>
      {hover && !selected && <div className="map-tooltip" role="status" style={{left:Math.max(12,Math.min(hover.x+18,(globeArea.current?.clientWidth || 700)-244)),top:Math.max(12,Math.min(hover.y+18,(globeArea.current?.clientHeight || 600)-150))}}><strong>{hover.name}</strong>{hover.events.length ? hover.events.slice(0,2).map(e=><p key={e.id}>{e.title}<span>演示</span></p>) : <p className="muted">暂无演示事件</p>}<small>{hover.kind === "country" ? "点击放大" : "点击查看详情"}</small></div>}
    </section>

    {region && <aside className="region-card" aria-label={`${region.name}地区详情`}><div className="region-card-header"><h2>{region.name}</h2><button className="icon-button" onClick={returnToWorld} aria-label="返回全球" title="返回全球"><X size={18}/></button></div><p className="region-date">{yearLabel(parts.year)} · 演示事件</p><div className="region-events">{regionEvents.length ? regionEvents.map(event=><button key={event.id} className="region-event" onClick={()=>selectEvent(event)}><span>{event.title}<small>{event.location}</small></span><ArrowRight size={16}/></button>) : <p className="empty-region">暂无演示事件</p>}</div><p className="region-note">现代地理轮廓 · 历史资料待补充</p></aside>}

    <section className="timeline" aria-label="历史时间轴">
      <button className="current-year" onClick={()=>{setDateOpen(true);setDateError("");}} aria-label={`当前${yearLabel(parts.year)} ${parts.month}月${parts.day}日，点击修改日期`} title="点击修改日期">{parts.year < 0 && <span>公元前 </span>}{Math.abs(parts.year)}<span> 年</span></button>
      <div className="timeline-line"><Slider className="time-slider" min={MIN_TIME} max={MAX_TIME} step={DAY} value={[time]} aria-label="历史日期" onValueChange={v=>changeTime(v[0])}/><div className="timeline-ticks" aria-hidden="true">{[-500,1,500,1000,1500,2025].map(year=><i key={year} style={{left:`${(timestamp(year)-MIN_TIME)/(MAX_TIME-MIN_TIME)*100}%`}}/>)}</div></div>
      <div className="timeline-ends" aria-hidden="true"><span>公元前 500 年</span><span>2025 年</span></div>
      <span className="sr-only">当前进度 {Math.round(percent)}%。方向键逐日调整，点击年份可输入准确日期。</span>
    </section>

    <Sheet open={!!selected} onOpenChange={open=>{if(!open)setSelected(null);}}><SheetContent className="event-sheet" showCloseButton={false}><div className="sheet-top"><span>演示事件</span><SheetClose className="icon-button" aria-label="关闭事件详情"><X size={20}/></SheetClose></div>{selected && <><SheetHeader><SheetTitle>{selected.event.title}</SheetTitle><SheetDescription>{selected.event.location} · {yearLabel(dateParts(selected.time).year)}</SheetDescription></SheetHeader><div className="sheet-content"><p>{selected.event.summary}</p><p className="demo-note">当前内容用于交互演示，历史资料后续补充。</p></div></>}</SheetContent></Sheet>
    <Dialog open={dateOpen} onOpenChange={setDateOpen}><DialogContent className="atlas-dialog"><DialogHeader><DialogTitle>选择日期</DialogTitle><DialogDescription>负数表示公元前，没有公元 0 年。</DialogDescription></DialogHeader><form onSubmit={event=>{
      event.preventDefault(); const form=new FormData(event.currentTarget), year=Number(form.get("year")), month=Number(form.get("month")), day=Number(form.get("day"));
      const t=timestamp(year,month,day), checked=dateParts(t);
      if (!Number.isInteger(year) || year===0 || year < -500 || year > 2025 || checked.year!==year || checked.month!==month || checked.day!==day) {setDateError("请输入公元前 500 年至公元 2025 年之间的有效日期。");return;}
      changeTime(t);setDateOpen(false);
    }}><div className="date-fields"><label>年份<input name="year" type="number" required min="-500" max="2025" defaultValue={parts.year} aria-describedby={dateError ? "date-error" : undefined}/></label><label>月<input name="month" type="number" required min="1" max="12" defaultValue={parts.month}/></label><label>日<input name="day" type="number" required min="1" max="31" defaultValue={parts.day}/></label></div>{dateError && <p id="date-error" className="form-error" role="alert">{dateError}</p>}<button className="primary-button" type="submit">前往<ArrowRight size={16}/></button></form></DialogContent></Dialog>
  </main>;
}
