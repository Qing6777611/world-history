#!/usr/bin/env node
/**
 * Build the offline "on this day" dataset.
 *
 * Sources
 *  - English Wikipedia on-this-day feed (CC BY-SA): 366 requests, cached in .cache/feeds/en
 *  - Sentence-keyed manual/machine translations from local caches
 *  - Coordinates from linked English feed pages; modern country boundaries
 *
 * Every Chinese string is normalised to Simplified with OpenCC at build time.
 *
 * Output
 *  public/data/events/year/<YYYY>.json   every event recorded in that year
 *  public/data/events/day/<MM-DD>.json   every event recorded on that calendar day
 *  public/data/events/manifest.json      year bounds + counts + build time
 *
 * Usage: node scripts/build-events.mjs [--refresh | --offline]
 */
import { mkdir, readFile, writeFile, access, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import OpenCC from "opencc-js";
import { clampText, englishDaySource, eventId, summaryTitle, translatedDescription, validateFeed } from "./event-records.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CACHE = join(ROOT, ".cache/feeds");
const OUT = join(ROOT, "public/data/events");
const UA = "WorldHistoryAtlas/1.0 (offline data build)";
const REFRESH = process.argv.includes("--refresh");
const OFFLINE = process.argv.includes("--offline");
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const MT_CACHE = join(ROOT, ".cache/translations.json");
const MANUAL_CACHE = join(ROOT, ".cache/translations-manual.json");
const TRANSLATION_CATALOG = join(ROOT, "data/translations/zh-Hans.json");

const YEAR_PAGE = /^-?\d+$/;
const DAY_PAGE = /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(, \d{1,4})?$/;
const DENY = /country|government|organization|company|headquarters|birthplace|politician|institution|agency|party|club|team of|sports club/i;
const ALLOW = /city|capital|battle|siege|earthquake|volcano|monument|building|airport|stadium|square|site|town|port|harbou?r|palace|castle|fortress|street|cathedral|church|mosque|temple|river|island|province|region|district|village|neighbo|park|museum|university/i;
// Retain a linked topic QID as metadata only. Titles come from the sentence and
// this topic is never used as an event identity or a translation match.
const EVENTISH = /battle|siege|treaty|war|massacre|attack|bombing|election|coronation|assassination|conquest|fall of|founding|independence|revolution|uprising|riot|expedition|landing|launch|disaster|earthquake|eruption|fire|crash|sinking|signing|declaration|act of|protest|murder|execution|trial|crisis|accord|summit|opening|closing/i;

const months = Array.from({ length: 12 }, (_, i) => i + 1);
const daysIn = (m) => new Date(Date.UTC(2024, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, "0");

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function feed(lang, mm, dd) {
  const dir = join(CACHE, lang);
  const path = join(dir, `${pad(mm)}-${pad(dd)}.json`);
  await mkdir(dir, { recursive: true });
  if (!REFRESH && (await exists(path))) {
    try { return validateFeed(JSON.parse(await readFile(path, "utf8")), path); }
    catch (error) { if (OFFLINE) throw error; }
  }
  if (OFFLINE) throw new Error(`Offline build requires a valid cached feed: ${path}`);
  const url = `https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday/events/${pad(mm)}/${pad(dd)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const data = validateFeed(JSON.parse(text), url);
      await writeFile(path, text);
      return data;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(`Cannot build an incomplete dataset: ${lang} ${pad(mm)}-${pad(dd)}: ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`Cannot read event feed: ${path}`);
}

const STRONG_PLACE = /battle|siege|earthquake|volcano|monument|cathedral|church|mosque|temple|palace|castle|fortress|airport|stadium|square|tower/i;

/**
 * The feed links several entities per event; the first one with coordinates is
 * often unrelated (a person's birthplace, a random city). Only trust a point
 * when the sentence names the place, or the page is a strong place type.
 */
function pickLocation(pages, text) {
  const sentence = (text || "").toLowerCase();
  const candidates = pages.filter((page) => {
    const coordinates = page.coordinates;
    if (!coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lon)) return false;
    if (DENY.test(page.description || "")) return false;
    return ALLOW.test(`${page.title} ${page.description || ""}`);
  });
  const named = candidates.find((page) => {
    const name = (page.title || "").replaceAll("_", " ").toLowerCase();
    return name.length > 3 && sentence.includes(name);
  });
  return named || candidates.find((page) => STRONG_PLACE.test(`${page.title} ${page.description || ""}`));
}

