"use client";

import { useState, type CSSProperties } from "react";
import { ChevronDown, Globe2, X } from "lucide-react";
import { yearLabel, type AtlasEvent } from "./demo-data";
import { notificationCopy } from "./notification-events";

type Props={events:AtlasEvent[]; region:string|null; dateLabel:string; status:"loading"|"ready"|"error"; onSelect:(event:AtlasEvent)=>void; onHighlight:(id:string|null)=>void; onReset:()=>void; onRetry:()=>void};

// Three floating notifications: full contrast first, then a stepped recession.
// Revealing the stack restores readability without moving the globe's camera.
export default function NotificationStack({events,region,dateLabel,status,onSelect,onHighlight,onReset,onRetry}:Props) {
  const [hovered,setHovered]=useState(false);
  const [keyboardFocus,setKeyboardFocus]=useState(false);
  const [manual,setManual]=useState<"auto"|"expanded"|"collapsed">("auto");
  const expanded=manual==="expanded" || (manual!=="collapsed" && (hovered || keyboardFocus));
  return <aside className={`notification-stack${expanded ? " is-expanded" : ""}`} aria-label={region ? `${region}的历史消息` : "历史消息"}
    style={{"--message-count":Math.max(1,events.length)} as CSSProperties}
    onPointerLeave={()=>{setHovered(false);onHighlight(null);if(manual==="collapsed")setManual("auto");}}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget)){setKeyboardFocus(false);onHighlight(null);}}}
    onKeyDown={event=>{if(event.key==="Escape" && expanded && events.length>1){event.stopPropagation();setManual("collapsed");setKeyboardFocus(false);event.currentTarget.querySelector<HTMLButtonElement>(".notification-toggle")?.focus({preventScroll:true});}}}>
    {region && <div className="notification-region"><span>{region}</span><button className="icon-button" aria-label="返回全球" onClick={onReset}><X size={16}/></button></div>}
    <div className="notification-deck" id="history-notifications" aria-label="按优先级排列的消息">
      {events.map((event,index)=>{
        const copy=notificationCopy(event);
        return <button key={event.id} className="notification-card" style={{"--message-index":index} as CSSProperties}
          aria-label={`${copy.title}，${yearLabel(event.historical?.year || event.start)}，查看详情`}
          onPointerEnter={input=>{onHighlight(event.id);if(input.pointerType==="mouse")setHovered(true);}}
          onFocus={focus=>{onHighlight(event.id);if(focus.currentTarget.matches(":focus-visible")){setManual("auto");setKeyboardFocus(true);}}}
          onClick={()=>{if(index>0 && !expanded){setManual("expanded");return;}onSelect(event);}}>
          <span className="notification-meta"><span className="notification-app-icon" aria-hidden="true"><Globe2 size={15}/></span><span>{event.historical ? "历史上的今天" : "历史片段 · 演示"}</span><time>{event.historical ? `${event.historical.year<0 ? "前 " : ""}${Math.abs(event.historical.year)} 年` : dateLabel}</time></span>
          <strong className="notification-title">{copy.title}</strong>
          <span className="notification-preview">{copy.preview}</span>
        </button>;
      })}
      {!events.length && <div className="notification-empty" role="status"><Globe2 size={20}/><span>{status==="loading" ? "正在找寻今天的往事…" : status==="error" ? "消息暂时未能送达" : region ? "这里的历史，等待补充" : "这一天的历史，等待补充"}</span>{status==="error" && <button className="text-button" onClick={onRetry}>重新加载</button>}</div>}
    </div>
    {events.length>1 && <button className="notification-toggle" onClick={()=>{setManual(expanded ? "collapsed" : "expanded");setKeyboardFocus(false);}} aria-expanded={expanded} aria-controls="history-notifications"><span>{expanded ? "收起消息" : "展开消息"}</span><ChevronDown size={14}/></button>}
  </aside>;
}
