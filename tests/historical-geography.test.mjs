import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHistoricalGeographyLoader,
  historicalEventsForRegion,
  historicalPolityName,
  historicalRegion,
  mapHistoricalEvents,
} from "../app/historical-geography.ts";

const square = (lng = 0) => ({ type: "Polygon", coordinates: [[[lng, 0], [lng + 2, 0], [lng + 2, 2], [lng, 2], [lng, 0]]] });
const feature = (polityId, from, to, lng = 0) => ({
  type: "Feature", properties: { polityId, from, to, type: "POLITY", memberOf: [], components: [] }, geometry: square(lng),
});
const collection = (...features) => ({ type: "FeatureCollection", features });
const polity = (id, nameEn, nameZh, from = -2, to = 3, type = "POLITY") => ({ id, nameEn, nameZh, from, to, type, wikidataIds: [], wikipedia: [] });
const manifest = {
  schemaVersion: 1,
  minYear: -2, maxYear: 3,
  source: { name: "Test historical source", url: "https://example.test/history", version: "test", commit: "test", sha256: "test" },
  license: { name: "Test license", url: "https://example.test/license" },
  polities: [polity("hist-a", "Polity A", "甲政权"), polity("hist-b", "Polity B", "乙政权"), polity("hist-union", "Union", "联盟", -2, 3, "RELATION")],
  chunks: [{ from: -2, to: 3, path: "chunks/test.json" }],
};
const shapes = collection(feature("hist-a", -2, -1), feature("hist-a", 1, 1, 20), feature("hist-b", 1, 2));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const resources = {
    "/data/history/manifest.json": manifest,
    "/data/history/chunks/test.json": shapes,
    "/data/history/event-polities.json": { old: ["hist-a", "hist-union"], later: ["hist-b"] },
    ...overrides,
  };
  const loader = createHistoricalGeographyLoader({
    fetcher: async (url) => {
      calls.push(url);
      const value = resources[url];
      return typeof value === "function" ? value() : response(value ?? {}, value === undefined ? 404 : 200);
    },
    ...options,
  });
  return { ...loader, calls, resources };
}

test("historical coverage endpoints are inclusive and BCE does not introduce a year zero", async () => {
  const api = fixture();
  const earliest = await api.loadHistoricalYear(-2);
  assert.equal(earliest.status, "ready");
  assert.equal(earliest.features[0].properties.HISTORY_ID, "hist-a");
  assert.equal(earliest.features[0].properties.FROM_YEAR, "-2");
  assert.equal(earliest.features[0].properties.TO_YEAR, "-1");
  const lastBCE = await api.loadHistoricalYear(-1);
  const firstCE = await api.loadHistoricalYear(1);
  assert.equal(lastBCE.features.length, 1);
  assert.equal(firstCE.features.length, 2);
  assert.deepEqual(firstCE.features[0].geometry, square(20));
  assert.deepEqual(lastBCE.features[0].geometry, square(0), "a later boundary must not mutate an earlier snapshot");
  assert.equal((await api.loadHistoricalYear(3)).status, "ready");
  assert.deepEqual(api.calls, ["/data/history/manifest.json", "/data/history/chunks/test.json"]);
});

test("year zero, fractional and non-finite years are unavailable without any request", async () => {
  const api = fixture();
  for (const year of [0, 1.5, NaN, Infinity, -Infinity]) {
    const snapshot = await api.loadHistoricalYear(year);
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.reason, "invalid-year");
    assert.equal(snapshot.manifest, null);
    assert.deepEqual(snapshot.features, []);
  }
  assert.deepEqual(api.calls, []);
});

test("out-of-coverage years are unavailable and never request neighbouring or modern geometry", async () => {
  const api = fixture();
  for (const year of [-3, 4]) {
    const snapshot = await api.loadHistoricalYear(year);
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.reason, "out-of-range");
    assert.equal(snapshot.manifest.minYear, -2);
    assert.deepEqual(snapshot.features, []);
  }
  assert.deepEqual(api.calls, ["/data/history/manifest.json"]);
});

test("a covered year with no recorded polygons is ready and empty", async () => {
  const api = fixture();
  const snapshot = await api.loadHistoricalYear(3);
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.features, []);
  assert.equal(snapshot.year, 3);
});

