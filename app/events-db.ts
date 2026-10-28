import { CATEGORY_COLORS, type AtlasEvent } from "./atlas-model";

/**
 * Offline event shards built by `scripts/build-events.mjs`.
 *
 * Keys are short on purpose: the dataset is ~20k rows and every byte is shipped
 * from the CDN. Field map:
 *   t  Chinese title derived from the translated event sentence, null if unavailable
 *   te English title derived from the original feed sentence
 *   dz Chinese translation bound to the exact English sentence, null if unavailable
 *   dzSrc translation provenance (manual or mt)
 *   de English description (the feed sentence)
 *   y/m/day year, month, day (y is negative for BCE; there is no year 0)
 *   lat/lng  coordinates of the recorded place, when one could be resolved
 *   c country ISO3 code, p place name, w sitelinks (importance proxy)
 *   q Wikidata item, s source page
 */
export type Locale = "zh" | "en";

export type StoredEvent = {
  id: string;
  t: string | null;
  te: string;
  dz: string | null;
  dzSrc?: "zhwiki" | "manual" | "mt" | null;
  de: string;
  y: number;
  m: number;
  day: number;
  lat: number | null;
  lng: number | null;
  c: string | null;
  p: string | null;
  w: number | null;
  q: string | null;
  s: string;
};

export type Tier = "day" | "month" | "year" | "decade";

const TIERS: Tier[] = ["day", "month", "year", "decade"];
const cache = new Map<string, Promise<StoredEvent[]>>();

function load(path: string, allowMissing = false): Promise<StoredEvent[]> {
  const cached = cache.get(path);
  if (cached) return cached;
  const pending = fetch(path)
    .then((response) => {
      // Years with no recorded events have no shard at all; that is not an error.
      if (response.status === 404 && allowMissing) return [] as StoredEvent[];
      if (!response.ok) throw new Error(`事件数据暂时不可用（${response.status}）`);
      return response.json() as Promise<StoredEvent[]>;
    })
    .catch((error) => {
      cache.delete(path);
      throw error;
    });
  cache.set(path, pending);
  return pending;
}

const yearPath = (year: number) => `/data/events/year/${year}.json`;
const dayPath = (month: number, day: number) =>
  `/data/events/day/${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}.json`;

export function loadYear(year: number): Promise<StoredEvent[]> {
  return load(yearPath(year), true);
}

export function loadDay(month: number, day: number): Promise<StoredEvent[]> {
  return load(dayPath(month, day));
}

/** A decade is ten year shards; used only for the coarsest fallback tier. */
export async function loadDecade(decade: number): Promise<StoredEvent[]> {
  const years = Array.from({ length: 10 }, (_, index) => decade + index).filter(year => year !== 0);
  const shards = await Promise.all(years.map(loadYear));
  return shards.flat();
}

export type EventQuery = { mode: "today"; month: number; day: number } | { mode: "timeline"; year: number; includeDecade?: boolean };
export type EventScopeData = { day: StoredEvent[]; year: StoredEvent[]; decade: StoredEvent[] };

/** Fetch only the active mode and publish a complete result, including its fallback. */
export async function loadEventScope(
  query: EventQuery,
  loaders = { loadDay, loadYear, loadDecade },
): Promise<EventScopeData> {
  if (query.mode === "today") return { day: await loaders.loadDay(query.month, query.day), year: [], decade: [] };
  const decadeStart = Math.floor(query.year / 10) * 10;
  // A populated global year can still be empty for the selected region.
  // Year-shard caching also deduplicates the active year within this decade.
  if (query.includeDecade) {
    const [year, decade] = await Promise.all([loaders.loadYear(query.year), loaders.loadDecade(decadeStart)]);
    return { day: [], year, decade };
  }
  const year = await loaders.loadYear(query.year);
  const decade = year.length ? [] : await loaders.loadDecade(decadeStart);
  return { day: [], year, decade };
}

