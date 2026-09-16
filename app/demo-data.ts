// Illustrative scenarios; replace this module with sourced historical records.
export type AtlasEvent = {
  id: string; title: string; location: string; region: string; country: string;
  lat: number; lng: number; start: number; end: number;
  category: "交流" | "文化" | "社会" | "科技"; summary: string; color: string;
};
export const CATEGORY_COLORS = { "交流": "#d3b580", "文化": "#8ec4b2", "社会": "#99b3d6", "科技": "#baa8d2" };
export const PERIODS = [
  { start: -500, end: 499, name: "古典世界", subtitle: "文明的相遇", themes: ["城邦生活", "思想与学问", "陆路交流", "聚落与社会"] },
  { start: 500, end: 999, name: "文明交汇", subtitle: "交织的道路", themes: ["城市与商路", "知识的流动", "文化与信仰", "区域间的交流"] },
  { start: 1000, end: 1399, name: "交流的时代", subtitle: "跨越山海", themes: ["远途贸易", "城市的成长", "工艺与创造", "海上往来"] },
  { start: 1400, end: 1699, name: "探索的时代", subtitle: "世界，正在连接", themes: ["海上交流", "城市与艺术", "商路上的相遇", "知识与探索"] },
  { start: 1700, end: 1899, name: "变革的时代", subtitle: "变化中的世界", themes: ["工业与城市", "交通的变迁", "社会与生活", "科学的探索"] },
  { start: 1900, end: 2025, name: "现代世界", subtitle: "更紧密的连接", themes: ["全球往来", "城市与日常", "文化的传播", "技术的变迁"] },
];
const LOCATIONS = [
  { location: "南京", region: "东亚", country: "CHN", lat: 32.06, lng: 118.8, category: "交流" as const },
  { location: "佛罗伦萨", region: "欧洲", country: "ITA", lat: 43.77, lng: 11.25, category: "文化" as const },
  { location: "开罗", region: "北非", country: "EGY", lat: 30.04, lng: 31.24, category: "社会" as const },
  { location: "德里", region: "南亚", country: "IND", lat: 28.61, lng: 77.21, category: "科技" as const },
  { location: "墨西哥谷地", region: "美洲", country: "MEX", lat: 19.43, lng: -99.13, category: "社会" as const },
  { location: "廷巴克图", region: "西非", country: "MLI", lat: 16.77, lng: -3.01, category: "文化" as const },
  { location: "马六甲", region: "东南亚", country: "MYS", lat: 2.19, lng: 102.25, category: "交流" as const },
  { location: "安第斯地区", region: "南美洲", country: "PER", lat: -13.53, lng: -71.97, category: "科技" as const },
];
export const DEMO_EVENTS: AtlasEvent[] = PERIODS.flatMap((period, p) => LOCATIONS.map((place, i) => ({
  ...place, id: `demo-${p}-${i}`, title: period.themes[i % 4],
  start: period.start + (i > 5 ? 15 : 0), end: period.end - (i > 5 ? 15 : 0),
  category: place.category, color: CATEGORY_COLORS[place.category],
  summary: `这是「${period.name}」的交互演示场景，用于预览${place.region}的地点标记、时间联动与事件阅读体验。正式历史资料将在后续补充；此处的主题、地点组合与时间范围不作为历史事实。`,
})));
export const DAY = 86400000;
export function timestamp(year: number, month = 1, day = 1) {
  const d = new Date(0); d.setUTCHours(0, 0, 0, 0); d.setUTCFullYear(year < 0 ? year + 1 : year, month - 1, day); return d.getTime();
}
export function dateParts(time: number) { const d = new Date(time); const y = d.getUTCFullYear(); return { year: y <= 0 ? y - 1 : y, month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
export function yearLabel(year: number) { return `${year < 0 ? "公元前 " : "公元 "}${Math.abs(year)} 年`; }
export const MIN_TIME = timestamp(-500); export const MAX_TIME = timestamp(2025, 12, 31);
export const clampTime = (t: number) => Math.max(MIN_TIME, Math.min(MAX_TIME, t));
export function periodAt(time: number) { const {year} = dateParts(time); return PERIODS.find(p => year >= p.start && year <= p.end) || PERIODS[0]; }
export function eventsAt(time: number) { const {year} = dateParts(time); return DEMO_EVENTS.filter(e => year >= e.start && year <= e.end); }
