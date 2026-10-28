import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chooseWikidataName } from '../scripts/build-historical-geography-names.mjs';
import { Converter } from 'opencc-js';

const root = new URL('../', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const manifest = await read('public/data/history/manifest.json');
const chunks = await Promise.all(manifest.chunks.map(async entry => ({ entry, data: await read(`public/data/history/${entry.path}`) })));
const polityMap = new Map(manifest.polities.map(p => [p.id, p]));
const ordinal = year => year < 0 ? year : year - 1;
const nextYear = year => year === -1 ? 1 : year + 1;
const validYear = y => Number.isSafeInteger(y) && y !== 0;

test('historical manifest pins an attributed source and complete, disjoint calendar coverage', async () => {
  const source = await read('data/history/source.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.source, Object.fromEntries(['name', 'url', 'version', 'commit', 'sha256'].map(key => [key, source[key]])));
  assert.equal(manifest.license.name, 'CC BY 4.0');
  assert.equal(manifest.chunks[0].from, manifest.minYear);
  assert.equal(manifest.chunks.at(-1).to, manifest.maxYear);
  for (const [i, chunk] of manifest.chunks.entries()) {
    assert.ok(validYear(chunk.from) && validYear(chunk.to) && chunk.from <= chunk.to);
    if (i) assert.equal(chunk.from, nextYear(manifest.chunks[i - 1].to));
    assert.ok(chunk.bytes <= 3_000_000, `oversized shard: ${chunk.path}`);
  }
  assert.deepEqual(await read('data/history/coverage.json'), await read('public/data/history/coverage.json'));
  assert.equal((await read('public/data/history/coverage.json')).maxYear, manifest.maxYear);
});

test('historical identities are source-based, unique, bilingual and Simplified Chinese', async () => {
  const names = await read('data/history/names-zh.json');
  const toSimplified = Converter({ from: 'tw', to: 'cn' });
  assert.equal(polityMap.size, manifest.polities.length);
  for (const p of manifest.polities) {
    assert.equal(p.id, 'clio-' + createHash('sha256').update(p.type + '\0' + p.nameEn).digest('hex').slice(0, 16));
    assert.ok(validYear(p.from) && validYear(p.to) && p.from <= p.to);
    assert.match(p.nameZh, /\p{Script=Han}/u, p.nameEn);
    assert.ok(['wikidata', 'reviewed', 'mt'].includes(p.nameZhSource), p.nameEn);
    assert.equal(p.nameZh, names[p.nameEn].name);
    assert.equal(p.nameZh, toSimplified(p.nameZh), p.nameEn);
  }
  for (const [en, zh] of Object.entries({ 'Republic of China': '中华民国', 'Qin': '秦国', 'Wei': '魏国', 'Song': '宋国', 'Xia': '夏（十六国）', 'Zhongshan': '中山国', 'Yugoslav Partisans': '南斯拉夫游击队' })) {
    assert.equal(manifest.polities.find(p => p.nameEn === en)?.nameZh, zh);
  }
});

const signedArea = ring => ring.reduce((area, point, i) => {
  const next = ring[(i + 1) % ring.length];
  return area + point[0] * next[1] - next[0] * point[1];
}, 0) / 2;

test('historical display polygons retain closed rings, RFC winding and one entity per active year', () => {
  for (const { entry, data } of chunks) {
    assert.equal(data.type, 'FeatureCollection');
    const periods = new Map();
    for (const f of data.features) {
      const p = f.properties;
      assert.ok(polityMap.has(p.polityId));
      assert.ok(validYear(p.from) && validYear(p.to) && p.from <= p.to);
      assert.ok(p.from <= entry.to && p.to >= entry.from);
      for (const id of [...p.memberOf, ...p.components]) assert.ok(polityMap.has(id));
      const own = periods.get(p.polityId) ?? [];
      own.push([Math.max(p.from, entry.from), Math.min(p.to, entry.to)]);
      periods.set(p.polityId, own);
      assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      assert.ok(polygons.length > 0);
      for (const polygon of polygons) {
        assert.ok(polygon.length > 0);
        for (const [i, ring] of polygon.entries()) {
          assert.ok(ring.length >= 4);
          assert.deepEqual(ring[0], ring.at(-1));
          for (const [x, y] of ring) assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90);
          assert.ok(i === 0 ? signedArea(ring) > 0 : signedArea(ring) < 0, `${p.polityId} invalid ring winding`);
          for (let j = 1; j < ring.length; j++) assert.ok(Math.abs(ring[j][0] - ring[j - 1][0]) <= 180, 'unsplit antimeridian edge');
        }
      }
    }
    for (const [id, ranges] of periods) {
      ranges.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < ranges.length; i++) assert.ok(ordinal(ranges[i - 1][1]) < ordinal(ranges[i][0]), `duplicate active identity: ${id}`);
    }
  }
});

test('event membership covers every event, preserves all hits, and never infers coordinate-free affiliation', async () => {
  const index = await read('public/data/history/event-polities.json');
  const files = await readdir(new URL('public/data/events/year/', root));
  const events = (await Promise.all(files.filter(f => f.endsWith('.json')).map(f => read(`public/data/events/year/${f}`)))).flat();
  assert.equal(Object.keys(index).length, events.length);
  const active = new Map();
  for (const { data } of chunks) for (const f of data.features) {
    const p = f.properties, ranges = active.get(p.polityId) ?? [];
    ranges.push([p.from, p.to]); active.set(p.polityId, ranges);
  }
  let multiple = 0;
  for (const e of events) {
    assert.ok(Array.isArray(index[e.id]), `missing event: ${e.id}`);
    const ids = index[e.id];
    assert.equal(new Set(ids).size, ids.length);
    if (e.lat == null || e.lng == null || e.y < manifest.minYear || e.y > manifest.maxYear || !validYear(e.y)) assert.deepEqual(ids, []);
    let relationSeen = false;
    for (const id of ids) {
      const p = polityMap.get(id); assert.ok(p, `unknown membership: ${id}`);
      assert.ok(active.get(id).some(([from, to]) => from <= e.y && e.y <= to), `inactive polity for ${e.id}`);
      if (p.type === 'RELATION') relationSeen = true;
      else assert.equal(relationSeen, false, `concrete polity follows composite: ${e.id}`);
    }
    if (ids.length > 1) multiple++;
  }
  assert.ok(multiple > 0, 'overlapping polities should not be silently forced to one membership');
});

test('Chinese label matching rejects component QIDs and unrelated English names', () => {
  const labels = { Q1: { en: 'Roman Empire', aliases: ['Imperium Romanum'], zh: '罗马帝国' } };
  assert.deepEqual(chooseWikidataName({ type: 'POLITY', nameEn: 'Roman Empire', wikidataIds: ['Q1'] }, labels), { name: '罗马帝国', source: 'wikidata', wikidataId: 'Q1' });
  assert.equal(chooseWikidataName({ type: 'RELATION', nameEn: 'Roman Empire', wikidataIds: ['Q1'] }, labels), null);
  assert.equal(chooseWikidataName({ type: 'POLITY', nameEn: 'Roman Republic', wikidataIds: ['Q1'] }, labels), null);
  assert.equal(chooseWikidataName({ type: 'POLITY', nameEn: 'Roman Empire', wikidataIds: ['Q1', 'Q2'] }, labels), null);
});
