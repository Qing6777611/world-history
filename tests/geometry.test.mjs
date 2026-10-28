import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { countryView } from "../app/country-geometry.ts";

const rectangle = (west, south, east, north) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const feature = (parts) => ({ properties: {}, geometry: { type: "MultiPolygon", coordinates: parts } });
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: ${actual} vs ${expected}`);

test("country camera joins nearby islands across the 180° meridian", () => {
  const islands = feature([
    [rectangle(178, -1, 179, 1)],
    [rectangle(-179, -1, -178, 1)],
    [rectangle(0, 0, 0.2, 0.2)],
  ]);
  const view = countryView(islands, 1.4, 50, { lng: 178.5, lat: 0 }, 0.025, 3);
  close(view.lng, -180, "dateline-centered longitude");
  close(view.lat, 0, "latitude");
  assert.ok(view.altitude < 0.2, "camera should frame the dateline islands, not half the planet");
});

test("default view fits the mainland, while a click selects a distant island and its neighbors", () => {
  const country = feature([
    [rectangle(0, 0, 10, 10)],
    [rectangle(70, 0, 72, 2)],
    [rectangle(72.1, 0, 73.1, 1)],
  ]);
  const mainland = countryView(country, 1.4, 50, undefined, 0.025, 0.2);
  close(mainland.lng, 5, "mainland longitude");
  close(mainland.lat, 5, "mainland latitude");
  const island = countryView(country, 1.4, 50, { lng: 71, lat: 1 }, 0.025, 0.2);
  close(island.lng, 71.55, "remote island group longitude");
  close(island.lat, 1, "remote island group latitude");
  assert.ok(island.altitude < mainland.altitude);
});

test("nearby island membership is transitive and does not discard small connecting islands", () => {
  const country = feature([
    [rectangle(0, 0, 1, 1)],
    [rectangle(1.1, 0, 2.1, 1)],
    [rectangle(2.2, 0, 3.2, 1)],
  ]);
  const point = { lng: 0.5, lat: 0.5 };
  const joined = countryView(country, 1.4, 50, point, 0.025, 0.2);
  close(joined.lng, 1.6, "all three islands are included through the middle island");
  const isolated = countryView(country, 1.4, 50, point, 0.025, 0.05);
  close(isolated.lng, 0.5, "different distance threshold uses a different island group");
  assert.deepEqual(countryView(country, 1.4, 50, point, 0.025, 0.2), joined);
});

test("clicks inside a polygon hole select the island in the hole or fall back to the mainland", () => {
  const island = [rectangle(-1, -1, 1, 1)];
  const country = feature([
    [rectangle(50, 0, 70, 20)],
    [rectangle(-5, -5, 5, 5), rectangle(-2, -2, 2, 2)],
    island,
  ]);
  const actual = countryView(country, 1.4, 50, { lng: 0, lat: 0 }, 0.025, 0.1);
  assert.deepEqual(actual, countryView(feature([island]), 1.4, 50, undefined, 0.025, 0.1));
  const hole = countryView(country, 1.4, 50, { lng: 1.5, lat: 1.5 }, 0.025, 0.1);
  close(hole.lng, 60, "unoccupied hole falls back to largest landmass");
  close(hole.lat, 10, "mainland latitude");
});

test("spherical distances join polar islands despite a large longitude difference", () => {
  const country = feature([
    [rectangle(0, 89, 1, 89.1)],
    [rectangle(30, 89, 31, 89.1)],
  ]);
  const view = countryView(country, 1.4, 50, { lng: 0.5, lat: 89.05 }, 0.025, 0.6);
  close(view.lng, 15.5, "both polar islands fit in the view");
});

test("cached landmass bounds still adapt to camera aspect, field of view, and minimum altitude", () => {
  const country = feature([[rectangle(-20, -5, 20, 5)]]);
  const wide = countryView(country, 2, 50, undefined, 0.025);
  const narrow = countryView(country, 0.5, 50, undefined, 0.025);
  const zoomed = countryView(country, 2, 30, undefined, 0.025);
  assert.ok(narrow.altitude > wide.altitude);
  assert.ok(zoomed.altitude > wide.altitude);
  close(countryView(country, 2, 50, undefined, 2).altitude, 2, "minimum altitude");
});

test("real Nunavut and Alaska keep the previous framing without multi-second coastline scans", (t) => {
  const cases = [
    { code: "CAN", name: "努纳武特", expected: { lat: 67.08905, lng: -90.97415000000001, altitude: 0.559738823608702 } },
    { code: "USA", name: "阿拉斯加州", expected: { lat: 62.902249999999995, lng: -149.06330000000003, altitude: 0.5533809007801471 } },
  ];
  for (const { code, name, expected } of cases) {
    const data = JSON.parse(readFileSync(new URL(`../public/data/boundaries/${code}.json`, import.meta.url), "utf8"));
    const region = data.features.find(item => item.properties.name === name);
    assert.ok(region, `${name} fixture exists`);
    const start = performance.now();
    const actual = countryView(region, 1.4, 50, undefined, 0.025, 0.18);
    const elapsed = performance.now() - start;
    for (const field of ["lat", "lng", "altitude"]) close(actual[field], expected[field], `${name} ${field}`);
    // Cold geometry, including index construction. This intentionally generous
    // CI budget catches the former ~5 s regression without requiring a fast CPU.
    assert.ok(elapsed < 500, `${name} cold fit took ${elapsed.toFixed(1)} ms; expected <500 ms`);
    t.diagnostic(`${name}: cold fit ${elapsed.toFixed(2)} ms`);
    assert.deepEqual(countryView(region, 1.4, 50, undefined, 0.025, 0.18), actual);
  }
});
