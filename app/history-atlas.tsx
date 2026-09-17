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
import type { DayHistory } from "./on-this-day";
import { DAY, getMaxTime, MIN_TIME, clampTime, dateParts, eventsAt, timestamp, yearLabel, localToday, hasCoordinates, type AtlasEvent } from "./demo-data";

export default function HistoryAtlas({initialToday}: {initialToday: number}) {
  const [today, setToday] = useState(initialToday);
  const todayRef = useRef(initialToday);
  const [maxYear, setMaxYear] = useState(dateParts(initialToday).year);
  const maxTime = getMaxTime(maxYear);
  const [time, setTime] = useState(initialToday);
  const [spinning, setSpinning] = useState(true);
  const [region, setRegion] = useState<CountryRegion | null>(null);
  const [regionSpinning, setRegionSpinning] = useState(false);
  const [countries, setCountries] = useState<CountryRegion[]>([]);
  const [selected, setSelected] = useState<{ event: AtlasEvent; time: number } | null>(null);
  const [history, setHistory] = useState<DayHistory | null>(null);
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [command, setCommand] = useState<GlobeCommand | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateError, setDateError] = useState("");
  const [restored, setRestored] = useState(false);
  const timeRef = useRef(time); timeRef.current = time;
  const regionRef = useRef(region); regionRef.current = region;
  const globeArea = useRef<HTMLDivElement>(null);
  const parts = dateParts(time);
  const isToday = time === today;
  const todayParts = dateParts(today);
  const todaysEvents = useMemo(() => history?.month===todayParts.month && history.day===todayParts.day ? history.events.filter(e=>e.start<todayParts.year).map(e=>{
    return {...e, country:e.country==="TWN" ? "CHN" : e.country};
  }) : [], [history, today]);
  const events = useMemo(() => isToday ? todaysEvents : eventsAt(time, maxYear), [isToday, todaysEvents, time, maxYear]);
  const eventsRef = useRef(events); eventsRef.current=events;
  const statusRef = useRef(historyStatus); statusRef.current=historyStatus;
  const hasRegionEvents=events.some(event=>(!region || event.country===region.code) && hasCoordinates(event));
  const changeTime = useCallback((t: number) => { setTime(clampTime(Math.round(t/DAY)*DAY, maxYear)); setHover(null); setSelected(null);  }, [maxYear]);
  const sendCommand = useCallback((action: GlobeCommand["action"], lat?: number, lng?: number) => setCommand({ id: performance.now(), action, lat, lng }), []);
  const selectRegion = useCallback((next: CountryRegion) => { setRegion(next); setRegionSpinning(false); setHover(null); }, []);
  const returnToWorld = useCallback(() => { setRegion(null); setHover(null); sendCommand("reset"); }, [sendCommand]);
  const selectEvent = useCallback((event: AtlasEvent) => { setSelected({ event, time: timeRef.current }); setHover(null); if(hasCoordinates(event)) sendCommand("focus", event.lat, event.lng); }, [sendCommand]);

  useEffect(() => {
    // Hydrate from the server, then follow the visitor's calendar (including midnight).
    const refresh = () => {
      const next=localToday(), previous=todayRef.current;
      todayRef.current=next; setToday(next); setMaxYear(dateParts(next).year);
      if(next!==previous){setSelected(null);setHover(null);}
      setTime(current=>current===previous ? next : current);
    };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("world-atlas-state") || "null");
      if (saved && typeof saved.spinning === "boolean") setSpinning(saved.spinning);
      else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setSpinning(false);
    } catch { /* Storage is optional. */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const timeout = setTimeout(() => { try { localStorage.setItem("world-atlas-state", JSON.stringify({spinning})); } catch {} }, 250);
    return () => clearTimeout(timeout);
  }, [spinning, restored]);
  useEffect(() => {
    const controller=new AbortController();
    let retryTimer:ReturnType<typeof setTimeout> | undefined;
    setHistoryStatus("loading"); setHover(null);
    fetch(`/api/on-this-day?month=${todayParts.month}&day=${todayParts.day}`, {signal:controller.signal})
      .then(async response=>{if(!response.ok)throw new Error("History unavailable");return response.json() as Promise<DayHistory>;})
      .then(data=>{if(!controller.signal.aborted){setHistory(data);setHistoryStatus("ready");if(data.partial)retryTimer=setTimeout(()=>setHistoryAttempt(n=>n+1),65_000);}})
      .catch(()=>{if(!controller.signal.aborted)setHistoryStatus("error");});
    return ()=>{controller.abort();clearTimeout(retryTimer);};
  }, [todayParts.month,todayParts.day,historyAttempt]);
  const goToday = () => {const next=localToday(); todayRef.current=next;setToday(next);setMaxYear(dateParts(next).year);setTime(next);setSelected(null);returnToWorld();setDateOpen(false);};
  const closeDetails = () => {setSelected(null);if(!region)sendCommand("reset");};
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
    register({ name: "read_atlas_state", description: "Read the visible date, mode, loading status and events. Today shows sourced historical anniversaries; other dates retain illustrative demo scenarios.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute() { return { date: dateParts(timeRef.current), region:regionRef.current, demo:timeRef.current!==todayRef.current, status:statusRef.current, events:eventsRef.current.filter(e => !regionRef.current || e.country === regionRef.current.code).map(e => ({id:e.id,title:e.title,location:e.location,date:e.historical, mapped:hasCoordinates(e)})) }; } });
    register({ name: "navigate_history_date", description: `Change the visible globe and timeline to a date. Negative years mean BCE; no year zero. Supports -500 through ${maxYear}.`, inputSchema: { type:"object", properties:{year:{type:"integer",minimum:-500,maximum:maxYear},month:{type:"integer",minimum:1,maximum:12},day:{type:"integer",minimum:1,maximum:31}}, required:["year","month","day"],additionalProperties:false }, annotations:{readOnlyHint:false}, execute(input:{year:number;month:number;day:number}) { const {year,month,day}=input; if (![year,month,day].every(Number.isInteger) || year===0 || year < -500 || year > maxYear) throw new Error("Invalid historical date"); const t=timestamp(year,month,day), checked=dateParts(t); if (checked.year!==year || checked.month!==month || checked.day!==day) throw new Error("Invalid calendar date"); flushSync(()=>changeTime(t)); return {date:checked,demo:t!==todayRef.current}; } });
    return () => lifecycle.abort();
  }, [changeTime, maxYear]);

  const percent = (time-MIN_TIME)/(maxTime-MIN_TIME)*100;
  return <main className="atlas-app">
    <h1 className="sr-only">纪元 · 世界历史地图</h1>
    <section className="globe-area" ref={globeArea} aria-label="世界历史探索">
      <div className="keyboard-region-picker"><NativeSelect aria-label="选择国家或地区" disabled={!countries.length} value={region?.code || ""} onChange={e => e.target.value ? setCommand({id:performance.now(),action:"country",code:e.target.value}) : returnToWorld()}><NativeSelectOption value="">全球视图</NativeSelectOption>{countries.map(c => <NativeSelectOption key={c.code} value={c.code}>{c.name}</NativeSelectOption>)}</NativeSelect></div>
      <GlobeView events={events} spinning={!selected && (region ? regionSpinning : spinning)} command={command} selectedCountry={region?.code || null} onRegionSelect={selectRegion} onCountriesReady={setCountries} onSelect={items=>{if(items[0])selectEvent(items[0]);}} onHover={setHover} onReset={returnToWorld} onToggleSpin={() => region ? setRegionSpinning(v => !v) : setSpinning(v => !v)}/>
      {region && <button className="region-return" onClick={returnToWorld} aria-label="返回全球"><span>{region.name}</span><X size={16}/></button>}
      {isToday && historyStatus!=="ready" && !events.length ? <div className="map-history-status" role="status">{historyStatus==="loading" ? "正在查阅历史上的今天…" : <button onClick={()=>setHistoryAttempt(n=>n+1)}>历史消息暂未加载 · 重试</button>}</div> : !hasRegionEvents && <div className="map-history-status" role="status">{region ? `${region.name} · 暂无当日事件` : "暂无已定位的当日事件"}</div>}
      {hover && !selected && <div className="map-tooltip" role="status" style={{left:Math.max(12,Math.min(hover.x+16,(globeArea.current?.clientWidth || 700)-140)),top:Math.max(12,Math.min(hover.y+16,(globeArea.current?.clientHeight || 600)-52))}}><strong>{hover.name}</strong><small>点击放大</small></div>}
    </section>

    <section className="timeline" aria-label="历史时间轴">
      <div className="day-context">{isToday ? <span>今天</span> : <button onClick={goToday}>回到今天</button>}</div>
      <button className="current-year" onClick={()=>{setDateOpen(true);setDateError("");}} aria-label={`当前${yearLabel(parts.year)} ${parts.month}月${parts.day}日，点击修改日期`} title="点击修改日期">{parts.year < 0 && <span>公元前 </span>}{Math.abs(parts.year)}<span> 年 </span>{String(parts.month).padStart(2,"0")}<span> 月 </span>{String(parts.day).padStart(2,"0")}<span> 日</span></button>
      <div className="timeline-line"><Slider className="time-slider" min={MIN_TIME} max={maxTime} step={DAY} value={[time]} aria-label="历史日期" onValueChange={v=>changeTime(v[0])}/><div className="timeline-ticks" aria-hidden="true">{[-500,1,500,1000,1500,maxYear].map(year=><i key={year} style={{left:`${(timestamp(year)-MIN_TIME)/(maxTime-MIN_TIME)*100}%`}}/>)}</div></div>
      <div className="timeline-ends" aria-hidden="true"><span>公元前 500 年</span><span>{maxYear} 年</span></div>
      <span className="sr-only">当前进度 {Math.round(percent)}%。方向键逐日调整，点击日期可输入准确日期。</span>
    </section>

    <Sheet open={!!selected} onOpenChange={open=>{if(!open)closeDetails();}}><SheetContent className="event-sheet" showCloseButton={false} onCloseAutoFocus={event=>{event.preventDefault();const target=document.querySelector<HTMLElement>(".globe-canvas");target?.focus({preventScroll:true});}}>
      <div className="sheet-top"><span>{selected?.event.historical ? "历史上的今天" : "演示事件"}</span><SheetClose className="icon-button" aria-label="关闭事件详情"><X size={20}/></SheetClose></div>
      {selected && <><SheetHeader><SheetTitle>{selected.event.title}</SheetTitle><SheetDescription>{selected.event.historical ? `${yearLabel(selected.event.historical.year)} ${selected.event.historical.month}月${selected.event.historical.day}日` : `${selected.event.location} · ${yearLabel(dateParts(selected.time).year)}`}</SheetDescription></SheetHeader><div className="sheet-content">
        {selected.event.summary && <p>{selected.event.summary}</p>}
        {selected.event.historical ? <><p className="event-place">{hasCoordinates(selected.event) ? `关联地点：${selected.event.location}` : "此条事件尚无可靠地点，暂未标在地图上。"}</p><p className="source-note">{selected.event.historical.locationUrl && <>地图采用关联地点的词条坐标，不代表事件范围。<br/><a href={selected.event.historical.locationUrl} target="_blank" rel="noreferrer">查看地点资料 ↗</a><br/></>}<a href={selected.event.historical.sourceUrl} target="_blank" rel="noreferrer">{selected.event.historical.sourceUrl.includes("wikipedia.org") ? "来源：维基百科" : "来源：美国国务院历史档案"} ↗</a>{selected.event.historical.sourceUrl.includes("wikipedia.org") && <><br/><a href="https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans" target="_blank" rel="noreferrer">CC BY-SA 4.0</a> · 来源文字整理</>}</p></> : <p className="demo-note">当前内容用于交互演示，历史资料后续补充。</p>}
      </div></>}
    </SheetContent></Sheet>
    <Dialog open={dateOpen} onOpenChange={setDateOpen}><DialogContent className="atlas-dialog"><DialogHeader><DialogTitle>选择日期</DialogTitle><DialogDescription>负数表示公元前，没有公元 0 年。</DialogDescription></DialogHeader><form onSubmit={event=>{
      event.preventDefault(); const form=new FormData(event.currentTarget), year=Number(form.get("year")), month=Number(form.get("month")), day=Number(form.get("day"));
      const t=timestamp(year,month,day), checked=dateParts(t);
      if (!Number.isInteger(year) || year===0 || year < -500 || year > maxYear || checked.year!==year || checked.month!==month || checked.day!==day) {setDateError(`请输入公元前 500 年至公元 ${maxYear} 年之间的有效日期。`);return;}
      changeTime(t);setDateOpen(false);
    }}><div className="date-fields"><label>年份<input name="year" type="number" required min="-500" max={maxYear} defaultValue={parts.year} aria-describedby={dateError ? "date-error" : undefined}/></label><label>月<input name="month" type="number" required min="1" max="12" defaultValue={parts.month}/></label><label>日<input name="day" type="number" required min="1" max="31" defaultValue={parts.day}/></label></div>{dateError && <p id="date-error" className="form-error" role="alert">{dateError}</p>}<button className="primary-button" type="submit">前往<ArrowRight size={16}/></button><button className="text-button today-button" type="button" onClick={goToday}>回到今天 · {todayParts.year}年{todayParts.month}月{todayParts.day}日</button></form></DialogContent></Dialog>
  </main>;
}
