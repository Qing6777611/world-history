"use client";

/* Direction: a quiet, cartographic observatory. Navy, sea-glass and antique gold;
 * editorial numerals, restrained borders, one dominant globe, instruments at the edges.
 * Flow: scrub or play time → hover geography → open a fixed event detail.
 * Historical content is deliberately isolated, explicitly labelled demo data.
 */
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownRight, ArrowLeft, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Compass, Globe2, Hand, HelpCircle, MapPin, Minus, Pause, Play, Plus, RotateCcw, Scan, Sparkles, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import GlobeView, { type GlobeCommand, type HoverInfo } from "./globe-view";
import { CATEGORY_COLORS, DAY, DEMO_EVENTS, MAX_TIME, MIN_TIME, PERIODS, clampTime, dateParts, eventsAt, periodAt, timestamp, yearLabel, type AtlasEvent } from "./demo-data";

type Scale = "all" | "century" | "decade" | "year" | "month";
const SCALES: { id: Scale; label: string; span: number; rate: number }[] = [
  { id: "all", label: "全览", span: MAX_TIME-MIN_TIME, rate: DAY*365.2425*35 },
  { id: "century", label: "百年", span: DAY*365.2425*100, rate: DAY*365.2425*3 },
  { id: "decade", label: "十年", span: DAY*365.2425*10, rate: DAY*100 },
  { id: "year", label: "年", span: DAY*366, rate: DAY*10 },
  { id: "month", label: "月", span: DAY*31, rate: DAY },
];
function rangeAt(t: number, scale: Scale): [number, number] {
  const span = Math.round(SCALES.find(s => s.id === scale)!.span/DAY)*DAY;
  if (scale === "all") return [MIN_TIME, MAX_TIME];
  const start = Math.max(MIN_TIME, Math.min(MAX_TIME-span, Math.round((t-span/2)/DAY)*DAY));
  return [start, start+span];
}
function tickLabel(t: number, scale: Scale) {
  const d = dateParts(t);
  if (scale === "month") return `${d.month}/${d.day}`;
  if (scale === "year") return `${d.month}月`;
  return d.year < 0 ? `前 ${Math.abs(d.year)}` : `${d.year}`;
}

