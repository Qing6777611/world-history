export type Coordinate = [number, number];
export type CountryFeature = {
  properties: Record<string, string>;
  geometry: { type: "Polygon"; coordinates: Coordinate[][] } | { type: "MultiPolygon"; coordinates: Coordinate[][][] };
};
export type CountryRegion = { code: string; name: string };
const RAD = Math.PI / 180;
const normalize = (lng: number) => ((lng + 180) % 360 + 360) % 360 - 180;
export const isHistoricalFeature = (f: CountryFeature) => !!f.properties.HISTORY_ID;
export const isLandBackground = (f: CountryFeature) => f.properties.ATLAS_BACKGROUND === "true";
export function isHistoricalComposite(f: CountryFeature) {
  if (f.properties.HISTORY_TYPE === "RELATION") return true;
  // Some unions, including the Commonwealth, are typed POLITY in the source.
  // Retain that source type but use its explicit components for display order.
  try { return JSON.parse(f.properties.HISTORY_COMPONENTS || "[]").length > 0; }
  catch { return false; }
}
export const countryCode = (f: CountryFeature) => isHistoricalFeature(f) ? f.properties.ADM0_A3 || f.properties.HISTORY_ID : f.properties.ISO_A3_EH && f.properties.ISO_A3_EH !== "-99" ? f.properties.ISO_A3_EH : f.properties.ADM0_A3;
export const countryRegion = (f: CountryFeature, locale: "zh" | "en" = "zh"): CountryRegion => ({
  code: countryCode(f),
  name: locale === "en" ? f.properties.NAME_EN || f.properties.NAME_ZH || countryCode(f)
    : (!isHistoricalFeature(f) && ({ CHN: "中国", KOR: "韩国", PRK: "朝鲜" } as Record<string, string>)[countryCode(f)]) || f.properties.NAME_ZH || f.properties.NAME_EN || countryCode(f),
});
const polygons = (f: CountryFeature) => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;

function identityHash(code: string) {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

/** Non-overlapping height bands keep composite unions below concrete polities,
 * including on hover. Only an explicit selection lifts a union above its members. */
export function historicalSurfaceAltitude(f: CountryFeature, selected = false, hovered = false) {
  if (isLandBackground(f)) return .002;
  const offset = identityHash(countryCode(f)) / 2147483648 * .00035;
  if (selected) return .011 + offset;
  if (isHistoricalComposite(f)) return (hovered ? .005 : .004) + offset;
  return (hovered ? .009 : .007) + offset;
}

// The atlas groups Taiwan with China. Merge before rendering so colors,
// hover, selection, camera fitting and the region picker share one feature.
export function atlasCountries(features: CountryFeature[]): CountryFeature[] {
  const china = features.find(f => !isHistoricalFeature(f) && countryCode(f) === "CHN");
  const taiwan = features.find(f => !isHistoricalFeature(f) && countryCode(f) === "TWN");
  if (!china || !taiwan) return features;
  return features.filter(f => f !== taiwan).map(f => f === china ? {
    ...china,
    geometry: { type: "MultiPolygon", coordinates: [...polygons(china), ...polygons(taiwan)] },
  } : f);
}

/** A single unselectable land layer supplies coastlines without modern borders. */
export function landBackground(features: CountryFeature[]): CountryFeature {
  return {
    properties: { ADM0_A3: "__land__", ATLAS_BACKGROUND: "true", NAME_EN: "Land", NAME_ZH: "陆地" },
    geometry: { type: "MultiPolygon", coordinates: features.flatMap(polygons) },
  };
}

const orientedHistory = new WeakMap<CountryFeature["geometry"], CountryFeature["geometry"]>();
/** Globe.GL expects clockwise exteriors. Do not mutate the shared source/cache. */
export function orientHistoricalFeatures(features: CountryFeature[]): CountryFeature[] {
  return features.map(feature => {
    let geometry = orientedHistory.get(feature.geometry);
    if (!geometry) {
      const coordinates = polygons(feature).map(polygon => polygon.map((ring, index) => {
        const points = unwrap(ring);
        let signedArea = 0;
        for (let i = 0; i < points.length - 1; i++) signedArea += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
        return (index === 0 ? signedArea > 0 : signedArea < 0) ? [...ring].reverse() : ring;
      }));
      geometry = { type: "MultiPolygon", coordinates };
      orientedHistory.set(feature.geometry, geometry);
    }
    return { ...feature, geometry };
  });
}

function angularDistance(a: Coordinate, b: Coordinate) {
  const h = Math.sin((a[1]-b[1])*RAD/2)**2 + Math.cos(a[1]*RAD)*Math.cos(b[1]*RAD)*Math.sin((a[0]-b[0])*RAD/2)**2;
  return 2*Math.asin(Math.sqrt(Math.min(1, h)));
}
function unwrap(ring: Coordinate[]): Coordinate[] {
  let previous = ring[0][0];
  return ring.map(([lng, lat]) => { previous += normalize(lng-previous); return [previous, lat]; });
}
function contains(ring: Coordinate[], point: Coordinate) {
  const points = unwrap(ring);
  const x = points[0][0]+normalize(point[0]-points[0][0]), y = point[1];
  let inside = false;
  for (let i = 0, j = points.length-1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) inside = !inside;
  }
  return inside;
}

