import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import OpenCC from "opencc-js";
import { englishDaySource, eventId, hashText, indexChineseCandidates, parseChineseDay, summaryTitle, translatedDescription, validateFeed } from "../scripts/event-records.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const hasChinese = (value) => typeof value === "string" && /\p{Script=Han}/u.test(value);

async function loadShards(directory, kind) {
  return (await Promise.all((await readdir(join(directory, kind))).filter((file) => file.endsWith(".json")).map(async (file) => {
    const rows = JSON.parse(await readFile(join(directory, kind, file), "utf8"));
    for (const row of rows) {
      const key = kind === "year" ? String(row.y) : `${String(row.m).padStart(2, "0")}-${String(row.day).padStart(2, "0")}`;
      assert.equal(file, `${key}.json`);
    }
    return rows;
  }))).flat();
}

function assertCatalogTranslations(rows, catalog) {
  assert.ok(catalog.manual && typeof catalog.manual === "object" && !Array.isArray(catalog.manual), "catalog must contain manual translations");
  assert.ok(catalog.machine && typeof catalog.machine === "object" && !Array.isArray(catalog.machine), "catalog must contain machine translations");
  for (const row of rows) {
    const hash = hashText(row.de);
    const manual = catalog.manual[hash];
    const machine = catalog.machine[hash];
    const source = hasChinese(manual) ? "manual" : "mt";
    const translation = source === "manual" ? manual : machine;
    assert.ok(hasChinese(translation), `${row.id}: catalog is missing the exact English sentence's translation (${hash})`);
    const simplified = toSimplified(translation.trim());
    const description = simplified.length > 500 ? `${simplified.slice(0, 499)}…` : simplified;
    assert.ok(hasChinese(row.t), `${row.id}: published title must contain Chinese`);
    assert.ok(hasChinese(row.dz), `${row.id}: published description must contain Chinese`);
    assert.equal(row.dz, description, `${row.id}: published description must match the versioned catalog`);
    assert.equal(row.t, summaryTitle(description, 48), `${row.id}: published title must come from its own translated description`);
    assert.equal(row.dzSrc, source, `${row.id}: manual translations must take precedence and provenance must remain accurate`);
  }
}

function assertChineseManifest(rows, manifest) {
  const titles = rows.filter((row) => hasChinese(row.t)).length;
  const descriptions = rows.filter((row) => hasChinese(row.dz)).length;
  const sources = { manual: 0, mt: 0, untranslated: 0 };
  for (const row of rows) {
    const source = row.dzSrc ?? "untranslated";
    assert.ok(Object.hasOwn(sources, source), `${row.id}: unknown translation provenance`);
    sources[source] += 1;
  }
  assert.equal(manifest.events, rows.length);
  assert.equal(manifest.withChineseTitle, titles);
  assert.equal(manifest.withChineseDescription, descriptions);
  assert.deepEqual(manifest.chineseDescriptionSources, sources);
  assert.equal(titles, rows.length, "every event must have a Chinese title");
  assert.equal(descriptions, rows.length, "every event must have a Chinese description");
  assert.equal(sources.untranslated, 0);
}

test("a shared entity cannot substitute a Chinese description for another event", () => {
  const source = "Vietnam War: American forces launch an operation during the siege of Plei Me.";
  const unrelated = "越南战争：在美国军事支援下，南越军队入侵老挝。";
  assert.deepEqual(translatedDescription(source, { Q8740: unrelated }, { Q8740: unrelated }), { text: null, source: null });
  assert.deepEqual(translatedDescription(source, {}, { [hashText("A different event")]: unrelated }), { text: null, source: null });
  assert.deepEqual(translatedDescription(source, { [hashText(source)]: "围城期间发动行动。" }, { [hashText(source)]: "机器译文。" }), { text: "围城期间发动行动。", source: "manual" });
});

