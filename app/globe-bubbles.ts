import { yearLabel, type AtlasEvent } from "./demo-data";
import { notificationCopy, type CountryMessages } from "./notification-events";

export type GlobeBubble = CountryMessages & { name: string };

// The renderer owns the anchor's transform. All presentation and folding stay
// inside it, so the speech bubble follows the country's surface as it rotates.
export function createGlobeBubble(group:GlobeBubble, callbacks:{
  select:(event:AtlasEvent)=>void;
  enter:()=>void;
  expand:(close:()=>void)=>void;
  reading:(active:boolean)=>void;
}) {
  const anchor=document.createElement("div");
  anchor.className="globe-bubble-anchor";
  anchor.dataset.country=group.country;
  anchor.dataset.stacked=String(group.events.length>1);
  const panel=document.createElement("div");
  panel.className="globe-bubble-panel";
  panel.setAttribute("role","group");
  panel.setAttribute("aria-label",`${group.name}的历史消息`);
  panel.style.setProperty("--bubble-count",String(group.events.length));
  const deck=document.createElement("div");
  deck.className="globe-bubble-deck";
  let expanded=false, suppressFocus=false;
  const buttons=group.events.map((event,index)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="globe-bubble";
    button.style.setProperty("--bubble-index",String(index));
    const title=notificationCopy(event).title;
    button.setAttribute("aria-label",`${group.name}：${title}，${yearLabel(event.start)}${index===0 && group.events.length>1 ? "，展开消息或查看详情" : "，查看详情"}`);
    const label=document.createElement("span");
    label.className="globe-bubble-title";
    label.textContent=title;
    const year=document.createElement("span");
    year.className="globe-bubble-year";
    year.textContent=`${Math.abs(event.start)}${event.start<0 ? " BCE" : "年"}`;
    year.setAttribute("aria-hidden","true");
    button.appendChild(label);button.appendChild(year);
    button.onclick=input=>{
      input.stopPropagation();
      if(group.events.length>1 && !expanded){expand();return;}
      callbacks.select(event);
    };
    deck.appendChild(button);
    return button;
  });
  function setExpanded(next:boolean){
    expanded=next && buttons.length>1;
    anchor.dataset.expanded=String(expanded);
    if(buttons.length>1)buttons[0].setAttribute("aria-expanded",String(expanded));
    buttons.forEach((button,index)=>{
      button.tabIndex=index===0 || expanded ? 0 : -1;
      if(index>0)button.setAttribute("aria-hidden",String(!expanded));
    });
  }
  function close(){setExpanded(false);}
  function expand(){if(!expanded){callbacks.expand(close);setExpanded(true);}}
  anchor.onpointerdown=input=>input.stopPropagation();
  anchor.onpointermove=input=>input.stopPropagation();
  anchor.onpointerenter=input=>{callbacks.enter();if(input.pointerType==="mouse")expand();};
  anchor.onpointerleave=input=>{if(input.pointerType==="mouse" && !buttons.some(button=>button.matches(":focus-visible")))close();};
  anchor.addEventListener("focusin",()=>{const keyboard=buttons.some(button=>button.matches(":focus-visible"));callbacks.reading(keyboard);if(!suppressFocus && keyboard)expand();});
  anchor.addEventListener("focusout",input=>{if(!(input.relatedTarget instanceof Node) || !anchor.contains(input.relatedTarget)){callbacks.reading(false);close();}});
  anchor.onkeydown=input=>{
    if(input.key!=="Escape" || !expanded)return;
    input.preventDefault();input.stopPropagation();close();
    suppressFocus=true;buttons[0].focus({preventScroll:true});suppressFocus=false;
  };
  panel.appendChild(deck);
  const dot=document.createElement("span");
  dot.className="globe-bubble-dot";dot.setAttribute("aria-hidden","true");
  anchor.appendChild(panel);anchor.appendChild(dot);
  setExpanded(false);
  return anchor;
}
