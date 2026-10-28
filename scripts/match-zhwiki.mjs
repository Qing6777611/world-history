#!/usr/bin/env node
/**
 * Match Chinese Wikipedia "M月D日" bullets to Wikidata items.
 *
 * QIDs group related topics, not unique events. Preserve every candidate's full
 * date and source for editorial review; this index never authorizes an automatic
 * Chinese/English merge in build-events.mjs.
 *
 * Output: .cache/zh-by-qid.json { schemaVersion: 2, entries, pairs, byQid }
 * Usage: node scripts/match-zhwiki.mjs [--refresh | --offline]
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexChineseCandidates, parseChineseDay } from "./event-records.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CACHE = join(ROOT, ".cache/feeds/zh-days");
const OUT = join(ROOT, ".cache/zh-by-qid.json");
const UA = "WorldHistoryAtlas/1.0 (offline data build; contact: local)";
const REFRESH = process.argv.includes("--refresh");
const OFFLINE = process.argv.includes("--offline");
const run = promisify(execFile);

async function resolveTitles(titles) {
  const params = new URLSearchParams({
    action: "wbgetentities",
    sites: "zhwiki",
    titles: titles.join("|"),
    props: "sitelinks",
    format: "json",
  });
  const { stdout } = await run("curl", [
    "-sS", "--max-time", "40",
    "-A", UA,
    "-H", "Accept: application/json",
    `https://www.wikidata.org/w/api.php?${params}`,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const entities = JSON.parse(stdout).entities ?? {};
  const map = new Map();
  for (const [key, entity] of Object.entries(entities)) {
    if (key.startsWith("-")) continue;
    map.set(entity.sitelinks?.zhwiki?.title ?? key, key);
  }
  return map;
}

async function main() {
  if (OFFLINE && REFRESH) throw new Error("--offline and --refresh cannot be combined");
  const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
  if (!(await exists(CACHE))) {
    console.error(`missing ${CACHE}; run the Chinese day-page fetch first`);
    process.exit(1);
  }

  const files = [];
  for (let index = 0; index < 8; index++) {
    const file = join(CACHE, `${index}.json`);
    if (await exists(file)) files.push(file);
  }

  const entries = [];
  const calendarDays = new Set();
  for (const file of files) {
    const data = JSON.parse(await readFile(file, "utf8"));
    for (const page of data.query?.pages ?? []) {
      const match = /^(\d{1,2})月(\d{1,2})日$/.exec(page.title || "");
      const content = page.revisions?.[0]?.slots?.main?.content;
      if (!match || !content) continue;
      calendarDays.add(`${match[1]}-${match[2]}`);
      entries.push(...parseChineseDay(content, Number(match[1]), Number(match[2])));
    }
  }
  if (calendarDays.size !== 366) throw new Error(`Incomplete Chinese day-page cache: ${calendarDays.size}/366 days`);
  console.log(`parsed ${entries.length} Chinese review candidates`);

  // Index the first linked topic as a search hint; it is not an event identity.
  const titles = [...new Set(entries.map((entry) => entry.links[0]).filter(Boolean))];
  console.log(`resolving ${titles.length} zhwiki titles to QIDs`);

  let resolved = new Map();
  if (!REFRESH && (await exists(OUT))) {
    const cached = JSON.parse(await readFile(OUT, "utf8"));
    resolved = new Map(cached.pairs ?? []);
    console.log(`  ${resolved.size} pairs cached`);
  }
  const pending = OFFLINE ? [] : titles.filter((title) => !resolved.has(title));
  if (OFFLINE) console.log("  offline: unresolved titles remain in the candidate entries");
  for (let i = 0; i < pending.length; i += 50) {
    const batch = pending.slice(i, i + 50);
    let map = null;
    for (let attempt = 0; attempt < 3 && !map; attempt++) {
      try { map = await resolveTitles(batch); }
      catch { await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1))); }
    }
    if (map) for (const [title, qid] of map) resolved.set(title, qid);
    process.stdout.write(`\r  resolved ${Math.min(pending.length, i + 50)}/${pending.length}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write("\n");

  const byQid = indexChineseCandidates(entries, resolved);
  await mkdir(join(ROOT, ".cache"), { recursive: true });
  await writeFile(OUT, JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), entries, pairs: [...resolved], byQid }, null, 0));
  console.log(`wrote ${Object.keys(byQid).length} QIDs to ${OUT}`);

}

main().catch((error) => { console.error(error); process.exit(1); });
