import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  atlasCountries, countryCode, countryPalette, countryRegion, countryView, countryViewportView,
  historicalPickFeature, historicalSurfaceAltitude, isHistoricalComposite,
  isLandBackground, landBackground, orientHistoricalFeatures,
} from "../app/country-geometry.ts";
import { eventMatchesCountry, historicalEventBubbles } from "../app/globe-bubbles.ts";
import { createHistoricalGeographyLoader } from "../app/historical-geography.ts";

const square = (west = 0, east = 4) => [[west, 0], [east, 0], [east, 4], [west, 4], [west, 0]];
const polity = (id, rings = [square()]) => ({
  properties: { ADM0_A3: id, HISTORY_ID: id, NAME_EN: `Polity ${id}`, NAME_ZH: `${id}政权`, FROM_YEAR: "-10", TO_YEAR: "100" },
  geometry: { type: "Polygon", coordinates: rings },
});
const event = (id, country = "a", extra = {}) => ({
  id, title: `Event ${id}`, location: `Place ${id}`, country, polityIds: [country],
  lat: 1, lng: 1, start: 50, end: 50, ...extra,
});
function signedArea(ring) {
  let previous = ring[0][0];
  const points = ring.map(([lng, lat]) => {
    previous += ((lng - previous + 180) % 360 + 360) % 360 - 180;
    return [previous, lat];
  });
  return points.slice(0, -1).reduce((sum, [x, y], i) => sum + x * points[i + 1][1] - points[i + 1][0] * y, 0);
}

test("historical identity, names and country merging stay independent of modern aliases", () => {
  const a = polity("CHN"), b = polity("TWN");
  a.properties.ISO_A3_EH = "OTHER";
  assert.equal(countryCode(a), "CHN");
  assert.deepEqual(countryRegion(a), { code: "CHN", name: "CHN政权" });
  assert.deepEqual(countryRegion(a, "en"), { code: "CHN", name: "Polity CHN" });
  assert.deepEqual(atlasCountries([a, b]), [a, b]);
  const modernChina = { ...a, properties: { ADM0_A3: "CHN", NAME_EN: "China", NAME_ZH: "中华人民共和国" } };
  const modernTaiwan = { ...b, properties: { ADM0_A3: "TWN", NAME_EN: "Taiwan" } };
  assert.equal(countryRegion(modernChina).name, "中国");
  assert.equal(countryRegion(modernChina, "en").name, "China");
  assert.equal(atlasCountries([modernChina, modernTaiwan]).length, 1);
});

test("historical render orientation preserves holes, dateline islands and immutable cached source", () => {
  const outer = square(178, -178);
  const hole = [[179, 1], [179, 2], [-179, 2], [-179, 1], [179, 1]];
  const source = polity("dateline", [outer, hole]);
  const before = structuredClone(source);
  const [rendered] = orientHistoricalFeatures([source]);
  const [exterior, interior] = rendered.geometry.coordinates[0];
  assert.ok(signedArea(exterior) < 0, "Globe.GL exterior is clockwise after unwrapping");
  assert.ok(signedArea(interior) > 0, "hole is counterclockwise");
  assert.deepEqual(source, before, "loader cache retains RFC7946 geometry");
  assert.equal(orientHistoricalFeatures([source])[0].geometry, rendered.geometry, "repeated snapshots reuse orientation work");
  assert.deepEqual(countryView(rendered, 1, 50), countryView(source, 1, 50), "orientation does not change camera fitting");
});

test("already oriented historical polygons do not reverse again and colors stay stable across years", () => {
  const a = polity("a", [square().reverse()]), b = polity("b");
  const [rendered] = orientHistoricalFeatures([a]);
  assert.equal(rendered.geometry.coordinates[0][0], a.geometry.coordinates[0]);
  const initial = countryPalette([a, b]);
  const later = countryPalette([b, polity("c"), polity("a", [square(20, 30)])]);
  assert.equal(initial.get("a"), later.get("a"));
  assert.equal(initial.get("b"), later.get("b"));
});

test("neutral land background retains every mainland and island without a selectable country identity", () => {
  const mainland = polity("mainland"), island = polity("island", [square(80, 81)]);
  const backdrop = landBackground([mainland, island]);
  assert.equal(isLandBackground(backdrop), true);
  assert.equal(isLandBackground(mainland), false);
  assert.equal(backdrop.properties.HISTORY_ID, undefined);
  assert.deepEqual(backdrop.geometry.coordinates, [mainland.geometry.coordinates, island.geometry.coordinates]);
  assert.equal(backdrop.geometry.coordinates[1], island.geometry.coordinates);
});