export default function HistoryAtlas() {
  const [time, setTime] = useState(timestamp(1450, 6, 15));
  const [scale, setScale] = useState<Scale>("all");
  const [range, setRange] = useState<[number, number]>([MIN_TIME, MAX_TIME]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [spinning, setSpinning] = useState(true);
  const [selected, setSelected] = useState<{ event: AtlasEvent; time: number } | null>(null);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [command, setCommand] = useState<GlobeCommand | null>(null);
  const [help, setHelp] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateError, setDateError] = useState("");
  const [restored, setRestored] = useState(false);
  const [category, setCategory] = useState("all");
  const timeRef = useRef(time); timeRef.current = time;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const globeArea = useRef<HTMLDivElement>(null);
  const parts = dateParts(time);
  const period = periodAt(time);
  const periodIndex = PERIODS.indexOf(period);
  const allEvents = useMemo(() => eventsAt(time), [parts.year]);
  const events = useMemo(() => category === "all" ? allEvents : allEvents.filter(e => e.category === category), [allEvents, category]);
  const changeTime = useCallback((t: number) => { setTime(clampTime(Math.round(t/DAY)*DAY)); setHover(null); }, []);
  const sendCommand = useCallback((action: GlobeCommand["action"], lat?: number, lng?: number) => setCommand({ id: performance.now(), action, lat, lng }), []);
  const selectEvent = useCallback((event: AtlasEvent) => {
    setSelected({ event, time: timeRef.current }); setPlaying(false); setHover(null); sendCommand("focus", event.lat, event.lng);
  }, [sendCommand]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("world-atlas-state") || "null");
      if (saved && Number.isFinite(saved.time)) {
        const t = clampTime(saved.time); setTime(t);
        const s: Scale = SCALES.some(s => s.id === saved.scale) ? saved.scale : "all";
        setScale(s); setRange(rangeAt(t, s));
      }
      if (saved && typeof saved.spinning === "boolean") setSpinning(saved.spinning);
      else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setSpinning(false);
    } catch { /* Browser storage is optional. */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const timeout = setTimeout(() => { try { localStorage.setItem("world-atlas-state", JSON.stringify({ time, scale, spinning })); } catch {} }, 250);
    return () => clearTimeout(timeout);
  }, [time, scale, spinning, restored]);
  useEffect(() => {
    if (!playing) return;
    const rate = SCALES.find(s => s.id === scale)!.rate*speed;
    let previous = performance.now(); let accumulator = timeRef.current;
    const interval = setInterval(() => {
      const now = performance.now(); accumulator += rate*Math.min((now-previous)/1000, 0.3); previous = now;
      if (accumulator >= MAX_TIME) { changeTime(MAX_TIME); setPlaying(false); return; }
      changeTime(accumulator);
      setRange(r => accumulator > r[1] ? rangeAt(accumulator, scale) : r);
    }, 80);
    return () => clearInterval(interval);
  }, [playing, scale, speed, changeTime]);
  useEffect(() => {
    const thumb = document.querySelector('.time-slider [role="slider"]');
    thumb?.setAttribute("aria-label", "历史日期");
    thumb?.setAttribute("aria-valuetext", `${yearLabel(parts.year)} ${parts.month}月${parts.day}日`);
  }, [time, range, parts.year, parts.month, parts.day]);
  useEffect(() => {
    const context = (document as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: unknown) => { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
    register({ name: "read_atlas_state", description: "Read the selected date and available illustrative events. All events are demo scenarios, not verified history.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute() { return { date: dateParts(timeRef.current), scale: scaleRef.current, demo: true, events: eventsAt(timeRef.current).map(e => ({ id: e.id, title: e.title, location: e.location })) }; } });
    register({ name: "navigate_history_date", description: "Change the visible globe and timeline to a date. Negative years mean BCE; no year zero. Supports -500 through 2025.", inputSchema: { type: "object", properties: { year: { type: "integer", minimum: -500, maximum: 2025 }, month: { type: "integer", minimum: 1, maximum: 12 }, day: { type: "integer", minimum: 1, maximum: 31 } }, required: ["year", "month", "day"], additionalProperties: false }, annotations: { readOnlyHint: false }, execute(input: { year: number; month: number; day: number }) { const {year,month,day} = input; if (![year,month,day].every(Number.isInteger) || year === 0 || year < -500 || year > 2025) throw new Error("Invalid historical date"); const t = timestamp(year,month,day), checked = dateParts(t); if (checked.year!==year || checked.month!==month || checked.day!==day) throw new Error("Invalid calendar date"); flushSync(() => {setPlaying(false); changeTime(t); setRange(rangeAt(t,scaleRef.current));}); return {date:checked,demo:true,eventCount:eventsAt(t).length}; } });
    return () => lifecycle.abort();
  }, [changeTime]);
  useEffect(() => { setHover(null); }, [category]);
  const chooseScale = (value: string) => {
    if (!value) return;
    const s = value as Scale; setScale(s); setRange(rangeAt(timeRef.current, s));
  };
  const panTimeline = (direction: number) => {
    setPlaying(false);
    const span = range[1]-range[0], t = clampTime(time+(span*0.7*direction));
    changeTime(t); setRange(rangeAt(t, scale));
  };
  const ticks = scale === "all" ? [-500, 1, 500, 1000, 1500, 2025].map(y => timestamp(y)) : Array.from({length:7},(_,i) => range[0]+(range[1]-range[0])*i/6);
  const percent = Math.max(0, Math.min(100, (time-range[0])/(range[1]-range[0])*100));
  const togglePlay = () => { if (!playing && time >= MAX_TIME) { changeTime(MIN_TIME); setRange(rangeAt(MIN_TIME, scale)); } setPlaying(p => !p); };

  return <main className="atlas-app">
    <header className="app-header">
      <a className="brand" href="/" aria-label="纪元，世界历史地图首页"><span className="brand-mark"><Globe2 size={27} strokeWidth={1.2}/></span><span className="brand-title">纪元<span>WORLD HISTORY ATLAS</span></span></a>
      <div className="header-center"><span className="header-line"/>一个世界，无数个此刻<span className="header-line"/></div>
      <div className="header-actions"><span className="demo-badge">交互原型 · 演示数据</span><button className="icon-button" aria-label="操作说明" title="操作说明" onClick={() => setHelp(true)}><HelpCircle size={19}/></button></div>
    </header>

    <section className="explorer" aria-label="世界历史探索">
      <aside className="time-context">
        <p className="eyebrow">THE WORLD AT THIS MOMENT</p>
        <button className="date-heading" onClick={() => { setDateOpen(true); setDateError(""); }} aria-label={`当前${yearLabel(parts.year)}，点击跳转日期`}>
          <span className="era-label">{parts.year < 0 ? "公元前" : "公元"}</span>
          <span className="year-number">{Math.abs(parts.year)}<span>年</span></span>
          <span className="exact-date">{String(parts.month).padStart(2,"0")} 月 {String(parts.day).padStart(2,"0")} 日 <CalendarDays size={14}/></span>
        </button>
        <div className="period-intro" key={period.name}><span className="section-index">0{periodIndex+1} / 06</span><h1>{period.name}</h1><p>{period.subtitle}</p><span className="period-years">{yearLabel(period.start)} — {yearLabel(period.end)}</span></div>
        <div className="map-key"><p className="eyebrow">事件主题</p><div className="category-list"><button onClick={() => setCategory("all")} className={category === "all" ? "active" : ""} aria-pressed={category === "all"}><span className="key-dot all-dot"/>全部主题 <span>{allEvents.length}</span></button>{Object.entries(CATEGORY_COLORS).map(([name, color]) => <button key={name} onClick={() => setCategory(category === name ? "all" : name)} className={category === name ? "active" : ""} aria-pressed={category === name}><span className="key-dot" style={{background: color}}/>{name}<span>{allEvents.filter(e => e.category === name).length}</span></button>)}</div></div>
        <p className="geography-note">现代地理轮廓仅作位置参照<br/>不代表所选年代的历史疆域</p>
      </aside>

      <div className="globe-area" ref={globeArea}>
        <div className="globe-orbit" aria-hidden="true"><span>N</span><i/><span>S</span></div>
        <GlobeView events={events} spinning={spinning} command={command} onSelect={selectEvent} onHover={setHover}/>
        {hover && <div className="map-tooltip" role="status" style={{left: Math.min(Math.max(16, hover.x+18), (globeArea.current?.clientWidth || 700)-256), top: Math.max(16, Math.min(hover.y+16, (globeArea.current?.clientHeight || 600)-156))}}><span className="tooltip-overline">{hover.events.length ? "此刻的演示场景" : "地区预览"}</span><strong>{hover.name}</strong>{hover.events.length ? hover.events.slice(0,2).map(e => <p key={e.id}><span className="key-dot" style={{background:e.color}}/>{e.title}</p>) : <p className="muted">该地区暂无演示事件</p>}{hover.events.length>0 && <small>点击地点，固定详情 <ArrowDownRight size={12}/></small>}</div>}
        <div className="globe-bottom"><span className="interaction-hint"><Hand size={15}/>拖动旋转<span>·</span>滚轮缩放<span>·</span>悬停探索</span><div className="globe-tools"><button className="icon-button" aria-label="缩小地球" title="缩小地球" onClick={() => sendCommand("out")}><Minus size={17}/></button><button className="icon-button" aria-label="放大地球" title="放大地球" onClick={() => sendCommand("in")}><Plus size={17}/></button><span className="tool-divider"/><button className="icon-button" aria-label="重置地球视角" title="重置视角" onClick={() => sendCommand("reset")}><Scan size={17}/></button><button className={`icon-button ${spinning ? "is-on" : ""}`} aria-label={spinning ? "暂停地球自转" : "开启地球自转"} aria-pressed={spinning} title={spinning ? "暂停自转" : "开启自转"} onClick={() => setSpinning(v => !v)}>{spinning ? <Pause size={16}/> : <Play size={16}/>}</button></div></div>
      </div>

      <aside className="events-panel" aria-label="当前时期事件列表">
        <div className="events-header"><div><p className="eyebrow">MEANWHILE, ON EARTH</p><h2>此刻的世界</h2></div><span className="event-count">{String(events.length).padStart(2,"0")}</span></div>
        <p className="events-subtitle">{category === "all" ? "不同地方，同一段时间" : `${category}主题 · 当前时期`}<span>演示</span></p>
        <div className="event-list">{events.map((event, index) => <button key={event.id} className="event-row" onClick={() => selectEvent(event)} style={{"--event-color": event.color} as React.CSSProperties}>
          <span className="event-row-meta"><span><i/>{event.region} <span className="location-separator">/</span> {event.location}</span><ArrowDownRight size={15}/></span><span className="event-row-title">{event.title}</span><span className="event-row-bottom"><span>{event.category}</span><span>场景 {String(index+1).padStart(2,"0")}</span></span>
        </button>)}</div>
        <div className="events-footer"><Compass size={16}/><span>点击事件，转向它发生的地方</span></div>
      </aside>
    </section>

    <section className="timeline-panel" aria-label="历史时间轴">
      <div className="timeline-top"><div className="timeline-title"><span className="eyebrow">穿梭时间</span><span className="timeline-date">{yearLabel(parts.year)} <span>{parts.month}月{parts.day}日</span></span></div><div className="timeline-scale"><span>时间尺度</span><ToggleGroup type="single" value={scale} onValueChange={chooseScale} aria-label="时间轴尺度">{SCALES.map(s => <ToggleGroupItem key={s.id} value={s.id} aria-label={`${s.label}尺度`}>{s.label}</ToggleGroupItem>)}</ToggleGroup></div><button className="date-jump" aria-label="跳转日期" onClick={() => {setDateOpen(true); setDateError("");}}><CalendarDays size={15}/><span>跳转日期</span></button></div>
      <div className="timeline-main"><button className="play-button" aria-label={playing ? "暂停时间播放" : "播放时间"} onClick={togglePlay}>{playing ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button><div className="timeline-track">
        <div className="era-bands" aria-hidden="true">{PERIODS.map((p, i) => { const start = Math.max(range[0], timestamp(p.start)); const end = Math.min(range[1], timestamp(p.end,12,31)); if (end<=start) return null; const w = (end-start)/(range[1]-range[0])*100; return <span key={p.name} className={i === periodIndex ? "current" : ""} style={{left:`${(start-range[0])/(range[1]-range[0])*100}%`,width:`${w}%`}}>{w>9 ? p.name : ""}</span>;})}</div>
        <div className="ruler" aria-hidden="true">{Array.from({length:101}, (_,i) => <i key={i} className={i%10===0 ? "major" : i%5===0 ? "middle" : ""}/>)}</div>
        <div className="time-cursor" style={{left:`${percent}%`}} aria-hidden="true"><span>{tickLabel(time, scale)}</span></div>
        <Slider className="time-slider" min={range[0]} max={range[1]} step={DAY} value={[time]} aria-label="历史日期" onValueChange={v => {setPlaying(false);changeTime(v[0]);}}/>
        <div className="ruler-labels" aria-hidden="true">{ticks.map((t,i) => <span key={i} style={{left:`${(t-range[0])/(range[1]-range[0])*100}%`,transform:i === 0 ? "none" : i === ticks.length-1 ? "translateX(-100%)" : "translateX(-50%)"}}>{tickLabel(t, scale)}</span>)}</div>
      </div><div className="timeline-step"><button className="icon-button" aria-label="向前移动时间轴" disabled={time<=MIN_TIME} onClick={() => panTimeline(-1)}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="向后移动时间轴" disabled={time>=MAX_TIME} onClick={() => panTimeline(1)}><ChevronRight size={18}/></button></div></div>
      <div className="timeline-footer"><span><span className={`status-dot ${playing ? "playing" : ""}`}/>{playing ? "时间正在流动" : "拖动刻度，探索同一时刻的世界"}</span><button className="speed-button" onClick={() => setSpeed(s => s === 1 ? 2 : s === 2 ? 5 : 1)} aria-label={`播放速度 ${speed} 倍，点击切换`}>播放速度 <strong>{speed}×</strong></button><span className="timeline-range">公元前 500 年 <ArrowRight size={12}/> 公元 2025 年</span></div>
    </section>

    <Sheet open={!!selected} onOpenChange={open => {if (!open) setSelected(null);}}>
      <SheetContent className="event-sheet" showCloseButton={false}>
        <div className="sheet-top"><span className="eyebrow">A MOMENT IN THE WORLD</span><SheetClose className="icon-button" aria-label="关闭事件详情"><X size={20}/></SheetClose></div>
        {selected && <><SheetHeader><span className="sheet-category" style={{color:selected.event.color}}>{selected.event.category} / {selected.event.region}</span><SheetTitle>{selected.event.title}</SheetTitle><SheetDescription><MapPin size={15}/>{selected.event.location} · {yearLabel(dateParts(selected.time).year)}</SheetDescription></SheetHeader><div className="sheet-content"><div className="demo-callout"><Sparkles size={17}/><div><strong>交互演示场景</strong><p>此内容用于预览产品体验，不作为历史事实。</p></div></div><h3>这一刻，在这里</h3><p>{selected.event.summary}</p><dl><div><dt>演示时间范围</dt><dd>{yearLabel(selected.event.start)} — {yearLabel(selected.event.end)}</dd></div><div><dt>地理位置</dt><dd>{Math.abs(selected.event.lat).toFixed(2)}° {selected.event.lat>=0?"N":"S"} · {Math.abs(selected.event.lng).toFixed(2)}° {selected.event.lng>=0?"E":"W"}</dd></div><div><dt>资料来源</dt><dd>演示内容 · 历史资料待补充</dd></div></dl><button className="primary-button" onClick={() => {sendCommand("focus",selected.event.lat,selected.event.lng);setSelected(null);}}><Compass size={17}/>在地球上查看<ArrowRight size={17}/></button></div><div className="sheet-footnote">详情已固定。地球继续缓慢转动，阅读不受影响。</div></>}
      </SheetContent>
    </Sheet>

    <Dialog open={dateOpen} onOpenChange={setDateOpen}><DialogContent className="atlas-dialog"><DialogHeader><DialogTitle>去往历史中的某一天</DialogTitle><DialogDescription>支持公元前 500 年至公元 2025 年。负数表示公元前，没有公元 0 年。</DialogDescription></DialogHeader><form onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget); const year = Number(form.get("year")), month = Number(form.get("month")), day = Number(form.get("day"));
      const t = timestamp(year,month,day); const checked = dateParts(t);
      if (!Number.isInteger(year) || year === 0 || year < -500 || year > 2025 || checked.year !== year || checked.month !== month || checked.day !== day) {setDateError("请输入范围内的有效日期，例如 1450 年 6 月 15 日。");return;}
      setPlaying(false);changeTime(t);setRange(rangeAt(t,scale));setDateOpen(false);
    }}><div className="date-fields"><label>年份<input name="year" type="number" required min="-500" max="2025" defaultValue={parts.year} aria-describedby={dateError ? "date-error" : undefined}/></label><label>月<input name="month" type="number" required min="1" max="12" defaultValue={parts.month}/></label><label>日<input name="day" type="number" required min="1" max="31" defaultValue={parts.day}/></label></div>{dateError && <p id="date-error" className="form-error" role="alert">{dateError}</p>}<button className="primary-button" type="submit">前往这个时刻<ArrowRight size={17}/></button></form></DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent className="atlas-dialog help-dialog"><DialogHeader><DialogTitle>世界，尽在指间</DialogTitle><DialogDescription>从一次轻轻的拨动开始。</DialogDescription></DialogHeader><div className="help-rows"><div><Hand/><p><strong>拨动地球</strong><span>按住拖动改变方向与速度，松手后惯性旋转。悬停不会打断自转。</span></p></div><div><Scan/><p><strong>靠近一个地方</strong><span>滚轮或加减按钮缩放；悬停区域预览事件，点击固定详情。</span></p></div><div><CalendarDays/><p><strong>穿梭不同时间</strong><span>拖动时间轴，切换尺度，或直接输入日期。播放按钮让时间自动前进。</span></p></div></div><p className="help-keyboard">键盘：聚焦地球后用方向键旋转、加减键缩放；聚焦时间轴后用方向键逐日调整。</p><p className="data-disclosure">当前为交互原型，事件均为演示场景。地图采用 Natural Earth 现代地理轮廓，仅作定位参照。历史事件、资料来源与历史疆域将在后续补充。</p></DialogContent></Dialog>
  </main>;
}