test("concurrent nearby years share a chunk and retain stable historical identities", async () => {
  const api = fixture();
  const [first, second] = await Promise.all([api.loadHistoricalYear(-2), api.loadHistoricalYear(-1)]);
  assert.equal(api.calls.filter(path => path.endsWith("test.json")).length, 1);
  assert.equal(first.features[0].properties.ADM0_A3, second.features[0].properties.ADM0_A3);
  assert.equal(first.features[0].properties.ISO_A3_EH, undefined);
  assert.deepEqual(historicalRegion(first.features[0]), { code: "hist-a", name: "甲政权" });
  assert.deepEqual(historicalRegion(first.features[0], "en"), { code: "hist-a", name: "Polity A" });
});

test("simultaneously active records for one polity merge into one feature without widening their intervals", async () => {
  const first = feature("hist-a", -2, 2);
  first.properties.components = ["component-a", "component-shared"];
  first.properties.memberOf = ["union-a", "union-shared"];
  const second = feature("hist-a", 1, 3, 20);
  second.properties.components = ["component-shared", "component-b"];
  second.properties.memberOf = ["union-shared", "union-b"];
  const api = fixture({ "/data/history/chunks/test.json": collection(first, second) });
  const earlier = await api.loadHistoricalYear(-1);
  const combined = await api.loadHistoricalYear(1);
  assert.equal(combined.features.length, 1);
  const merged = combined.features[0];
  assert.equal(merged.properties.HISTORY_ID, "hist-a");
  assert.equal(merged.geometry.type, "MultiPolygon");
  assert.deepEqual(merged.geometry.coordinates, [square(0).coordinates, square(20).coordinates]);
  assert.equal(merged.properties.FROM_YEAR, "1");
  assert.equal(merged.properties.TO_YEAR, "2");
  assert.deepEqual(JSON.parse(merged.properties.HISTORY_INTERVALS), [{ from: -2, to: 2 }, { from: 1, to: 3 }]);
  assert.deepEqual(JSON.parse(merged.properties.HISTORY_COMPONENTS), ["component-a", "component-shared", "component-b"]);
  assert.deepEqual(JSON.parse(merged.properties.HISTORY_MEMBER_OF), ["union-a", "union-shared", "union-b"]);
  assert.deepEqual(JSON.parse(earlier.features[0].properties.HISTORY_COMPONENTS), first.properties.components);
  assert.deepEqual(JSON.parse(earlier.features[0].properties.HISTORY_MEMBER_OF), first.properties.memberOf);
  assert.deepEqual(earlier.features[0].geometry, square(0));
});

test("composite membership survives a source POLITY type without reclassifying it", async () => {
  const composite = feature("hist-a", 1, 2);
  composite.properties.components = ["hist-b"];
  composite.properties.memberOf = ["hist-union"];
  const api = fixture({ "/data/history/chunks/test.json": collection(composite, feature("hist-b", 1, 2)) });
  const snapshot = await api.loadHistoricalYear(1);
  const rendered = snapshot.features.find(item => item.properties.HISTORY_ID === "hist-a");
  assert.equal(rendered.properties.HISTORY_TYPE, "POLITY");
  assert.deepEqual(JSON.parse(rendered.properties.HISTORY_COMPONENTS), ["hist-b"]);
  assert.deepEqual(JSON.parse(rendered.properties.HISTORY_MEMBER_OF), ["hist-union"]);
  assert.equal(snapshot.features[1].properties.HISTORY_COMPONENTS, "[]");
  assert.equal(snapshot.features[1].properties.HISTORY_MEMBER_OF, "[]");
});

test("failed manifest, geometry and event-index requests are retried", async () => {
  const api = fixture();
  api.resources["/data/history/manifest.json"] = () => response({}, 503);
  await assert.rejects(api.loadHistoricalYear(1), /503/);
  api.resources["/data/history/manifest.json"] = manifest;
  api.resources["/data/history/chunks/test.json"] = () => response({}, 404);
  await assert.rejects(api.loadHistoricalYear(1), /404/);
  api.resources["/data/history/chunks/test.json"] = shapes;
  assert.equal((await api.loadHistoricalYear(1)).status, "ready");
  api.resources["/data/history/event-polities.json"] = () => response({}, 503);
  await assert.rejects(api.loadHistoricalEventIndex(), /503/);
  api.resources["/data/history/event-polities.json"] = { old: ["hist-a"] };
  assert.deepEqual(await api.loadHistoricalEventIndex(), { old: ["hist-a"] });
  assert.equal(api.calls.filter(path => path.endsWith("manifest.json")).length, 2);
  assert.equal(api.calls.filter(path => path.endsWith("test.json")).length, 2);
  assert.equal(api.calls.filter(path => path.endsWith("event-polities.json")).length, 2);
});