test("relations and component unions render above land but below concrete polities, including on hover", () => {
  const concrete = polity("member"), relation = polity("relation"), union = polity("commonwealth");
  concrete.properties.HISTORY_TYPE = "POLITY";
  relation.properties.HISTORY_TYPE = "RELATION";
  union.properties.HISTORY_TYPE = "POLITY";
  union.properties.HISTORY_COMPONENTS = JSON.stringify(["member"]);
  const backdrop = landBackground([concrete]);
  assert.equal(isHistoricalComposite(concrete), false);
  for (const composite of [relation, union]) {
    assert.equal(isHistoricalComposite(composite), true);
    assert.ok(historicalSurfaceAltitude(composite) > historicalSurfaceAltitude(backdrop));
    assert.ok(historicalSurfaceAltitude(composite, false, true) < historicalSurfaceAltitude(concrete));
    assert.ok(historicalSurfaceAltitude(composite, true) > historicalSurfaceAltitude(concrete, false, true));
    assert.equal(historicalSurfaceAltitude({ ...composite, geometry: polity("other", [square(50, 60)]).geometry }), historicalSurfaceAltitude(composite), "year geometry changes retain the same layer");
  }
});

test("default composite clicks resolve to a concrete polity while explicitly selected composites retain their full highlight", () => {
  const union = polity("union"), member = polity("member");
  union.properties.HISTORY_TYPE = "RELATION";
  const shapes = [union, member];
  assert.equal(historicalPickFeature(union, shapes, { lat: 2, lng: 2 }), member);
  assert.equal(historicalPickFeature(union, [...shapes].reverse(), { lat: 2, lng: 2 }), member, "source order cannot let the union intercept a member");
  assert.equal(historicalPickFeature(union, shapes, { lat: 2, lng: 2 }, "union"), union);
  assert.equal(historicalPickFeature(member, shapes, { lat: 2, lng: 2 }), member);
  assert.equal(historicalPickFeature(union, shapes, { lat: 8, lng: 8 }), union, "a visible union without a recorded member remains selectable");
});

test("composite pick-through respects holes and members across the antimeridian", () => {
  const union = polity("union", [square(178, -178)]);
  union.properties.HISTORY_COMPONENTS = JSON.stringify(["member"]);
  const hole = [[179, 1], [179, 3], [-179, 3], [-179, 1], [179, 1]];
  const member = polity("member", [square(178, -178), hole]);
  assert.equal(historicalPickFeature(union, [union, member], { lat: .5, lng: -179.5 }), member);
  assert.equal(historicalPickFeature(union, [union, member], { lat: 2, lng: -179.5 }), union, "a member's hole cannot receive the click");
});

test("real Commonwealth data stays below Canada, Britain, India and Australia despite its source POLITY type", async () => {
  const loader = createHistoricalGeographyLoader({
    fetcher: async path => new Response(readFileSync(new URL(`../public${path}`, import.meta.url))),
  });
  const { features } = await loader.loadHistoricalYear(2001);
  const commonwealth = features.find(feature => feature.properties.NAME_EN === "(Commonwealth of Nations)");
  assert.equal(commonwealth.properties.HISTORY_TYPE, "POLITY", "preserve the source classification");
  assert.equal(isHistoricalComposite(commonwealth), true, "components determine the display layer");
  for (const [expected, lat, lng] of [
    ["Canada", 45.42, -75.69], ["Kingdom of Great Britain", 51.5, -.12],
    ["Republic of India", 28.61, 77.2], ["Commonwealth of Australia", -35.28, 149.13],
  ]) {
    const picked = historicalPickFeature(commonwealth, features, { lat, lng });
    assert.equal(picked.properties.NAME_EN, expected);
    assert.ok(historicalSurfaceAltitude(commonwealth, false, true) < historicalSurfaceAltitude(picked));
    assert.equal(historicalPickFeature(commonwealth, features, { lat, lng }, countryCode(commonwealth)), commonwealth);
  }
});

test("resizing a real Tang selection to mobile refits its extent and preserves a clicked remote island", async () => {
  const loader = createHistoricalGeographyLoader({ fetcher: async path => new Response(readFileSync(new URL(`../public${path}`, import.meta.url))) });
  const { features } = await loader.loadHistoricalYear(750);
  const tang = features.find(feature => feature.properties.NAME_EN === "Tang Dynasty");
  const desktop = { width: 1200, height: 728, availableHeight: 588 };
  const mobile = { width: 390, height: 844, availableHeight: 716 };
  const wide = countryViewportView(tang, desktop, 50), narrow = countryViewportView(tang, mobile, 50);
  assert.equal(narrow.lat, wide.lat);
  assert.equal(narrow.lng, wide.lng);
  assert.ok(narrow.altitude > wide.altitude * 1.7, "the narrow viewport needs a wider camera distance");
  assert.deepEqual(countryViewportView(tang, desktop, 50), wide, "returning to desktop refits back");
  const islands = polity("islands");
  islands.geometry = { type: "MultiPolygon", coordinates: [[square(0, 10)], [square(80, 81)]] };
  const point = { lat: 2, lng: 80.5 };
  assert.equal(countryViewportView(islands, mobile, 50, point).lng, countryViewportView(islands, desktop, 50, point).lng);
  assert.ok(countryViewportView(islands, mobile, 50, point).lng > 80, "resize retains the selected remote island rather than the mainland");
});

