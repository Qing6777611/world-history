import type { AtlasEvent } from "./atlas-model";
import type { CountryFeature, CountryRegion } from "./country-geometry";

export type HistoricalPolity = {
  id: string;
  nameEn: string;
  nameZh: string;
  nameZhSource?: string;
  type: string;
  from: number;
  to: number;
  wikidataIds?: string[];
  wikipedia?: unknown;
};

export type HistoricalManifest = {
  schemaVersion: 1;
  minYear: number;
  maxYear: number;
  source: { name: string; url: string; version?: string; commit?: string; sha256?: string };
  license: { name: string; url: string };
  polities: HistoricalPolity[];
  chunks: Array<{ from: number; to: number; path: string }>;
};

export type HistoricalSnapshot = {
  year: number;
  status: "ready";
  features: CountryFeature[];
  manifest: HistoricalManifest;
} | {
  year: number;
  status: "unavailable";
  reason: "invalid-year" | "out-of-range";
  features: CountryFeature[];
  manifest: HistoricalManifest | null;
};

export type HistoricalEventIndex = Record<string, string[]>;
type HistoricalFeature = {
  properties: { polityId: string; from: number; to: number; type?: string; memberOf?: string[]; components?: string[] };
  geometry: CountryFeature["geometry"];
};
type HistoricalChunk = { type: "FeatureCollection"; features: HistoricalFeature[] };
type FetchJSON = (path: string) => Promise<Response>;
type Locale = "zh" | "en";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string" && !!id);
const validYear = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
const coversYear = (range: { from: number; to: number }, year: number) => range.from <= year && year <= range.to;

function validRange(value: Record<string, unknown>) {
  return validYear(value.from) && validYear(value.to) && value.from <= value.to;
}

function parseManifest(value: unknown): HistoricalManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !validYear(value.minYear) || !validYear(value.maxYear) || value.minYear > value.maxYear
    || !isRecord(value.source) || typeof value.source.name !== "string" || typeof value.source.url !== "string"
    || !isRecord(value.license) || typeof value.license.name !== "string" || typeof value.license.url !== "string"
    || !Array.isArray(value.polities) || !Array.isArray(value.chunks)) throw new Error("历史疆域目录格式无效");
  const ids = new Set<string>();
  for (const polity of value.polities) {
    if (!isRecord(polity) || typeof polity.id !== "string" || !polity.id || ids.has(polity.id)
      || typeof polity.nameEn !== "string" || typeof polity.nameZh !== "string" || typeof polity.type !== "string" || !validRange(polity)) {
      throw new Error("历史政权目录格式无效");
    }
    ids.add(polity.id);
  }
  for (const chunk of value.chunks) {
    if (!isRecord(chunk) || !validRange(chunk) || typeof chunk.path !== "string" || !chunk.path) throw new Error("历史疆域分片目录格式无效");
  }
  return value as HistoricalManifest;
}

function parseChunk(value: unknown): HistoricalChunk {
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) throw new Error("历史疆域分片格式无效");
  for (const feature of value.features) {
    if (!isRecord(feature) || !isRecord(feature.properties) || typeof feature.properties.polityId !== "string" || !validRange(feature.properties)
      || feature.properties.memberOf !== undefined && !validIds(feature.properties.memberOf)
      || feature.properties.components !== undefined && !validIds(feature.properties.components)
      || !isRecord(feature.geometry) || !["Polygon", "MultiPolygon"].includes(String(feature.geometry.type)) || !Array.isArray(feature.geometry.coordinates)) {
      throw new Error("历史疆域几何格式无效");
    }
  }
  return value as HistoricalChunk;
}

function parseEventIndex(value: unknown): HistoricalEventIndex {
  if (!isRecord(value) || Object.values(value).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id))) {
    throw new Error("历史事件归属索引格式无效");
  }
  return value as HistoricalEventIndex;
}

const polityMaps = new WeakMap<HistoricalManifest, Map<string, HistoricalPolity>>();
function politiesById(manifest: HistoricalManifest) {
  let result = polityMaps.get(manifest);
  if (!result) {
    result = new Map(manifest.polities.map(polity => [polity.id, polity]));
    polityMaps.set(manifest, result);
  }
  return result;
}