test("day sources use English month names, including leap day", () => {
  assert.equal(englishDaySource(10, 23), "https://en.wikipedia.org/wiki/October_23#Events");
  assert.equal(englishDaySource(2, 29), "https://en.wikipedia.org/wiki/February_29#Events");
  assert.throws(() => englishDaySource(2, 30), /Invalid calendar day/);
});

test("IDs distinguish different events on the same date with a common topic", () => {
  const base = { year: 1945, month: 4, day: 4, titleQid: "Q362" };
  const first = { ...base, text: "World War II: United States Army troops capture Kassel." };
  const second = { ...base, text: "World War II: United States Army troops liberate Ohrdruf forced labor camp in Germany." };
  assert.notEqual(eventId(first), eventId(second));
  assert.equal(eventId(first), eventId({ ...first, titleQid: "Q245743" }));
});

test("titles describe the event rather than only its topic or first clause", () => {
  assert.equal(summaryTitle("World War II: United States Army troops capture Kassel."), "United States Army troops capture Kassel.");
  assert.match(summaryTitle("气压：一个气压系统造成严重风暴。"), /造成严重风暴/);
  assert.match(summaryTitle("Vietnam War: The 1st Cavalry Division (Airmobile), in conjunction with the Army of the Republic of Vietnam, launches an operation seeking to destroy Communist forces during the siege of Plei Me."), /launches/);
  assert.match(summaryTitle("二战：亨利·菲利普·贝当元帅出任维希法国国家元首（法语：Chef de l’État Français）。", 48), /^亨利/);
  assert.match(summaryTitle("70米口径的雷达向五颗恒星发送信息（宇宙呼叫2）：Hip 4872, HD 245409, ...", 48), /^70米/);
});

test("Chinese candidates preserve all dates and source pages; links resolve targets instead of display labels", () => {
  const entries = parseChineseDay("== 大事记 ==\n* [[1965年]]：[[越南战争|战争]]中的围城行动。\n* [[1971年]]：[[越南战争]]中的另一行动。\n== 出生 ==\n* [[1980年]]：[[某人]]出生。", 10, 23);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].links[0], "越南战争");
  const candidates = indexChineseCandidates(entries, new Map([["越南战争", "Q8740"]]));
  assert.equal(candidates.Q8740.length, 2);
  assert.deepEqual(candidates.Q8740.map(({ y, m, day, s }) => ({ y, m, day, s })), [1965, 1971].map((y) => ({ y, m: 10, day: 23, s: "https://zh.wikipedia.org/wiki/10月23日" })));
});

test("invalid or missing feeds fail rather than silently producing incomplete data", () => {
  for (const value of [undefined, {}, { error: "upstream unavailable" }, { events: [] }, { events: [{}] }]) {
    assert.throws(() => validateFeed(value, "01-01"), /Missing or invalid event feed/);
  }
});