test("the shipped land silhouette removes modern shared borders while retaining coastline polygons", () => {
  const source = JSON.parse(readFileSync(new URL("../public/data/countries.geojson", import.meta.url), "utf8"));
  const land = JSON.parse(readFileSync(new URL("../public/data/land.geojson", import.meta.url), "utf8"));
  function edgeOwners(features) {
    const owners = new Map();
    features.forEach((feature, index) => {
      const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      for (const ring of polygons.flat()) for (let i = 1; i < ring.length; i++) {
        const [a, b] = [ring[i - 1], ring[i]];
        // Exclude sub-metre slivers in the source's Canada/Alaska coastal join.
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < .001) continue;
        const key = [a, b].map(point => point.map(value => value.toFixed(6)).join(",")).sort().join("|");
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(index);
      }
    });
    return owners;
  }
  const originalEdges = edgeOwners(source.features), landEdges = edgeOwners(land.features);
  const shared = [...originalEdges].filter(([, owners]) => owners.size > 1).map(([edge]) => edge);
  assert.ok(shared.length > 2000, "test the real basemap's internal borders");
  assert.deepEqual(shared.filter(edge => landEdges.has(edge)), []);
  assert.ok(land.features[0].geometry.coordinates.length > 100, "remote landmasses remain included");
  assert.ok(landEdges.size > 4000, "coastline detail remains present");
});

test("overlapping historical membership matches either polity without applying modern country normalization", () => {
  const overlap = event("overlap", "a", { polityIds: ["a", "b"] });
  assert.equal(eventMatchesCountry(overlap, "b", true), true);
  assert.equal(eventMatchesCountry(overlap, "b"), false);
  assert.equal(eventMatchesCountry(overlap, "c", true), false);
  assert.equal(eventMatchesCountry(event("taiwan", "TWN"), "CHN"), true);
  assert.equal(eventMatchesCountry(event("taiwan", "TWN"), "CHN", true), false);
});

test("historical overview deduplicates overlapping membership and close-up retains original event objects", () => {
  const overlap = event("overlap", "a", { polityIds: ["a", "b"] });
  const onlyB = event("b-event", "b", { lat: 2 });
  const shapes = [polity("a"), polity("b")];
  const overview = historicalEventBubbles([overlap, onlyB], shapes);
  assert.deepEqual(overview.map(group => [group.country, group.events.map(item => item.id)]), [["a", ["overlap"]], ["b", ["b-event"]]]);
  assert.equal(overview[0].name, "a政权");
  assert.equal(historicalEventBubbles([overlap], shapes, { locale: "en" })[0].name, "Polity a");
  const closeup = historicalEventBubbles([overlap, onlyB], shapes, { country: "b" });
  assert.equal(closeup[0].events[0], overlap);
  assert.deepEqual(closeup.map(group => group.events[0].id), ["overlap", "b-event"]);
  assert.equal(closeup[0].name, overlap.location);
});

test("missing primary polity falls back to a visible membership; unknown territory stays at the event point", () => {
  const overlap = event("overlap", "absent", { polityIds: ["absent", "b"] });
  assert.equal(historicalEventBubbles([overlap], [polity("b")])[0].country, "b");
  const unknown = event("unknown", "", { polityIds: [], lat: -34, lng: 150 });
  const [bubble] = historicalEventBubbles([unknown], []);
  assert.equal(bubble.name, unknown.location);
  assert.equal(bubble.lat, -34);
  assert.equal(bubble.lng, 150);
  assert.equal(bubble.events[0], unknown);
});

test("selected historical events survive group limits and unlocated events need an explicit polity close-up", () => {
  const shapes = Array.from({ length: 8 }, (_, i) => polity(`p${i}`));
  const events = shapes.flatMap((shape, i) => Array.from({ length: 5 }, (_, j) => event(`${i}-${j}`, shape.properties.HISTORY_ID, { lat: j, lng: i })));
  const groups = historicalEventBubbles(events, shapes, { selectedId: "7-4" });
  assert.equal(groups.length, 6);
  assert.ok(groups.every(group => group.events.length <= 3));
  assert.equal(groups[0].selected, true);
  assert.equal(groups[0].events[0], events.at(-1));
  const unlocated = event("unlocated", "p0", { lat: undefined, lng: undefined });
  assert.deepEqual(historicalEventBubbles([unlocated], shapes), []);
  const [fallback] = historicalEventBubbles([unlocated], shapes, { country: "p0" });
  assert.equal(fallback.events[0], unlocated);
  assert.equal(fallback.name, "p0政权");
  assert.equal(fallback.lat, countryView(shapes[0], 1, 50).lat);
});
