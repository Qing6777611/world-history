"use client";

/* Visual direction: one large globe, one quiet line of time.
 * Keep geography and date immediately available; reveal all details on interaction.
 * Pointer travel spans the complete timeline; keyboard travel uses calendar units.
 * Content may expand to a coarser scope when the selected date has no records.
 */
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, History, Pencil, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import GlobeView, { type GlobeCommand, type HoverInfo } from "./globe-view";
import { countryRegion, type CountryFeature, type CountryRegion } from "./country-geometry";
import { DAY, getMaxTime, MIN_TIME, MIN_YEAR, dateParts, timestamp, yearLabel, localToday, hasCoordinates, type AtlasEvent } from "./atlas-model";
import { TIER_LABEL, eventsForRegion, loadEventScope, resolveScope, toAtlasEvents, type EventQuery, type EventScopeData, type Locale, type ResolvedScope, type StoredEvent, type Tier } from "./events-db";
import { shiftCalendarTime, timelineTime, unitForYear } from "./timeline-model";
import { useLatest } from "@/hooks/use-latest";
import { useHistoricalGeography } from "@/hooks/use-historical-geography";
import { historicalEventsForRegion, historicalPolityName, mapHistoricalEvents } from "./historical-geography";
import { HistoricalMapControls } from "./historical-map-controls";
import historicalCoverage from "../data/history/coverage.json";

/* Dragging resolves itself: the further back you go, the coarser the step.
 * Recent history moves by day, the early modern period by month, and anything
 * before 1000 by year. There is no separate zoom control to learn. */
const edgeLabel = (value: number, unit: Tier) => {
  const { year, month, day } = dateParts(value);
  if (unit === "decade") return year < 0 ? `公元前 ${Math.abs(year)} 年` : `${year} 年`;
  if (unit === "year") return yearLabel(year);
  if (unit === "month") return `${yearLabel(year)} ${month} 月`;
  return `${yearLabel(year)} ${month} 月 ${day} 日`;
};

const EMPTY_DATA: EventScopeData = { day: [], year: [], decade: [] };
const EMPTY_FEATURES: CountryFeature[] = [];
type DataState = { key: string; status: "loading" | "ready" | "error"; rows: EventScopeData };