/** Also resolve picking geometrically: differently tessellated overlapping
 * caps can cross at close zoom even when their nominal heights are separated. */
export function historicalPickFeature(candidate: CountryFeature, features: CountryFeature[], point: { lat: number; lng: number }, selectedCode?: string | null) {
  if (!isHistoricalComposite(candidate) || countryCode(candidate) === selectedCode) return candidate;
  const coordinate: Coordinate = [point.lng, point.lat];
  return features.filter(feature => !isHistoricalComposite(feature) && polygons(feature).some(rings =>
    contains(rings[0], coordinate) && !rings.slice(1).some(ring => contains(ring, coordinate)),
  )).sort((a, b) => historicalSurfaceAltitude(b) - historicalSurfaceAltitude(a))[0] || candidate;
}
function area(ring: Coordinate[]) {
  const points = unwrap(ring);
  return Math.abs(points.reduce((sum, p, i) => { const next = points[(i+1)%points.length]; return sum+(next[0]-p[0])*(Math.sin(p[1]*RAD)+Math.sin(next[1]*RAD)); }, 0));
}

type Point3 = [number, number, number];
type SpatialNode = { min: Point3; max: Point3; points: Point3[]; children?: [SpatialNode, SpatialNode] };
type LandmassView = { lat: number; lng: number; radius: number };
type PreparedGeometry = {
  parts: Coordinate[][][];
  roots: SpatialNode[];
  largest: number;
  views: Map<number, Map<number, LandmassView>>;
};
// Geometry is immutable after loading/orientation. A weak cache releases the
// index with its feature, and keeps camera aspect/FOV out of the cached result.
const preparedGeometries = new WeakMap<CountryFeature["geometry"], PreparedGeometry>();

function spatialNode(points: Point3[]): SpatialNode {
  const min: Point3 = [Infinity, Infinity, Infinity], max: Point3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  return { min, max, points };
}

function prepareGeometry(f: CountryFeature): PreparedGeometry {
  const cached = preparedGeometries.get(f.geometry);
  if (cached) return cached;
  const parts = polygons(f);
  let largest = 0, largestArea = -1;
  const roots = parts.map((rings, i) => {
    const size = area(rings[0]);
    if (size > largestArea) { largest = i; largestArea = size; }
    return spatialNode(rings[0].map(([lng, lat]): Point3 => {
      const cosLat = Math.cos(lat * RAD);
      return [cosLat * Math.cos(lng * RAD), cosLat * Math.sin(lng * RAD), Math.sin(lat * RAD)];
    }));
  });
  const prepared = { parts, roots, largest, views: new Map<number, Map<number, LandmassView>>() };
  preparedGeometries.set(f.geometry, prepared);
  return prepared;
}

function boxDistanceSquared(a: SpatialNode, b: SpatialNode) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);
    distance += gap * gap;
  }
  return distance;
}

function splitNode(node: SpatialNode) {
  if (node.children) return node.children;
  let axis = 0;
  for (let i = 1; i < 3; i++) if (node.max[i] - node.min[i] > node.max[axis] - node.min[axis]) axis = i;
  node.points.sort((a, b) => a[axis] - b[axis]);
  const mid = Math.floor(node.points.length / 2);
  node.children = [spatialNode(node.points.slice(0, mid)), spatialNode(node.points.slice(mid))];
  return node.children;
}

// A spherical angle has the same ordering as its 3D chord length. Bounding
// boxes reject distant coastlines; lazy kd-tree splits retain every vertex and
// exact pair checks, including across the dateline and near the poles.
function nearbyVertices(a: SpatialNode, b: SpatialNode, maxDistanceSquared: number): boolean {
  if (boxDistanceSquared(a, b) > maxDistanceSquared) return false;
  if (a.points.length <= 16 && b.points.length <= 16) {
    for (const p of a.points) for (const q of b.points) {
      const distance = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (distance <= maxDistanceSquared) return true;
    }
    return false;
  }
  const [first, second] = splitNode(a.points.length >= b.points.length ? a : b);
  const other = a.points.length >= b.points.length ? b : a;
  // Search the closer child first; a single nearby pair establishes adjacency.
  if (boxDistanceSquared(first, other) <= boxDistanceSquared(second, other)) {
    return nearbyVertices(first, other, maxDistanceSquared) || nearbyVertices(second, other, maxDistanceSquared);
  }
  return nearbyVertices(second, other, maxDistanceSquared) || nearbyVertices(first, other, maxDistanceSquared);
}