const isChinese = (text: string) => /[\u4e00-\u9fa5]/.test(text);

/**
 * Both languages live in the same record. Chinese is preferred when available;
 * otherwise the English original is shown and flagged in the UI.
 */
export function toAtlasEvent(event: StoredEvent, locale: Locale = "zh"): AtlasEvent {
  const title = (locale === "zh" ? event.t : event.te) || event.t || event.te;
  const summary = (locale === "zh" ? event.dz : event.de) || event.de || event.dz || "";
  return {
    id: event.id,
    title,
    textLocale: isChinese(summary) ? "zh" : "en",
    summarySource: locale === "zh" && event.dz ? event.dzSrc ?? "original" : "original",
    originalSummary: event.de,
    location: event.p || "地点待考证",
    region: "",
    country: event.c || "",
    lat: event.lat ?? undefined,
    lng: event.lng ?? undefined,
    start: event.y,
    end: event.y,
    category: "社会",
    color: CATEGORY_COLORS.社会,
    summary,
    importance: event.w ?? undefined,
    historical: {
      year: event.y,
      month: event.m,
      day: event.day,
      sourceUrl: event.s,
      locationEntity: event.q || undefined,
    },
  };
}

export function toAtlasEvents(events: StoredEvent[], locale: Locale = "zh"): AtlasEvent[] {
  return events
    .map((event) => toAtlasEvent(event, locale))
    .sort((a, b) => b.start - a.start || b.historical!.month - a.historical!.month || b.historical!.day - a.historical!.day || a.id.localeCompare(b.id));
}

export function eventsForRegion(events: AtlasEvent[], code: string | null) {
  if (!code) return events;
  const normalized = code === "TWN" ? "CHN" : code;
  return events.filter(event => (event.country === "TWN" ? "CHN" : event.country) === normalized);
}

/** Events recorded exactly on the selected date. */
export function atDay(events: AtlasEvent[], year: number, month: number, day: number) {
  return events.filter(
    (event) => event.historical?.year === year && event.historical.month === month && event.historical.day === day,
  );
}

export function atMonth(events: AtlasEvent[], year: number, month: number) {
  return events.filter((event) => event.historical?.year === year && event.historical.month === month);
}

export function atYear(events: AtlasEvent[], year: number) {
  return events.filter((event) => event.historical?.year === year);
}

export function atDecade(events: AtlasEvent[], year: number) {
  const decade = Math.floor(year / 10) * 10;
  return events.filter((event) => {
    const value = event.historical?.year;
    return value !== undefined && value >= decade && value <= decade + 9;
  });
}

type Point = { year: number; month: number; day: number };

export type ResolvedScope = {
  tier: Tier | null;
  events: AtlasEvent[];
  /** Tiers that were tried and found empty, finest first. */
  tried: Tier[];
};

/**
 * Walk from the finest tier the current zoom level allows towards coarser ones.
 * `finest` bounds how specific the answer may be: a century-wide view should not
 * report a single day even when that day happens to have an event.
 */
export function resolveScope(
  finest: Tier,
  point: Point,
  shards: { year: AtlasEvent[]; decade: AtlasEvent[]; day?: AtlasEvent[] },
): ResolvedScope {
  const tried: Tier[] = [];
  for (const tier of TIERS.slice(TIERS.indexOf(finest))) {
    let matches: AtlasEvent[] = [];
    if (tier === "day") matches = atDay(shards.day ?? shards.year, point.year, point.month, point.day);
    if (tier === "month") matches = atMonth(shards.year, point.year, point.month);
    if (tier === "year") matches = atYear(shards.year, point.year);
    if (tier === "decade") matches = atDecade(shards.decade, point.year);
    if (matches.length) return { tier, events: matches, tried };
    tried.push(tier);
  }
  return { tier: null, events: [], tried };
}

export const TIER_LABEL: Record<Tier, string> = {
  day: "该日",
  month: "该月",
  year: "该年",
  decade: "该年代",
};