export default function HistoryAtlas({ initialToday }: { initialToday: number }) {
  const [today, setToday] = useState(initialToday);
  const todayRef = useRef(initialToday);
  const [maxYear, setMaxYear] = useState(dateParts(initialToday).year);
  const maxTime = getMaxTime(maxYear);
  const [time, setTime] = useState(initialToday);
  const [viewMode, setViewMode] = useState<"today" | "timeline">("today");
  const [mapMode, setMapMode] = useState<"historical" | "modern">("historical");
  const [geographyAttempt, setGeographyAttempt] = useState(0);
  const [regionNotice, setRegionNotice] = useState(false);
  const [spinning, setSpinning] = useState(true);
  const [region, setRegion] = useState<CountryRegion | null>(null);
  const [regionSpinning, setRegionSpinning] = useState(false);
  const [countries, setCountries] = useState<CountryRegion[]>([]);
  const [selected, setSelected] = useState<{ event: AtlasEvent; record?: StoredEvent; time: number } | null>(null);
  const [data, setData] = useState<DataState>({ key: "", status: "loading", rows: EMPTY_DATA });
  const [locale, setLocale] = useState<Locale>("zh");
  const [dataAttempt, setDataAttempt] = useState(0);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [command, setCommand] = useState<GlobeCommand | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateError, setDateError] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [restored, setRestored] = useState(false);
  const timeRef = useLatest(time);
  const globeArea = useRef<HTMLDivElement>(null);

  const parts = dateParts(time);
  const isToday = viewMode === "today";
  const historicalMode = mapMode === "historical" && !isToday;
  const geography = useHistoricalGeography(parts.year, historicalMode, geographyAttempt);
  const historyManifest = geography.snapshot?.manifest ?? null;
  const historicalFeatures = geography.status === "ready" ? geography.snapshot!.features : EMPTY_FEATURES;
  const historicalMap = useMemo(() => historicalMode ? { year: parts.year, status: geography.status, features: historicalFeatures } : null,
    [historicalMode, parts.year, geography.status, historicalFeatures]);
  const todayParts = dateParts(today);
  const unit = unitForYear(parts.year);
  const includeDecade = !!region;
  const query = useMemo<EventQuery>(() => isToday
    ? { mode: "today", month: todayParts.month, day: todayParts.day }
    : { mode: "timeline", year: parts.year, includeDecade }, [isToday, todayParts.month, todayParts.day, parts.year, includeDecade]);
  const dataKey = query.mode === "today" ? `day-${query.month}-${query.day}` : `year-${query.year}${includeDecade ? "-regional" : ""}`;
  // Hide previous results immediately when the requested scope changes, before effects run.
  const eventDataStatus = data.key === dataKey ? data.status : "loading";
  const dataStatus = historicalMode && (geography.status === "loading" || geography.status === "error") ? geography.status : eventDataStatus;
  const rows = data.key === dataKey && data.status === "ready" ? data.rows : EMPTY_DATA;

  // ---- data -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the active request and discards its previous result on retry.
    setData({ key: dataKey, status: "loading", rows: EMPTY_DATA });
    setHover(null);
    loadEventScope(query).then(result => {
      if (!cancelled) setData({ key: dataKey, status: "ready", rows: result });
    }).catch(() => {
      if (!cancelled) setData({ key: dataKey, status: "error", rows: EMPTY_DATA });
    });
    return () => { cancelled = true; };
  }, [query, dataKey, dataAttempt]);

  const todayEvents = useMemo(
    () => toAtlasEvents(rows.day, locale).filter((event) => event.historical!.year! < todayParts.year),
    [rows.day, locale, todayParts.year],
  );
  const yearEvents = useMemo(() => {
    const events = toAtlasEvents(rows.year, locale);
    return historicalMode ? historyManifest ? mapHistoricalEvents(events, geography.eventIndex, historyManifest, locale) : [] : events;
  }, [rows.year, locale, historicalMode, historyManifest, geography.eventIndex]);
  const decadeEvents = useMemo(() => {
    const events = toAtlasEvents(rows.decade, locale);
    return historicalMode ? historyManifest ? mapHistoricalEvents(events, geography.eventIndex, historyManifest, locale) : [] : events;
  }, [rows.decade, locale, historicalMode, historyManifest, geography.eventIndex]);
  // Retain an entity across dates only while that entity exists in the new map.
  // Localize the selection from the active geometry rather than storing its name.
  const activeRegion = useMemo(() => {
    if (!region) return null;
    if (historicalMode) {
      const feature = historicalFeatures.find(item => item.properties.HISTORY_ID === region.code);
      return feature ? countryRegion(feature, locale) : null;
    }
    return countries.find(item => item.code === region.code) ?? region;
  }, [region, historicalMode, historicalFeatures, locale, countries]);
  const regionRef = useLatest(activeRegion);
  useEffect(() => {
    if (!historicalMode || !region || (geography.status !== "ready" && geography.status !== "unavailable")) return;
    if (!historicalFeatures.some(item => item.properties.HISTORY_ID === region.code)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a removed polity cannot remain an invisible filter.
      setRegion(null);
      setRegionNotice(true);
      setHover(null);
    }
  }, [historicalMode, geography.status, historicalFeatures, region]);

  // ---- scope: day -> month -> year -> decade -----------------------------
  const scope: ResolvedScope = useMemo(() => {
    if (isToday) return { tier: "day", events: todayEvents ?? [], tried: [] };
    return resolveScope(unit, { year: parts.year, month: parts.month, day: parts.day }, {
      year: yearEvents,
      decade: decadeEvents,
    });
  }, [isToday, todayEvents, unit, parts.year, parts.month, parts.day, yearEvents, decadeEvents]);

  const regionalScope = useMemo(() => {
    if (!activeRegion || isToday) return scope;
    const filter = historicalMode ? historicalEventsForRegion : eventsForRegion;
    return resolveScope(unit, { year: parts.year, month: parts.month, day: parts.day }, {
      year: filter(yearEvents, activeRegion.code), decade: filter(decadeEvents, activeRegion.code),
    });
  }, [activeRegion, isToday, scope, historicalMode, unit, parts.year, parts.month, parts.day, yearEvents, decadeEvents]);
  const visibleScope = activeRegion && !isToday ? regionalScope : scope;
  // With a region selected, the map and list use the same time expansion.
  const events = activeRegion && !isToday ? regionalScope.events : scope.events;
  const visibleEvents = useMemo(() => historicalMode ? historicalEventsForRegion(events, activeRegion?.code ?? null) : eventsForRegion(events, activeRegion?.code ?? null), [events, activeRegion, historicalMode]);
  const selectedEvent = useMemo(() => {
    if (!selected) return null;
    const loaded = [...todayEvents, ...yearEvents, ...decadeEvents].find(event => event.id === selected.event.id);
    if (loaded) return loaded;
    const fallback = selected.record ? toAtlasEvents([selected.record], locale)[0] : selected.event;
    return historicalMode && historyManifest ? mapHistoricalEvents([fallback], geography.eventIndex, historyManifest, locale)[0] : fallback;
  }, [selected, todayEvents, yearEvents, decadeEvents, locale, historicalMode, historyManifest, geography.eventIndex]);
  const eventsRef = useLatest(visibleEvents);
  const statusRef = useLatest(dataStatus);
  const hasRegionEvents = visibleEvents.some(hasCoordinates);

  // ---- camera + timeline ------------------------------------------------
  const sendCommand = useCallback((action: GlobeCommand["action"], lat?: number, lng?: number) => setCommand({ id: performance.now(), action, lat, lng }), []);
  const selectRegion = useCallback((next: CountryRegion) => { setRegion(next); setRegionNotice(false); setRegionSpinning(false); setHover(null); }, []);
  const returnToWorld = useCallback(() => { setRegion(null); setRegionNotice(false); setHover(null); sendCommand("reset"); }, [sendCommand]);

  const changeTime = useCallback((value: number) => {
    setTime(timelineTime(value, maxYear));
    setViewMode("timeline");
    setRegionNotice(false);
    setHover(null);
    setSelected(null);
  }, [maxYear]);

  const selectEvent = useCallback((event: AtlasEvent) => {
    if (event.historical && (isToday || historicalMode && event.historical.year !== parts.year)) {
      setTime(timestamp(event.historical.year, event.historical.month, event.historical.day));
      setViewMode("timeline");
      setMapMode("historical");
      setRegion(null);
    }
    const record = [...rows.day, ...rows.year, ...rows.decade].find(row => row.id === event.id);
    setSelected({ event, record, time: timeRef.current });
    setHover(null);
    setCommand({ id: performance.now(), action: "focus", code: event.country === "TWN" ? "CHN" : event.country, lat: event.lat, lng: event.lng });
  }, [timeRef, isToday, historicalMode, parts.year, rows]);

  // Events without a recorded place still deserve a readable detail view.
  const openFromList = useCallback((event: AtlasEvent) => {
    setListOpen(false);
    selectEvent(event);
  }, [selectEvent]);

  useEffect(() => {
    const refresh = () => {
      const next = localToday(), previous = todayRef.current;
      todayRef.current = next;
      setToday(next);
      setMaxYear(dateParts(next).year);
      if (next !== previous) { setSelected(null); setHover(null); }
      setTime((current) => (current === previous ? next : current));
    };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const saved = (() => { try { return localStorage.getItem("atlas-locale"); } catch { return null; } })();
    // The interface itself is Chinese, so default to Chinese unless the visitor
    // explicitly picked English before.
    const next: Locale = saved === "en" ? "en" : "zh";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only preference, read once after mount.
    setLocale(next);
  }, []);

  useEffect(() => {
    try { localStorage.setItem("atlas-locale", locale); } catch { /* Storage is optional. */ }
  }, [locale]);

  useEffect(() => {
    let stored: boolean | null = null;
    try {
      const saved = JSON.parse(localStorage.getItem("world-atlas-state") || "null");
      if (saved && typeof saved.spinning === "boolean") stored = saved.spinning;
    } catch { /* Storage is optional. */ }
    const next = stored ?? !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only preference, read once after mount.
    setSpinning(next);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const timeout = setTimeout(() => { try { localStorage.setItem("world-atlas-state", JSON.stringify({ spinning })); } catch { /* Ignore quota errors. */ } }, 250);
    return () => clearTimeout(timeout);
  }, [spinning, restored]);

  useEffect(() => {
    const node = globeArea.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setArea({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const goToday = () => {
    const next = localToday();
    todayRef.current = next;
    setToday(next);
    setMaxYear(dateParts(next).year);
    setTime(next);
    setViewMode("today");
    setSelected(null);
    returnToWorld();
    setDateOpen(false);
  };

  const closeDetails = () => { setSelected(null); if (!activeRegion) sendCommand("reset"); };

  useEffect(() => {
    const thumb = document.querySelector('.time-slider [role="slider"]');
    thumb?.setAttribute("aria-label", "历史日期");
    thumb?.setAttribute("aria-valuetext", edgeLabel(time, unit));
  }, [time, unit]);

  useEffect(() => {
    if (!region || selected || dateOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") sendCommand("back"); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [region, selected, dateOpen, sendCommand]);

  useEffect(() => {
    const context = (document as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: unknown) => { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => { /* The host may refuse tools. */ }); } catch { /* Optional API. */ } };
    register({ name: "read_atlas_state", description: "Read the visible date, scope and events from the offline historical dataset. The tier reports whether the selected day, month, year or decade is being shown.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute() { return { date: dateParts(timeRef.current), granularity: unit, tier: visibleScope.tier, status: statusRef.current, mapMode: historicalMode ? "historical" : "modern", region: regionRef.current, events: eventsRef.current.map((event) => ({ id: event.id, title: event.title, location: event.location, date: event.historical, mapped: hasCoordinates(event), polities: event.polityIds })) }; } });
    register({ name: "navigate_history_date", description: `Change the visible globe and timeline to a date. Negative years mean BCE; no year zero. Supports ${MIN_YEAR} through ${maxYear}. Before 1900 dates snap to months, before 1000 to years.`, inputSchema: { type: "object", properties: { year: { type: "integer", minimum: MIN_YEAR, maximum: maxYear }, month: { type: "integer", minimum: 1, maximum: 12 }, day: { type: "integer", minimum: 1, maximum: 31 } }, required: ["year", "month", "day"], additionalProperties: false }, annotations: { readOnlyHint: false }, execute(input: { year: number; month: number; day: number }) { const { year, month, day } = input; if (![year, month, day].every(Number.isInteger) || year === 0 || year < MIN_YEAR || year > maxYear) throw new Error("Invalid historical date"); const value = timestamp(year, month, day), checked = dateParts(value); if (checked.year !== year || checked.month !== month || checked.day !== day) throw new Error("Invalid calendar date"); flushSync(() => changeTime(value)); return { date: dateParts(timelineTime(value, maxYear)), granularity: unitForYear(year) }; } });
    return () => lifecycle.abort();
  }, [changeTime, maxYear, visibleScope.tier, historicalMode, unit, eventsRef, regionRef, statusRef, timeRef]);

  const domainMin = MIN_TIME;
  const domainMax = maxTime;
  const sliderMax = Math.round((domainMax - domainMin) / DAY);
  const sliderValue = Math.round((Math.max(domainMin, Math.min(domainMax, time)) - domainMin) / DAY);
  const ticks = [0.2, 0.4, 0.6, 0.8].map((ratio) => domainMin + (domainMax - domainMin) * ratio);
  const percent = sliderValue / sliderMax * 100;

  // Coarse views state their precision instead of inventing a day.
  const renderDate = () => {
    if (isToday || unit === "day") return <>
      {parts.year < 0 && <span>公元前 </span>}{Math.abs(parts.year)}<span> 年 </span>{String(parts.month).padStart(2, "0")}<span> 月 </span>{String(parts.day).padStart(2, "0")}<span> 日</span>
    </>;
    if (unit === "month") return <>{parts.year < 0 && <span>公元前 </span>}{Math.abs(parts.year)}<span> 年 </span>{String(parts.month).padStart(2, "0")}<span> 月</span></>;
    if (unit === "year") return <>{parts.year < 0 && <span>公元前 </span>}{Math.abs(parts.year)}<span> 年</span></>;
    if (parts.year < 0) return <><span>公元前 </span>{Math.ceil(Math.abs(parts.year) / 100)}<span> 世纪</span></>;
    return <>{Math.abs(parts.year) - (Math.abs(parts.year) % 10)}<span> 年代</span></>;
  };

  const selectedCountry = selectedEvent?.country ? historicalMode && historyManifest
    ? historicalPolityName(selectedEvent.country, historyManifest, locale)
    : countries.find((country) => country.code === selectedEvent.country)?.name : undefined;

  const changeMapMode = (mode: "historical" | "modern") => {
    setMapMode(mode);
    setSelected(null);
    returnToWorld();
    if (mode === "historical" && isToday) {
      changeTime(timestamp(historicalCoverage.maxYear, todayParts.month, todayParts.day));
    }
  };
  const retryData = () => { setDataAttempt(value => value + 1); setGeographyAttempt(value => value + 1); };

  const scopeTitle = !visibleScope.tier ? ""
    : visibleScope.tier === "day" ? `${yearLabel(parts.year)} ${parts.month} 月 ${parts.day} 日`
    : visibleScope.tier === "month" ? `${yearLabel(parts.year)} ${parts.month} 月`
    : visibleScope.tier === "year" ? yearLabel(parts.year)
    : `${yearLabel(Math.floor(parts.year / 10) * 10 || 1)}至${yearLabel(Math.floor(parts.year / 10) * 10 + 9)}`;
  const degraded = !isToday && visibleScope.tier !== null && visibleScope.tier !== unit;
  const listTitle = `${activeRegion?.name || "全球"} · ${isToday ? "历史上的今天" : visibleScope.tier ? scopeTitle : "事件列表"}`;

  return <main className="atlas-app" data-history-controls="true" lang={locale === "zh" ? "zh-Hans" : "en"}>
    <h1 className="sr-only">纪元 · 世界历史地图</h1>
    <HistoricalMapControls locale={locale} mode={historicalMode ? "historical" : "modern"} today={isToday} year={parts.year} status={geography.status}
      count={historicalFeatures.length} regionNotice={regionNotice} onModeChange={changeMapMode} onRetry={() => setGeographyAttempt(value => value + 1)}
      onCoveredYear={() => changeTime(timestamp(parts.year < historicalCoverage.minYear ? historicalCoverage.minYear : historicalCoverage.maxYear))} />
    <button className="locale-toggle" onClick={() => setLocale(locale === "zh" ? "en" : "zh")} aria-label={locale === "zh" ? "切换到英文" : "切换到中文"}>{locale === "zh" ? "中" : "EN"}</button>
    <section className="globe-area" ref={globeArea} aria-label="世界历史探索">
      <div className="keyboard-region-picker"><NativeSelect aria-label={locale === "zh" ? historicalMode ? "选择历史政权" : "选择国家或地区" : historicalMode ? "Choose a historical polity" : "Choose a country or region"} disabled={!countries.length} value={activeRegion?.code || ""} onChange={(e) => e.target.value ? setCommand({ id: performance.now(), action: "country", code: e.target.value }) : returnToWorld()}><NativeSelectOption value="">{locale === "zh" ? "全球视图" : "World view"}</NativeSelectOption>{countries.map((country) => <NativeSelectOption key={country.code} value={country.code}>{country.name}</NativeSelectOption>)}</NativeSelect></div>
      <GlobeView locale={locale} historicalGeography={historicalMap} events={events} selectedEvent={selectedEvent} spinning={!selected && (activeRegion ? regionSpinning : spinning)} command={command} selectedCountry={activeRegion?.code || null} onRegionSelect={selectRegion} onCountriesReady={setCountries} onSelect={(items) => { if (items[0]) selectEvent(items[0]); }} onHover={setHover} onReset={returnToWorld} onToggleSpin={() => activeRegion ? setRegionSpinning((value) => !value) : setSpinning((value) => !value)} />
      {hover && !selected && <div className="map-tooltip" role="status" style={{ left: Math.max(12, Math.min(hover.x + 16, (area.width || 700) - 180)), top: Math.max(12, Math.min(hover.y + 16, (area.height || 600) - 52)) }}><strong>{hover.name}</strong><small>{hover.hint || "点击放大"}</small></div>}
    </section>

    <section className="timeline" aria-label="历史时间轴">
      {dataStatus === "ready" ? (!hasRegionEvents ? <div className="map-history-status" role="status">{activeRegion ? `${activeRegion.name} · ${visibleScope.tier ? "这一范围内没有已定位的事件" : "暂无已定位的事件"}` : visibleScope.tier ? `${scopeTitle} · 没有已定位的事件` : `${({day:"这一天",month:"这个月",year:"这一年",decade:"这一时期"} as Record<string,string>)[unit]}在当前数据集中暂无收录`}</div> : null)
        : dataStatus === "error" ? <div className="map-history-status" role="status"><button onClick={retryData}>历史资料暂未加载 · 重试</button></div>
        : <div className="map-history-status" role="status">正在读取历史资料…</div>}
      {(!isToday || (degraded && visibleScope.tier)) && <div className="day-context">
        {!isToday && <button onClick={goToday}>回到今天</button>}
        {degraded && visibleScope.tier && <span className="scope-note">该{TIER_LABEL[unit].slice(1)}未收录 · 显示{TIER_LABEL[visibleScope.tier].slice(1)}</span>}
      </div>}
      <button className="current-year" onClick={() => { setDateOpen(true); setDateError(""); }} aria-label={`当前${isToday ? `${yearLabel(parts.year)} ${parts.month}月${parts.day}日` : edgeLabel(time, unit)}，点击修改日期`} title="点击修改日期">{renderDate()}<Pencil className="date-edit-icon" size={15} aria-hidden="true" /></button>
      <div className="timeline-line">
        <div className="timeline-track">
          <Slider className="time-slider" min={0} max={sliderMax} step={1} value={[sliderValue]} aria-label="历史日期" onValueChange={(value) => changeTime(domainMin + value[0] * DAY)} onKeyDownCapture={event => {
            const direction = ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key) ? -1 : 0;
            if (!direction && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            event.stopPropagation();
            const amount = direction * (event.shiftKey || event.key.startsWith("Page") ? 10 : 1);
            changeTime(event.key === "Home" ? domainMin : event.key === "End" ? domainMax : shiftCalendarTime(time, unit, amount, maxYear));
          }} />
          <div className="timeline-ticks" aria-hidden="true">{ticks.map((tick) => <i key={tick} style={{ left: `${(tick - domainMin) / (domainMax - domainMin) * 100}%` }} />)}</div>
        </div>
      </div>
      <div className="timeline-ends"><span>{edgeLabel(domainMin, "year")}</span><button className="event-list-toggle" onClick={() => setListOpen(true)} disabled={dataStatus !== "ready"} aria-haspopup="dialog" aria-label={`查看${listTitle}，共 ${visibleEvents.length} 条`}><History size={15} aria-hidden="true" /><span className="event-list-toggle-label" aria-hidden="true">{isToday ? "历史上的今天" : "事件列表"}</span><b>{dataStatus === "ready" ? visibleEvents.length : "…"}</b></button><span>{edgeLabel(domainMax, "year")}</span></div>
      <span className="sr-only">当前进度 {Math.round(percent)}%。方向键按当前粒度调整，点击日期可输入准确日期。</span>
    </section>

    <Sheet open={!!selected} onOpenChange={(open) => { if (!open) closeDetails(); }}><SheetContent className="event-sheet" showCloseButton={false} onCloseAutoFocus={(event) => { event.preventDefault(); const target = document.querySelector<HTMLElement>(".globe-canvas"); target?.focus({ preventScroll: true }); }}>
      <div className="sheet-top"><span>历史事件</span><SheetClose className="icon-button" aria-label="关闭事件详情"><X size={20} /></SheetClose></div>
      {selectedEvent && <><SheetHeader><SheetTitle>{selectedEvent.title}</SheetTitle><SheetDescription>{selectedEvent.historical ? `${yearLabel(selectedEvent.historical.year)} ${selectedEvent.historical.month} 月 ${selectedEvent.historical.day} 日` : selectedEvent.location}{selectedCountry ? ` · ${selectedCountry}` : ""}</SheetDescription></SheetHeader><div className="sheet-content">
        {selectedEvent.summary && <p className="event-summary">{selectedEvent.summary}{selectedEvent.textLocale === "en" ? <span className="original-tag">英文原文</span> : selectedEvent.summarySource === "mt" ? <span className="original-tag">机器翻译</span> : selectedEvent.summarySource === "manual" ? <span className="original-tag">人工译文</span> : null}</p>}
        {selectedEvent.textLocale === "zh" && selectedEvent.originalSummary && <details className="event-original"><summary>查看英文原文</summary><p lang="en">{selectedEvent.originalSummary}</p></details>}
        <p className="event-place">{hasCoordinates(selectedEvent) ? `关联地点：${selectedEvent.location} · ${selectedEvent.lat!.toFixed(2)}°, ${selectedEvent.lng!.toFixed(2)}°` : "此条事件尚无可靠坐标，未标注具体地点。"}</p>
        {historicalMode && historyManifest && !!selectedEvent.polityIds?.length && <p className="event-place">{locale === "zh" ? "当时的关联疆域：" : "Historical territories at the event date: "}{selectedEvent.polityIds.map(id => historicalPolityName(id, historyManifest, locale)).join(locale === "zh" ? "、" : ", ")}</p>}
        <p className="source-note">{selectedEvent.historical?.sourceUrl && <a href={selectedEvent.historical.sourceUrl} target="_blank" rel="noreferrer">来源：英文维基百科 ↗</a>}{selectedEvent.historical?.sourceUrl && <><br /><a href="https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans" target="_blank" rel="noreferrer">CC BY-SA 4.0</a> · 来源文字整理</>}</p>
      </div></>}
    </SheetContent></Sheet>

    <Sheet open={listOpen} onOpenChange={setListOpen}><SheetContent className="event-list-sheet" showCloseButton={false}>
      <div className="sheet-top"><span>{isToday ? `${todayParts.month} 月 ${todayParts.day} 日` : scopeTitle || edgeLabel(time, unit)}</span><SheetClose className="icon-button" aria-label="关闭事件列表"><X size={20} /></SheetClose></div>
      <SheetHeader><SheetTitle>{listTitle}</SheetTitle><SheetDescription>{dataStatus === "loading" ? "正在读取历史资料…" : dataStatus === "error" ? "历史资料暂未加载，请关闭列表后重试。" : `当前${activeRegion ? `${activeRegion.name}范围` : "全球范围"}共 ${visibleEvents.length} 条，其中 ${visibleEvents.filter(hasCoordinates).length} 条可定位到地图。${degraded ? `所选${TIER_LABEL[unit].slice(1)}无记录，时间范围已扩展到${TIER_LABEL[visibleScope.tier!].slice(1)}。` : ""}`}</SheetDescription></SheetHeader>
      <ol className="event-list">{visibleEvents.map((event) => (
        <li key={event.id}><button onClick={() => openFromList(event)}>
          <span className="event-list-year">{event.historical!.year < 0 ? "前" : ""}{Math.abs(event.historical!.year)}</span>
          <span className="event-list-title">{event.title}</span>
          <span className="event-list-place" data-mapped={hasCoordinates(event) ? "true" : "false"}>{hasCoordinates(event) ? event.location : "地点待考证"}</span>
        </button></li>
      ))}</ol>
      {dataStatus === "ready" && !visibleEvents.length && <p className="source-note" role="status">{activeRegion ? "当前地区和时间范围内暂无收录。可返回全球查看其他地区的事件。" : "当前时间范围内暂无收录。可拖动时间轴、点击日期换个范围，或回到今天。"}</p>}
    </SheetContent></Sheet>

    <Dialog open={dateOpen} onOpenChange={setDateOpen}><DialogContent className="atlas-dialog"><DialogHeader><DialogTitle>选择日期</DialogTitle><DialogDescription>负数表示公元前，没有公元 0 年。1900 年前按月浏览，1000 年前按年浏览。</DialogDescription></DialogHeader><form onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget), year = Number(form.get("year")), month = Number(form.get("month")), day = Number(form.get("day"));
      const value = timestamp(year, month, day), checked = dateParts(value);
      if (!Number.isInteger(year) || year === 0 || year < MIN_YEAR || year > maxYear || checked.year !== year || checked.month !== month || checked.day !== day) { setDateError(`请输入${yearLabel(MIN_YEAR)}至${yearLabel(maxYear)}之间的有效日期。`); return; }
      changeTime(value);
      setDateOpen(false);
    }}><div className="date-fields"><label>年份<input name="year" type="number" required min={MIN_YEAR} max={maxYear} defaultValue={parts.year} aria-describedby={dateError ? "date-error" : undefined} /></label><label>月<input name="month" type="number" required min="1" max="12" defaultValue={parts.month} /></label><label>日<input name="day" type="number" required min="1" max="31" defaultValue={parts.day} /></label></div>{dateError && <p id="date-error" className="form-error" role="alert">{dateError}</p>}<button className="primary-button" type="submit">前往<ArrowRight size={16} /></button><button className="text-button today-button" type="button" onClick={goToday}>回到今天 · {todayParts.year}年{todayParts.month}月{todayParts.day}日</button></form></DialogContent></Dialog>
  </main>;
}