export function historicalPolityName(id: string, manifest: HistoricalManifest, locale: Locale = "zh") {
  const polity = politiesById(manifest).get(id);
  if (!polity) return id;
  return (locale === "zh" ? polity.nameZh : polity.nameEn) || polity.nameEn || polity.nameZh || id;
}

export function historicalRegion(feature: CountryFeature, locale: Locale = "zh"): CountryRegion {
  const code = feature.properties.HISTORY_ID || feature.properties.ADM0_A3;
  const name = (locale === "zh" ? feature.properties.NAME_ZH : feature.properties.NAME_EN)
    || feature.properties.NAME_EN || feature.properties.NAME_ZH || code;
  return { code, name };
}

/** The geometry and intervals come directly from the historical dataset. */
function renderFeature(feature: HistoricalFeature, manifest: HistoricalManifest): CountryFeature {
  const id = feature.properties.polityId;
  const polity = politiesById(manifest).get(id);
  if (!polity) throw new Error(`历史疆域引用了未知政权：${id}`);
  return {
    properties: {
      ADM0_A3: id,
      NAME_EN: polity.nameEn || polity.nameZh || id,
      NAME_ZH: polity.nameZh || polity.nameEn || id,
      HISTORY_ID: id,
      HISTORY_TYPE: feature.properties.type || polity.type,
      HISTORY_COMPONENTS: JSON.stringify(feature.properties.components ?? []),
      HISTORY_MEMBER_OF: JSON.stringify(feature.properties.memberOf ?? []),
      FROM_YEAR: String(feature.properties.from),
      TO_YEAR: String(feature.properties.to),
    },
    geometry: feature.geometry,
  };
}

function renderFeatures(features: HistoricalFeature[], manifest: HistoricalManifest): CountryFeature[] {
  const grouped = new Map<string, HistoricalFeature[]>();
  for (const feature of features) {
    const id = feature.properties.polityId;
    const group = grouped.get(id);
    if (group) group.push(feature);
    else grouped.set(id, [feature]);
  }
  return [...grouped.values()].map(group => {
    const rendered = renderFeature(group[0], manifest);
    const intervals = group.map(({ properties }) => ({ from: properties.from, to: properties.to }));
    return {
      properties: {
        ...rendered.properties,
        HISTORY_COMPONENTS: JSON.stringify([...new Set(group.flatMap(feature => feature.properties.components ?? []))]),
        HISTORY_MEMBER_OF: JSON.stringify([...new Set(group.flatMap(feature => feature.properties.memberOf ?? []))]),
        // The merged shape is valid only while all currently included records
        // coexist. Keep each record's interval instead of inventing a union.
        FROM_YEAR: String(Math.max(...intervals.map(interval => interval.from))),
        TO_YEAR: String(Math.min(...intervals.map(interval => interval.to))),
        HISTORY_INTERVALS: JSON.stringify(intervals),
      },
      geometry: group.length === 1 ? rendered.geometry : {
        type: "MultiPolygon" as const,
        coordinates: group.flatMap(({ geometry }) => geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates),
      },
    };
  });
}