function pickTitlePage(pages, fallback) {
  return pages.find((page) => EVENTISH.test(`${page.title} ${page.description || ""}`)) || fallback;
}

function normalize(raw, month, day) {
  const events = [];
  for (const item of raw.events || []) {
    if (!Number.isInteger(item.year) || item.year === 0) continue;
    const pages = (item.pages || []).filter(
      (page) => !YEAR_PAGE.test(page.title || "") && !DAY_PAGE.test(page.title || ""),
    );
    if (!pages.length) continue;
    const primary = pickTitlePage(pages, pages[0]);
    const location = pickLocation(pages, item.text);
    events.push({
      text: (item.text || "").replace(/\((pictured|image)[^)]*\)/gi, "").trim(),
      year: item.year,
      month,
      day,
      titleQid: primary.wikibase_item || null,
      placeQid: location?.wikibase_item || null,
      place: (location?.title || "").replaceAll("_", " ") || null,
      lat: location?.coordinates?.lat ?? null,
      lng: location?.coordinates?.lon ?? null,
      source: englishDaySource(month, day),
    });
  }
  return events;
}

/* Country comes from the modern boundary file we already ship, so the build
 * needs no network round-trip per event. Borders are coarse; a handful of
 * cities near a frontier may land on the wrong side, which the globe tolerates. */