test("offline build with a missing feed fails without replacing existing output", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "atlas-offline-"));
  try {
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, "public/data/events"), { recursive: true });
    await Promise.all(["build-events.mjs", "event-records.mjs"].map((file) => copyFile(join(root, "scripts", file), join(fixture, "scripts", file))));
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    const manifest = join(fixture, "public/data/events/manifest.json");
    await writeFile(manifest, "existing published data");
    const result = spawnSync(process.execPath, [join(fixture, "scripts/build-events.mjs"), "--offline"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Offline build requires a valid cached feed/);
    assert.equal(await readFile(manifest, "utf8"), "existing published data");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("published year/day shards agree and preserve unique IDs, sources and translation provenance", async () => {
  const directory = join(root, "public/data/events");
  const [years, days] = await Promise.all([loadShards(directory, "year"), loadShards(directory, "day")]);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(years.length, manifest.events);
  assert.equal(new Set(years.map((row) => row.id)).size, years.length, "event IDs must be unique");
  const byId = (a, b) => a.id.localeCompare(b.id);
  assert.deepEqual(years.sort(byId), days.sort(byId));
  for (const row of years) {
    assert.equal(row.s, englishDaySource(row.m, row.day));
    assert.ok([null, "manual", "mt"].includes(row.dzSrc));
    assert.equal(Boolean(row.dz), Boolean(row.dzSrc));
    assert.equal(row.t, row.dz ? summaryTitle(row.dz, 48) : null);
    assert.ok(row.w === null || (Number.isFinite(row.w) && row.w >= 0));
  }
  const pleiMe = years.find((row) => row.y === 1965 && row.m === 10 && row.day === 23 && row.de.includes("Plei Me"));
  assert.ok(pleiMe, "historical regression sample exists");
  assert.notEqual(pleiMe.dz, "越南战争：在美国军事支援下，南越军队入侵老挝。", "1971 text must not be attached to the 1965 event");
});


test("the versioned catalog covers every published translation and the manifest reports exact Chinese totals", async () => {
  const directory = join(root, "public/data/events");
  const [rows, catalogText, manifestText] = await Promise.all([
    loadShards(directory, "year"),
    readFile(join(root, "data/translations/zh-Hans.json"), "utf8"),
    readFile(join(directory, "manifest.json"), "utf8"),
  ]);
  assertCatalogTranslations(rows, JSON.parse(catalogText));
  assertChineseManifest(rows, JSON.parse(manifestText));
});

test("an offline build restores all published translations from the catalog without local translation caches", async (t) => {
  const sourceFeeds = join(root, ".cache/feeds/en");
  try { await readdir(sourceFeeds); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("Full offline rebuild requires the optional cached English feeds; published catalog coverage is checked separately.");
    return;
  }
  const fixture = await mkdtemp(join(tmpdir(), "atlas-catalog-build-"));
  try {
    await Promise.all([
      mkdir(join(fixture, "scripts")),
      mkdir(join(fixture, ".cache/feeds"), { recursive: true }),
      mkdir(join(fixture, "data/translations"), { recursive: true }),
      mkdir(join(fixture, "public/data"), { recursive: true }),
    ]);
    await Promise.all([
      ...["build-events.mjs", "event-records.mjs"].map((file) => copyFile(join(root, "scripts", file), join(fixture, "scripts", file))),
      copyFile(join(root, "data/translations/zh-Hans.json"), join(fixture, "data/translations/zh-Hans.json")),
      symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir"),
      symlink(sourceFeeds, join(fixture, ".cache/feeds/en"), "dir"),
      symlink(join(root, "public/data/countries.geojson"), join(fixture, "public/data/countries.geojson"), "file"),
    ]);
    assert.deepEqual(await readdir(join(fixture, ".cache")), ["feeds"], "fixture must not inherit translation caches");
    const result = spawnSync(process.execPath, [join(fixture, "scripts/build-events.mjs"), "--offline"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(await readdir(join(fixture, ".cache")), ["feeds"], "catalog rebuild must not require or create translation caches");

    const published = join(root, "public/data/events");
    const rebuilt = join(fixture, "public/data/events");
    for (const kind of ["year", "day"]) {
      const [expected, actual] = await Promise.all([loadShards(published, kind), loadShards(rebuilt, kind)]);
      const byId = (a, b) => a.id.localeCompare(b.id);
      assert.deepEqual(actual.sort(byId), expected.sort(byId), `${kind} shards must be reproducible with only the versioned catalog`);
    }
    const [rows, catalogText, manifestText, publishedManifestText] = await Promise.all([
      loadShards(rebuilt, "year"),
      readFile(join(fixture, "data/translations/zh-Hans.json"), "utf8"),
      readFile(join(rebuilt, "manifest.json"), "utf8"),
      readFile(join(published, "manifest.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);
    const publishedManifest = JSON.parse(publishedManifestText);
    assertCatalogTranslations(rows, JSON.parse(catalogText));
    assertChineseManifest(rows, manifest);
    delete manifest.generatedAt;
    delete publishedManifest.generatedAt;
    assert.deepEqual(manifest, publishedManifest, "the rebuilt manifest must match all published counts and byte totals");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
