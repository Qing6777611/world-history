"use client";

import { useState } from "react";
import { Info, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import coverage from "../data/history/coverage.json";

type Props = {
  locale: "zh" | "en";
  mode: "historical" | "modern";
  today: boolean;
  year: number;
  status: "loading" | "ready" | "unavailable" | "error";
  count: number;
  regionNotice: boolean;
  onModeChange: (mode: "historical" | "modern") => void;
  onRetry: () => void;
  onCoveredYear: () => void;
};

export function HistoricalMapControls({ locale, mode, today, year, status, count, regionNotice, onModeChange, onRetry, onCoveredYear }: Props) {
  const [infoOpen, setInfoOpen] = useState(false);
  const zh = locale === "zh";
  const yearText = (value: number) => zh ? `${value < 0 ? "公元前" : "公元"} ${Math.abs(value)} 年` : `${Math.abs(value)} ${value < 0 ? "BCE" : "CE"}`;
  const nearestYear = year < coverage.minYear ? coverage.minYear : coverage.maxYear;
  const note = mode === "modern" ? today ? zh ? "跨年代事件 · 点击事件查看当时疆域" : "Events across time · open one to see its historical map"
    : zh ? "现代国界 · 可与当时疆域对照" : "Present-day borders · compare with the historical map"
    : status === "loading" ? zh ? "正在读取当时的疆域…" : "Loading historical territories…"
    : status === "error" ? zh ? "疆域资料暂未加载" : "Territories could not be loaded"
    : status === "unavailable" ? zh ? "这一年代暂无疆域资料" : "No territory data for this year"
    : zh ? `${yearText(year)} · ${count} 个政权 · 疆域重建` : `${yearText(year)} · ${count} polities · reconstructed`;

  return <>
    <aside className="historical-map-controls" aria-label={zh ? "地图显示方式" : "Map display"}>
      <div className="map-mode-row">
        <div className="map-mode-switch" role="group" aria-label={zh ? "疆域模式" : "Territory mode"}>
          <button type="button" aria-pressed={mode === "historical"} onClick={() => onModeChange("historical")}>{zh ? "历史疆域" : "Historical"}</button>
          <button type="button" aria-pressed={mode === "modern"} onClick={() => onModeChange("modern")}>{zh ? "现代国界" : "Modern"}</button>
        </div>
        <button type="button" className="map-source-button" onClick={() => setInfoOpen(true)} aria-label={zh ? "疆域来源与覆盖范围" : "Territory sources and coverage"}><Info size={18} aria-hidden="true" /></button>
      </div>
      <p className="historical-map-status" role="status" aria-live="polite">
        {mode === "historical" && status === "loading" && <LoaderCircle size={14} className="loading-icon" aria-hidden="true" />}
        <span>{note}</span>
      </p>
      {mode === "historical" && status === "error" && <button type="button" className="map-data-action" onClick={onRetry}>{zh ? "重试加载疆域" : "Retry territories"}</button>}
      {mode === "historical" && status === "unavailable" && <button type="button" className="map-data-action" onClick={onCoveredYear}>{zh ? `查看${yearText(nearestYear)}疆域` : `View territories in ${yearText(nearestYear)}`}</button>}
      {mode === "historical" && regionNotice && <p className="historical-region-notice" role="status">{zh ? "该政权在这一年未收录，已返回全球范围。" : "This polity is not recorded in this year. Showing the world."}</p>}
    </aside>
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}><DialogContent className="atlas-dialog map-source-dialog"><DialogHeader>
      <DialogTitle>{zh ? "疆域资料" : "About the territories"}</DialogTitle>
      <DialogDescription>{yearText(coverage.minYear)} — {yearText(coverage.maxYear)}</DialogDescription>
    </DialogHeader>
      <p>{zh ? "历史疆域来自 Cliopatria。按资料记载的有效年份切换；同一年内不细分到月或日。古代疆域为历史重建，不同地区与年代的精度不一。" : "Historical territories come from Cliopatria and change over the recorded year ranges. The data does not resolve changes within a year. These are historical reconstructions, with varying precision across regions and periods."}</p>
      <p>{zh ? "部分政权沿用来源中的旧称，个别年代记录也存在争议。中文名称用于阅读，不表示相关疆域和年代已逐条考证；可通过原始来源核对。" : "Some records retain older polity names, and individual dates may be disputed. Chinese names aid reading; they do not imply that every territory and date has been independently verified. Consult the original source for comparison."}</p>
      <p>{zh ? "未着色的陆地表示这一年没有收录政权疆域，不代表无人居住。海岸线沿用现代底图；历史模式不显示现代省州和城市标签。" : "Uncoloured land means no polity territory is recorded for that year, not that the land was uninhabited. Coastlines use the modern basemap; modern provinces and city labels are hidden in historical mode."}</p>
      <p>{zh ? "事件按发生当年的关联地点匹配疆域；重叠疆域可关联多个政权。没有可靠坐标的事件仍可在全球列表阅读。" : "Events are matched by their recorded location and year. Overlapping territories can link an event to multiple polities. Events without reliable coordinates remain available in the world list."}</p>
      <p className="source-note"><a href="https://github.com/Seshat-Global-History-Databank/cliopatria" target="_blank" rel="noreferrer">Cliopatria · Seshat Global History Databank ↗</a><br />
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>{zh ? " · 已简化几何并补充中文名称，完整来源与处理说明" : " · Geometry simplified and Chinese names added. Full attribution and processing notes"} <a href="/data/history/ATTRIBUTION.md" target="_blank" rel="noreferrer">↗</a>
      </p>
    </DialogContent></Dialog>
  </>;
}