test("invalid loaded data is rejected and does not poison the cache", async () => {
  const api = fixture({ "/data/history/chunks/test.json": { type: "FeatureCollection", features: [feature("hist-a", 0, 1)] } });
  await assert.rejects(api.loadHistoricalYear(1), /几何格式无效/);
  api.resources["/data/history/chunks/test.json"] = shapes;
  assert.equal((await api.loadHistoricalYear(1)).features.length, 2);
  api.resources["/data/history/event-polities.json"] = { old: "hist-a" };
  await assert.rejects(api.loadHistoricalEventIndex(), /索引格式无效/);
  api.resources["/data/history/event-polities.json"] = { old: [] };
  assert.deepEqual(await api.loadHistoricalEventIndex(), { old: [] });
});

test("chunk caching is bounded and evicts the least recently used chunk", async () => {
  const chunks = [1, 2, 3].map(year => ({ from: year, to: year, path: `chunks/${year}.json` }));
  const api = fixture({
    "/data/history/manifest.json": { ...manifest, chunks },
    ...Object.fromEntries(chunks.map(chunk => [`/data/history/${chunk.path}`, collection(feature("hist-a", chunk.from, chunk.to))])),
  }, { maxChunks: 2 });
  for (const year of [1, 2, 1, 3, 1, 2]) await api.loadHistoricalYear(year);
  assert.equal(api.calls.filter(path => path.endsWith("/1.json")).length, 1);
  assert.equal(api.calls.filter(path => path.endsWith("/2.json")).length, 2);
  assert.equal(api.calls.filter(path => path.endsWith("/3.json")).length, 1);
});

const event = (id, year, extra = {}) => ({
  id, title: id, location: "Recorded place", region: "", country: "CHN", lat: 1, lng: 1,
  start: year, end: year, category: "社会", summary: id, color: "#abc",
  historical: { year, month: 1, day: 1, sourceUrl: "https://example.test/event" },
  ...extra,
});

test("event membership uses each event's indexed year even when the same polity changes territory", async () => {
  const api = fixture();
  const index = await api.loadHistoricalEventIndex();
  const laterSnapshot = await api.loadHistoricalYear(1);
  const originals = [Object.freeze(event("old", -1)), Object.freeze(event("later", 1))];
  const mapped = mapHistoricalEvents(originals, index, laterSnapshot.manifest);
  assert.equal(mapped[0].country, "hist-a");
  assert.equal(mapped[1].country, "hist-b", "the same coordinate belonged to a different polity in the later event's year");
  assert.deepEqual(mapped[0].polityIds, ["hist-a", "hist-union"]);
  assert.equal(mapped[0].modernCountry, "CHN");
  assert.equal(mapped[0].region, "甲政权");
  assert.equal(originals[0].country, "CHN");
  assert.equal(originals[0].polityIds, undefined);
  assert.notEqual(mapped[0], originals[0]);
  assert.notEqual(mapped[0].polityIds, index.old);
  assert.deepEqual(historicalEventsForRegion(mapped, "hist-union").map(row => row.id), ["old"]);
  assert.deepEqual(historicalEventsForRegion(mapped, "hist-b").map(row => row.id), ["later"]);
  assert.equal(historicalEventsForRegion(mapped, null), mapped);
  const remapped = mapHistoricalEvents(mapped, index, manifest, "en");
  assert.equal(remapped[0].modernCountry, "CHN", "changing locale must not overwrite the original modern country");
  assert.equal(remapped[0].region, "Polity A");
});

test("unlocated, unindexed, invalid-year and out-of-range events are not guessed from modern countries", () => {
  const rows = [
    event("no-point", 1, { lat: undefined, lng: undefined }),
    event("bad-point", 1, { lat: 91 }),
    event("unindexed", 1),
    event("zero", 0),
    event("outside", 4),
    event("unknown-polity", 1),
  ];
  const index = Object.fromEntries(rows.map(row => [row.id, ["hist-a"]]));
  delete index.unindexed;
  index["unknown-polity"] = ["missing-id"];
  for (const row of mapHistoricalEvents(rows, index, manifest)) {
    assert.equal(row.country, "");
    assert.equal(row.region, "");
    assert.equal(row.modernCountry, "CHN");
    assert.deepEqual(row.polityIds, []);
  }
});

test("localization falls back to the recorded name without inventing a translation", () => {
  const untranslated = { ...manifest, polities: [polity("hist-x", "Untranslated Polity", "")] };
  assert.equal(historicalPolityName("hist-x", untranslated, "zh"), "Untranslated Polity");
  assert.equal(historicalPolityName("unknown", untranslated, "zh"), "unknown");
});