function inRing(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function loadCountries() {
  const geojson = JSON.parse(await readFile(join(ROOT, "public/data/countries.geojson"), "utf8"));
  return geojson.features.map((feature) => {
    const iso = feature.properties.ISO_A3_EH;
    const raw = iso && iso !== "-99" ? iso : feature.properties.ADM0_A3;
    return {
      code: raw === "TWN" ? "CHN" : raw,
      polygons: feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates,
    };
  });
}

function countryAt(countries, lat, lng) {
  for (const country of countries) {
    for (const polygon of country.polygons) {
      if (inRing(polygon[0], lng, lat) && !polygon.slice(1).some((hole) => inRing(hole, lng, lat))) return country.code;
    }
  }
  return null;
}

async function main() {
  if (OFFLINE && REFRESH) throw new Error("--offline and --refresh cannot be combined");
  console.log(`1/4 reading 366 English feeds${OFFLINE ? " (offline)" : ""}`);
  const all = [];
  for (const month of months) {
    for (let day = 1; day <= daysIn(month); day++) {
      const en = await feed("en", month, day);
      all.push(...normalize(en, month, day));
    }
    process.stdout.write(`\r  ${month}/12 months`);
  }
  process.stdout.write("\n");
  console.log(`  ${all.length} English events`);

  let manualZh = {};
  try { manualZh = JSON.parse(await readFile(MANUAL_CACHE, "utf8")); } catch { manualZh = {}; }
  let machineZh = {};
  try { machineZh = JSON.parse(await readFile(MT_CACHE, "utf8")); } catch { machineZh = {}; }
  // Versioned translations survive a fresh checkout or removal of local caches.
  // New cache entries can repair a catalog entry; exact-source hashes prevent
  // translations from migrating to a different event when feeds change.
  let catalog = { manual: {}, machine: {} };
  try { catalog = JSON.parse(await readFile(TRANSLATION_CATALOG, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  manualZh = { ...catalog.manual, ...manualZh };
  machineZh = { ...catalog.machine, ...machineZh };
  console.log(`  ${Object.keys(manualZh).length} hand translations, ${Object.keys(machineZh).length} machine translations; unverified QID candidates are not used`);

  console.log("2/4 assembling records");
  const countries = await loadCountries();
  let zhDescriptions = 0;
  let zhTitles = 0;
  const seen = new Set();
  const records = [];
  for (const event of all) {
    const descriptionEn = clampText(event.text, 500);
    if (!descriptionEn) continue;
    const translated = translatedDescription(descriptionEn, manualZh, machineZh);
    const descriptionZh = translated.text ? clampText(toSimplified(translated.text), 500) : null;
    const titleEn = summaryTitle(descriptionEn);
    const titleZh = descriptionZh ? summaryTitle(descriptionZh, 48) : null;
    const id = eventId(event);
    if (seen.has(id)) continue;
    seen.add(id);
    if (descriptionZh) zhDescriptions++;
    if (titleZh) zhTitles++;
    const lat = event.lat;
    const lng = event.lng;
    records.push({
      id,
      t: titleZh,
      te: titleEn,
      dz: descriptionZh,
      dzSrc: translated.source,
      de: descriptionEn,
      y: event.year,
      m: event.month,
      day: event.day,
      lat: lat == null ? null : Math.round(lat * 1e4) / 1e4,
      lng: lng == null ? null : Math.round(lng * 1e4) / 1e4,
      c: lat != null && lng != null ? countryAt(countries, lat, lng) : null,
      p: event.place,
      // No reliable importance measurement is available in the feed.
      w: null,
      q: event.titleQid,
      s: event.source,
    });
  }

  console.log("3/4 writing shards");
  await mkdir(join(OUT, "year"), { recursive: true });
  await mkdir(join(OUT, "day"), { recursive: true });
  const byYear = new Map();
  for (const record of records) {
    if (!byYear.has(record.y)) byYear.set(record.y, []);
    byYear.get(record.y).push(record);
  }
  for (const list of byYear.values()) {
    list.sort((a, b) => a.m - b.m || a.day - b.day || a.id.localeCompare(b.id));
    const body = JSON.stringify(list);
    await writeFile(join(OUT, "year", `${list[0].y}.json`), body);
  }
  const byCalendarDay = new Map();
  for (const record of records) {
    const key = `${pad(record.m)}-${pad(record.day)}`;
    if (!byCalendarDay.has(key)) byCalendarDay.set(key, []);
    byCalendarDay.get(key).push(record);
  }
  for (const [key, list] of byCalendarDay) {
    list.sort((a, b) => b.y - a.y || a.id.localeCompare(b.id));
    await writeFile(join(OUT, "day", `${key}.json`), JSON.stringify(list));
  }

  // Remove obsolete generated shards only after every required feed was read.
  for (const [directory, keys] of [["year", new Set([...byYear.keys()].map(String))], ["day", new Set(byCalendarDay.keys())]]) {
    for (const file of await readdir(join(OUT, directory))) {
      if (file.endsWith(".json") && !keys.has(file.slice(0, -5))) await unlink(join(OUT, directory, file));
    }
  }

  let yearBytes = 0, dayBytes = 0;
  for (const list of byYear.values()) yearBytes += Buffer.byteLength(JSON.stringify(list));
  for (const list of byCalendarDay.values()) dayBytes += Buffer.byteLength(JSON.stringify(list));

  console.log("4/4 manifest");
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    events: records.length,
    years: byYear.size,
    minYear: Math.min(...byYear.keys()),
    maxYear: Math.max(...byYear.keys()),
    days: byCalendarDay.size,
    withCoordinates: records.filter((r) => r.lat != null).length,
    withChineseTitle: zhTitles,
    withChineseDescription: zhDescriptions,
    chineseDescriptionSources: Object.fromEntries(["manual", "mt", "untranslated"].map((source) => [source, records.filter((record) => (record.dzSrc ?? "untranslated") === source).length])),
    withImportance: 0,
    yearBytes, dayBytes,
  };
  await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(manifest);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
