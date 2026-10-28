// Shared event model and calendar helpers.
// Dates travel as UTC millisecond timestamps so the timeline never depends on
// the visitor's timezone, and year 0 does not exist (1 BC is -1).
import eventManifest from "../public/data/events/manifest.json" with { type: "json" };

export type AtlasEvent = {
  id: string;
  title: string;
  location: string;
  region: string;
  country: string;
  /** Historical location membership, evaluated at the event's own date. */
  polityIds?: string[];
  /** Present-day ISO country retained while browsing historical geography. */
  modernCountry?: string;
  lat?: number;
  lng?: number;
  start: number;
  end: number;
  category: "交流" | "文化" | "社会" | "科技";
  summary: string;
  color: string;
  historical?: {
    year: number;
    month: number;
    day: number;
    sourceUrl: string;
    locationUrl?: string;
    locationEntity?: string;
  };
  /** Cross-language sitelink count: used to rank events within the same scope. */
  importance?: number;
  /** Language actually shown, so the UI can mark an untranslated original. */
  textLocale?: "zh" | "en";
  summarySource?: "original" | "mt" | "manual" | "zhwiki";
  originalSummary?: string;
};

export const CATEGORY_COLORS = { "交流": "#d3b580", "文化": "#8ec4b2", "社会": "#99b3d6", "科技": "#baa8d2" };

export const DAY = 86400000;

export function timestamp(year: number, month = 1, day = 1) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year < 0 ? year + 1 : year, month - 1, day);
  return date.getTime();
}

export function dateParts(time: number) {
  const date = new Date(time);
  const year = date.getUTCFullYear();
  return { year: year <= 0 ? year - 1 : year, month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function yearLabel(year: number) {
  return `${year < 0 ? "公元前 " : "公元 "}${Math.abs(year)} 年`;
}

export function localToday(now = new Date()) {
  return timestamp(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function hasCoordinates(event: AtlasEvent): event is AtlasEvent & { lat: number; lng: number } {
  return Number.isFinite(event.lat) && Number.isFinite(event.lng);
}

// Follow the generated dataset so older records remain reachable after a rebuild.
export const MIN_YEAR = eventManifest.minYear;
export const MIN_TIME = timestamp(MIN_YEAR);
export const getMaxTime = (endYear: number) => timestamp(endYear, 12, 31);
export const clampTime = (time: number, endYear: number) => Math.max(MIN_TIME, Math.min(getMaxTime(endYear), time));
