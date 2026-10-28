import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eventsForRegion, loadDay, loadDecade, loadEventScope, loadYear, resolveScope, toAtlasEvent } from "../app/events-db.ts";

const record = { id: "event", t: "中文事件标题", te: "English title", dz: null, dzSrc: null, de: "The event's English description.", y: 1965, m: 10, day: 23, lat: null, lng: null, c: null, p: null, w: null, q: null, s: "https://en.wikipedia.org/wiki/October_23#Events" };
const unexpected = async () => { throw new Error("Inactive request must not run"); };

test("today mode never starts a year request", async () => {
  const result = await loadEventScope({ mode: "today", month: 10, day: 23 }, {
    loadDay: async (month, day) => { assert.deepEqual([month, day], [10, 23]); return [record]; },
    loadYear: unexpected, loadDecade: unexpected,
  });
  assert.deepEqual(result, { day: [record], year: [], decade: [] });
});

test("year mode ignores cached today data and waits for the active response", async () => {
  let finish;
  const request = new Promise(resolve => { finish = resolve; });
  let settled = false;
  const pending = loadEventScope({ mode: "timeline", year: 1965 }, {
    loadDay: unexpected, loadYear: () => request, loadDecade: unexpected,
  }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish([record]);
  assert.deepEqual(await pending, { day: [], year: [record], decade: [] });
});

test("a failed decade fallback rejects instead of claiming there are no records", async () => {
  await assert.rejects(loadEventScope({ mode: "timeline", year: 500 }, {
    loadDay: unexpected, loadYear: async () => [], loadDecade: async () => { throw new Error("Unavailable"); },
  }), /Unavailable/);
});

test("a requested regional decade must finish even when the global year has records", async () => {
  await assert.rejects(loadEventScope({ mode: "timeline", year: 1965, includeDecade: true }, {
    loadDay: unexpected, loadYear: async () => [record], loadDecade: async () => { throw new Error("Unavailable"); },
  }), /Unavailable/);
});

test("China in 1977 expands past a populated global year to the 1976 Tangshan earthquake, reusing year shards", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async path => {
    requests.push(path);
    assert.match(path, /^\/data\/events\/year\/197\d\.json$/);
    const body = await readFile(new URL(`../public${path}`, import.meta.url), "utf8");
    return new Response(body);
  });
  const query = { mode: "timeline", year: 1977 };
  const global = await loadEventScope(query);
  assert.ok(global.year.length > 0);
  assert.equal(eventsForRegion(global.year.map(event => toAtlasEvent(event)), "CHN").length, 0);
  assert.deepEqual(global.decade, []);
  assert.equal(requests.length, 1);

  const regional = await loadEventScope({ ...query, includeDecade: true });
  const china = resolveScope("day", { year: 1977, month: 10, day: 23 }, {
    year: eventsForRegion(regional.year.map(event => toAtlasEvent(event)), "CHN"),
    decade: eventsForRegion(regional.decade.map(event => toAtlasEvent(event)), "CHN"),
  });
  assert.equal(china.tier, "decade");
  assert.ok(china.events.some(event => event.historical.year === 1976 && /Tangshan/.test(event.originalSummary)));
  assert.equal(requests.length, 10);
  assert.equal(new Set(requests).size, 10);

  await loadEventScope({ ...query, includeDecade: true });
  await loadEventScope({ mode: "timeline", year: 1978, includeDecade: true });
  assert.equal(requests.length, 10, "changing regions or years in this decade reuses the loaded shards");
});

test("only missing year shards are empty; server errors and missing daily shards remain retryable", async t => {
  t.mock.method(globalThis, "fetch", async path => {
    if (path.endsWith("/123.json")) return new Response("", { status: 404 });
    return new Response("", { status: 503 });
  });
  assert.deepEqual(await loadYear(123), []);
  await assert.rejects(loadDay(12, 31), /503/);
  await assert.rejects(loadDecade(730), /503/);
  globalThis.fetch.mock.mockImplementation(async () => new Response("", { status: 404 }));
  await assert.rejects(loadDay(12, 31), /404/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json([record]));
  assert.deepEqual(await loadDay(12, 31), [record]);
});

test("description language and provenance are independent of title language", () => {
  const english = toAtlasEvent(record, "zh");
  assert.equal(english.textLocale, "en");
  assert.equal(english.summarySource, "original");
  assert.equal(english.importance, undefined);
  const chinese = toAtlasEvent({ ...record, t: null, dz: "同一事件的中文译文。", dzSrc: "mt" }, "zh");
  assert.equal(chinese.textLocale, "zh");
  assert.equal(chinese.summarySource, "mt");
  assert.equal(chinese.originalSummary, record.de);
  assert.equal(toAtlasEvent({ ...record, dz: "译文", dzSrc: "mt" }, "en").summarySource, "original");
});

test("region list and counts derive from the same normalized country filter", () => {
  const events = ["VNM", "CHN", "TWN", "", "USA"].map((c, i) => toAtlasEvent({ ...record, id: String(i), c }));
  assert.equal(eventsForRegion(events, null).length, 5);
  assert.equal(eventsForRegion(events, "VNM").length, 1);
  assert.equal(eventsForRegion(events, "CAN").length, 0);
  assert.equal(eventsForRegion(events, "CHN").length, 2);
});

test("empty dates expand to the first recorded scope, never to a finer scope", () => {
  const event = toAtlasEvent(record);
  const point = { year: 1965, month: 10, day: 22 };
  assert.equal(resolveScope("day", point, { year: [event], decade: [] }).tier, "month");
  assert.equal(resolveScope("year", point, { year: [event], decade: [] }).tier, "year");
  assert.equal(resolveScope("year", { ...point, year: 1964 }, { year: [], decade: [event] }).tier, "decade");
});
