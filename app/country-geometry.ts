export type Coordinate = [number, number];
export type CountryFeature = {
  properties: Record<string, string>;
  geometry: { type: "Polygon"; coordinates: Coordinate[][] } | { type: "MultiPolygon"; coordinates: Coordinate[][][] };
};
export type CountryRegion = { code: string; name: string };
const RAD = Math.PI / 180;
const normalize = (lng: number) => ((lng + 180) % 360 + 360) % 360 - 180;
export const countryCode = (f: CountryFeature) => f.properties.ISO_A3_EH && f.properties.ISO_A3_EH !== "-99" ? f.properties.ISO_A3_EH : f.properties.ADM0_A3;
export const countryRegion = (f: CountryFeature): CountryRegion => ({ code: countryCode(f), name: ({CHN:"中国", KOR:"韩国", PRK:"朝鲜"} as Record<string,string>)[countryCode(f)] || f.properties.NAME_ZH || f.properties.NAME_EN });
const polygons = (f: CountryFeature) => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;

// The atlas groups Taiwan with China. Merge before rendering so colors,
// hover, selection, camera fitting and the region picker share one feature.
export function atlasCountries(features: CountryFeature[]): CountryFeature[] {
  const china = features.find(f => countryCode(f) === "CHN");
  const taiwan = features.find(f => countryCode(f) === "TWN");
  if (!china || !taiwan) return features;
  return features.filter(f => f !== taiwan).map(f => f === china ? {
    ...china,
    geometry: { type: "MultiPolygon", coordinates: [...polygons(china), ...polygons(taiwan)] },
  } : f);
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
function area(ring: Coordinate[]) {
  const points = unwrap(ring);
  return Math.abs(points.reduce((sum, p, i) => { const next = points[(i+1)%points.length]; return sum+(next[0]-p[0])*(Math.sin(p[1]*RAD)+Math.sin(next[1]*RAD)); }, 0));
}

// Fit the clicked landmass and nearby islands, preserving dateline continuity.
// Distant overseas territories remain the same color without pulling the camera away.
export function countryView(f: CountryFeature, aspect: number, fov: number, point?: { lat: number; lng: number }, minAltitude = .16, maxIslandGap = 3) {
  const parts = polygons(f);
  let seed = point ? parts.findIndex(rings => contains(rings[0], [point.lng, point.lat]) && !rings.slice(1).some(r => contains(r, [point.lng, point.lat]))) : -1;
  if (seed < 0) seed = parts.reduce((best, rings, i) => area(rings[0]) > area(parts[best][0]) ? i : best, 0);
  const included = new Set([seed]), queue = [seed];
  while (queue.length) {
    const current = queue.shift()!;
    parts.forEach((rings, i) => {
      if (!included.has(i) && parts[current][0].some(a => rings[0].some(b => angularDistance(a, b) <= maxIslandGap*RAD))) { included.add(i); queue.push(i); }
    });
  }
  const points = [...included].flatMap(i => parts[i][0]);
  const lngs = points.map(p => (p[0]+360)%360).sort((a,b) => a-b);
  let largestGap = -1, start = 0;
  for (let i = 0; i < lngs.length; i++) {
    const next = i+1 < lngs.length ? lngs[i+1] : lngs[0]+360;
    if (next-lngs[i] > largestGap) { largestGap = next-lngs[i]; start = next%360; }
  }
  const lng = normalize(start+(360-largestGap)/2);
  const lat = (Math.min(...points.map(p => p[1]))+Math.max(...points.map(p => p[1])))/2;
  const radius = Math.max(...points.map(p => angularDistance([lng,lat],p)));
  const halfFov = Math.min(fov*RAD/2, Math.atan(Math.tan(fov*RAD/2)*Math.max(.2, aspect)))*.82;
  const distance = radius >= Math.PI/2 ? 3.5 : Math.max(Math.cos(radius)+Math.sin(radius)/Math.tan(halfFov), 1/Math.cos(radius));
  return { lat, lng, altitude: Math.max(minAltitude, Math.min(2.5, distance-1)) };
}

// Adjacent countries receive different colors; color denotes geography, not data.
export function countryPalette(features: CountryFeature[]) {
  const palette = ["#78938b", "#b0a180", "#728fa2", "#9a8e9d", "#8a9b71", "#af8c76", "#7eaaa3"];
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