/** Separate loader instances make cache lifetime explicit and allow isolated tests. */
export function createHistoricalGeographyLoader({ fetcher = (path: string) => fetch(path), basePath = "/data/history", maxChunks = 8 }: {
  fetcher?: FetchJSON;
  basePath?: string;
  maxChunks?: number;
} = {}) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new RangeError("maxChunks must be a positive integer");
  const base = basePath.replace(/\/$/, "");
  const chunkCache = new Map<string, Promise<HistoricalChunk>>();
  let manifestPromise: Promise<HistoricalManifest> | undefined;
  let indexPromise: Promise<HistoricalEventIndex> | undefined;

  async function json(path: string): Promise<unknown> {
    const response = await fetcher(path);
    if (!response.ok) throw new Error(`历史疆域数据暂时无法加载（${response.status}）`);
    return response.json();
  }

  function loadHistoricalManifest(): Promise<HistoricalManifest> {
    if (!manifestPromise) manifestPromise = json(`${base}/manifest.json`).then(parseManifest).catch(error => {
      manifestPromise = undefined;
      throw error;
    });
    return manifestPromise;
  }

  function loadChunk(path: string, manifest: HistoricalManifest): Promise<HistoricalChunk> {
    const url = path.startsWith("/") ? path : `${base}/${path}`;
    const cached = chunkCache.get(url);
    if (cached) {
      chunkCache.delete(url);
      chunkCache.set(url, cached);
      return cached;
    }
    const pending = json(url).then(parseChunk).then(chunk => {
      const polities = politiesById(manifest);
      for (const feature of chunk.features) {
        if (!polities.has(feature.properties.polityId)) throw new Error(`历史疆域引用了未知政权：${feature.properties.polityId}`);
      }
      return chunk;
    }).catch(error => {
      // An evicted request may finish after a newer request for the same URL.
      if (chunkCache.get(url) === pending) chunkCache.delete(url);
      throw error;
    });
    chunkCache.set(url, pending);
    while (chunkCache.size > maxChunks) chunkCache.delete(chunkCache.keys().next().value!);
    return pending;
  }

  async function loadHistoricalYear(year: number): Promise<HistoricalSnapshot> {
    if (!validYear(year)) return { year, status: "unavailable", reason: "invalid-year", features: [], manifest: null };
    const manifest = await loadHistoricalManifest();
    if (year < manifest.minYear || year > manifest.maxYear) return { year, status: "unavailable", reason: "out-of-range", features: [], manifest };
    const chunks = await Promise.all(manifest.chunks.filter(chunk => coversYear(chunk, year)).map(chunk => loadChunk(chunk.path, manifest)));
    const features = renderFeatures(chunks.flatMap(chunk => chunk.features.filter(feature => coversYear(feature.properties, year))), manifest);
    // An empty covered year means the source records no polygon. Never use a
    // neighbouring year or present-day country geometry to fill the gap.
    return { year, status: "ready", features, manifest };
  }

  function loadHistoricalEventIndex(): Promise<HistoricalEventIndex> {
    if (!indexPromise) indexPromise = json(`${base}/event-polities.json`).then(parseEventIndex).catch(error => {
      indexPromise = undefined;
      throw error;
    });
    return indexPromise;
  }

  return { loadHistoricalYear, loadHistoricalEventIndex, loadHistoricalManifest };
}

const loader = createHistoricalGeographyLoader();
export const loadHistoricalYear = loader.loadHistoricalYear;
export const loadHistoricalEventIndex = loader.loadHistoricalEventIndex;
export const loadHistoricalManifest = loader.loadHistoricalManifest;

/**
 * The index was computed against each event's own year, never the visible map.
 * Its order is significant: the smallest POLITY precedes wider RELATIONs.
 */
export function mapHistoricalEvents(events: AtlasEvent[], index: HistoricalEventIndex, manifest: HistoricalManifest, locale: Locale = "zh"): AtlasEvent[] {
  const polities = politiesById(manifest);
  return events.map(event => {
    const year = event.historical?.year ?? event.start;
    const hasPoint = Number.isFinite(event.lat) && Number.isFinite(event.lng) && Math.abs(event.lat!) <= 90 && Math.abs(event.lng!) <= 180;
    const ids = hasPoint && validYear(year) && year >= manifest.minYear && year <= manifest.maxYear ? index[event.id] || [] : [];
    const polityIds = [...new Set(ids)].filter(id => {
      const polity = polities.get(id);
      return polity && coversYear(polity, year);
    });
    const country = polityIds[0] || "";
    return {
      ...event,
      modernCountry: event.modernCountry ?? event.country,
      polityIds,
      country,
      region: country ? historicalPolityName(country, manifest, locale) : "",
    };
  });
}

export function historicalEventsForRegion(events: AtlasEvent[], code: string | null): AtlasEvent[] {
  return code ? events.filter(event => event.polityIds?.includes(code)) : events;
}