function landmassView(prepared: PreparedGeometry, seed: number, maxIslandGap: number): LandmassView {
  let views = prepared.views.get(maxIslandGap);
  if (!views) { views = new Map(); prepared.views.set(maxIslandGap, views); }
  const cached = views.get(seed);
  if (cached) return cached;
  const { parts, roots } = prepared;
  const included = new Set([seed]), queue = [seed];
  const chordSquared = (2 * Math.sin(Math.min(180, maxIslandGap) * RAD / 2)) ** 2;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (maxIslandGap < 0) continue;
    roots.forEach((root, i) => {
      if (!included.has(i) && nearbyVertices(roots[current], root, chordSquared)) {
        included.add(i); queue.push(i);
      }
    });
  }
  const points = [...included].flatMap(i => parts[i][0]);
  const lngs = points.map(p => (p[0] + 360) % 360).sort((a, b) => a - b);
  let largestGap = -1, start = 0, minLat = Infinity, maxLat = -Infinity;
  for (let i = 0; i < lngs.length; i++) {
    const next = i + 1 < lngs.length ? lngs[i + 1] : lngs[0] + 360;
    if (next - lngs[i] > largestGap) { largestGap = next - lngs[i]; start = next % 360; }
    minLat = Math.min(minLat, points[i][1]); maxLat = Math.max(maxLat, points[i][1]);
  }
  const lng = normalize(start + (360 - largestGap) / 2), lat = (minLat + maxLat) / 2;
  let radius = 0;
  for (const point of points) radius = Math.max(radius, angularDistance([lng, lat], point));
  const view = { lat, lng, radius };
  for (const index of included) views.set(index, view);
  return view;
}

// Fit the clicked landmass and nearby islands, preserving dateline continuity.
// Distant overseas territories remain the same color without pulling the camera away.
export function countryView(f: CountryFeature, aspect: number, fov: number, point?: { lat: number; lng: number }, minAltitude = .16, maxIslandGap = 3) {
  const prepared = prepareGeometry(f), { parts } = prepared;
  let seed = point ? parts.findIndex(rings => contains(rings[0], [point.lng, point.lat]) && !rings.slice(1).some(r => contains(r, [point.lng, point.lat]))) : -1;
  if (seed < 0) seed = prepared.largest;
  const { lat, lng, radius } = landmassView(prepared, seed, maxIslandGap);
  const halfFov = Math.min(fov*RAD/2, Math.atan(Math.tan(fov*RAD/2)*Math.max(.2, aspect)))*.82;
  const distance = radius >= Math.PI/2 ? 3.5 : Math.max(Math.cos(radius)+Math.sin(radius)/Math.tan(halfFov), 1/Math.cos(radius));
  return { lat, lng, altitude: Math.max(minAltitude, Math.min(2.5, distance-1)) };
}

// Adjacent countries receive different colors; color denotes geography, not data.
export function countryViewportView(f: CountryFeature, viewport: { width: number; height: number; availableHeight: number }, fov: number, point?: { lat: number; lng: number }, minAltitude = .16, joinDistance = 3) {
  const { width, height, availableHeight } = viewport;
  const effectiveFov = 2 * Math.atan(Math.tan(fov * RAD / 2) * availableHeight / height) / RAD;
  return countryView(f, width / availableHeight, effectiveFov, point, minAltitude, joinDistance);
}

export function countryPalette(features: CountryFeature[]) {
  const palette = ["#78938b", "#b0a180", "#728fa2", "#9a8e9d", "#8a9b71", "#af8c76", "#7eaaa3"];
  if (features.some(isHistoricalFeature)) return new Map(features.map(feature => {
    return [countryCode(feature), palette[identityHash(countryCode(feature)) % palette.length]];
  }));
  const owners = new Map<string, number[]>(), neighbors = features.map(() => new Set<number>());
  features.forEach((f, i) => polygons(f).flat().flat().forEach(p => {
    const key = `${normalize(p[0]).toFixed(3)},${p[1].toFixed(3)}`;
    const previous = owners.get(key) || [];
    previous.forEach(j => { if (j !== i) { neighbors[i].add(j); neighbors[j].add(i); } });
    if (!previous.includes(i)) previous.push(i);
    owners.set(key, previous);
  }));
  const chosen = new Map<number, number>();
  [...features.keys()].sort((a,b) => neighbors[b].size-neighbors[a].size || a-b).forEach(i => {
    const used = new Set([...neighbors[i]].map(j => chosen.get(j)));
    chosen.set(i, palette.findIndex((_,color) => !used.has(color)) % palette.length);
  });
  return new Map(features.map((f,i) => [countryCode(f), palette[Math.max(0,chosen.get(i)!)]]));
}
