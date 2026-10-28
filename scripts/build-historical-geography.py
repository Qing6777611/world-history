#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["shapely==2.1.2", "numpy==2.5.4"]
# ///
"""Build attributed, temporal Cliopatria geometry and coordinate-based event memberships.

uv run scripts/build-historical-geography.py [--offline] [--allow-missing-names]
uv run scripts/build-historical-geography.py --names-only --offline

The original, checksum-locked archive stays in .cache/history. Published data uses
historical years (1 BCE = -1; no year zero); all endpoints are inclusive. Event
membership uses repaired ORIGINAL boundaries, never their display simplification.
"""
import argparse
import collections
import hashlib
import json
import math
import gzip
from pathlib import Path
import subprocess
import zipfile

from shapely import make_valid, normalize, set_precision, union_all
from shapely.affinity import translate
from shapely.geometry import Polygon, MultiPolygon, Point, box, mapping, shape
from shapely.geometry.polygon import orient
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = json.loads((ROOT / 'data/history/source.json').read_text())
OUTPUT = ROOT / 'public/data/history'
CACHE = ROOT / '.cache/history'
TOLERANCE = 0.06  # degrees, display only; topology-preserving
GRID = 0.0001
MAX_CHUNK_BYTES = 3_000_000
MIN_YEAR, MAX_YEAR = -3400, 2024


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_text(value) + '\n')


def stable_id(name, kind):
    return 'clio-' + hashlib.sha256((kind + '\0' + name).encode()).hexdigest()[:16]


def ordinal(year):
    if year == 0:
        raise ValueError('Historical calendars have no year zero')
    return year if year < 0 else year - 1


def historical_year(value):
    return value if value < 0 else value + 1


def normalize_range(start, end):
    # Zero occurs only as a BCE end boundary in this pinned release. Removing an
    # unrepresentable endpoint does not shift other negative or positive dates.
    start = 1 if start == 0 else start
    end = -1 if end == 0 else end
    if not isinstance(start, int) or not isinstance(end, int) or start > end:
        raise ValueError(f'Invalid historical interval {start}..{end}')
    return start, end


def polygons(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if not geometry.is_empty else []
    if hasattr(geometry, 'geoms'):
        return [p for child in geometry.geoms for p in polygons(child)]
    return []


def polygonal(geometry):
    parts = polygons(geometry if geometry.is_valid else make_valid(geometry))
    if not parts:
        raise ValueError('Source geometry contains no non-empty polygon')
    result = parts[0] if len(parts) == 1 else union_all(parts)
    return result if result.is_valid else make_valid(result)


def unwrap_ring(ring):
    result = [list(ring[0][:2])]
    for point in ring[1:]:
        x, y = point[:2]
        while x - result[-1][0] > 180:
            x -= 360
        while x - result[-1][0] < -180:
            x += 360
        result.append([x, y])
    return result


def normalize_dateline(raw):
    """Split only polygons whose longitude edges cross the antimeridian."""
    coordinates = [raw['coordinates']] if raw['type'] == 'Polygon' else raw['coordinates']
    parts = []
    crossed = 0
    for rings in coordinates:
        if not any(abs(a[0] - b[0]) > 180 for ring in rings for a, b in zip(ring, ring[1:])):
            parts.extend(polygons(polygonal(Polygon(rings[0], rings[1:]))))
            continue
        crossed += 1
        shell = unwrap_ring(rings[0])
        center = (min(p[0] for p in shell) + max(p[0] for p in shell)) / 2
        holes = []
        for ring in rings[1:]:
            hole = unwrap_ring(ring)
            shift = 360 * round((center - sum(p[0] for p in hole) / len(hole)) / 360)
            holes.append([[p[0] + shift, p[1]] for p in hole])
        geom = polygonal(Polygon(shell, holes))
        lower, _, upper, _ = geom.bounds
        for tile in range(math.floor((lower + 180) / 360), math.floor((upper + 180) / 360) + 1):
            clipped = geom.intersection(box(-180 + tile * 360, -90, 180 + tile * 360, 90))
            parts.extend(polygons(translate(clipped, xoff=-tile * 360)))
    return polygonal(union_all(parts)), crossed


def display_geometry(geom):
    simplified = geom.simplify(TOLERANCE, preserve_topology=True)
    rounded = set_precision(simplified, GRID, mode='valid_output')
    if rounded.is_empty:  # Preserve the smallest entities rather than drop them.
        rounded = simplified
    parts = [orient(p, sign=1.0) for p in polygons(rounded)]
    if not parts:
        raise ValueError('Display simplification removed a polity')
    result = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return mapping(result)


def ensure_source(offline):
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / f"cliopatria-{SOURCE['version']}.geojson.zip"
    if not archive.exists():
        if offline:
            raise FileNotFoundError(f'Offline source archive missing: {archive}')
        temporary = archive.with_suffix('.part')
        subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '600', '-o', str(temporary), SOURCE['downloadUrl']], check=True)
        temporary.rename(archive)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    if checksum != SOURCE['sha256']:
        raise ValueError(f'Source checksum mismatch: {checksum}; refusing to build')
    with zipfile.ZipFile(archive) as z:
        return json.loads(z.read(SOURCE['archiveMember']))['features']


def load_names():
    path = ROOT / 'data/history/names-zh.json'
    return json.loads(path.read_text()) if path.exists() else {}


def with_names(polities, allow_missing=False):
    names = load_names()
    missing = []
    for polity in polities:
        name = names.get(polity['nameEn'])
        if not name or not any('\u3400' <= c <= '\u9fff' for c in name.get('name', '')):
            missing.append(polity['nameEn'])
            polity.update(nameZh=polity['nameEn'], nameZhSource='untranslated')
        else:
            polity.update(nameZh=name['name'], nameZhSource=name['source'])
    if missing and not allow_missing:
        raise ValueError(f'{len(missing)} Chinese polity names missing; run name refresh or use --allow-missing-names only for development')
    return missing


def temporal_segments(records):
    """Union simultaneous parts of ONE source polity; never combine identities."""
    bounds = sorted({b for r in records for b in (ordinal(r['from']), ordinal(r['to']) + 1)})
    result = []
    for start, end in zip(bounds, bounds[1:]):
        active = [r for r in records if ordinal(r['from']) <= start <= ordinal(r['to'])]
        if not active:
            continue
        geom = polygonal(union_all([r['geometry'] for r in active])) if len(active) > 1 else active[0]['geometry']
        props = {
            'polityId': active[0]['polityId'], 'type': active[0]['type'],
            'from': historical_year(start), 'to': historical_year(end - 1),
            'memberOf': sorted({n for r in active for n in r['memberOf']}),
            'components': sorted({n for r in active for n in r['components']}),
        }
        key = hashlib.sha256(normalize(geom).wkb).hexdigest()
        # Merging adjacent identical geometries reduces chunks without changing
        # intervals, affiliation metadata, or the primary-membership order.
        area = sum(r['areaKm2'] for r in active)
        if result and ordinal(result[-1]['properties']['to']) + 1 == start and result[-1]['geometryKey'] == key \
                and result[-1]['properties']['memberOf'] == props['memberOf'] and result[-1]['properties']['components'] == props['components'] \
                and result[-1]['areaKm2'] == area:
            result[-1]['properties']['to'] = props['to']
        else:
            result.append({'properties': props, 'geometry': geom, 'geometryKey': key, 'areaKm2': area})
    return result


def prepare(features):
    grouped = collections.defaultdict(list)
    metadata = {}
    by_name = {f['properties']['Name']: stable_id(f['properties']['Name'], f['properties']['Type']) for f in features}
    report = {'rawFeatures': len(features), 'zeroEndpointsRemoved': 0, 'invalidSourceGeometriesRepaired': 0, 'datelinePolygonsSplit': 0, 'unresolvedRelations': []}
    for i, feature in enumerate(features):
        p = feature['properties']
        name, kind = p['Name'], p['Type']
        if kind not in ('POLITY', 'RELATION'):
            raise ValueError(f'Unknown source entity type: {kind}')
        id_ = stable_id(name, kind)
        start, end = normalize_range(p['FromYear'], p['ToYear'])
        report['zeroEndpointsRemoved'] += int(p['FromYear'] == 0) + int(p['ToYear'] == 0)
        raw = shape(feature['geometry'])
        report['invalidSourceGeometriesRepaired'] += not raw.is_valid
        geom, split = normalize_dateline(feature['geometry'])
        report['datelinePolygonsSplit'] += split
        def links(field):
            names = [n.strip() for n in p.get(field, '').split(';') if n.strip()]
            for n in names:
                if n not in by_name:
                    report['unresolvedRelations'].append({'name': name, 'field': field, 'reference': n})
            return [by_name[n] for n in names if n in by_name]
        grouped[id_].append({'polityId': id_, 'type': kind, 'from': start, 'to': end, 'geometry': geom,
                             'areaKm2': p['Area'], 'memberOf': links('MemberOf'), 'components': links('Components')})
        item = metadata.setdefault(id_, {'id': id_, 'nameEn': name, 'type': kind, 'from': start, 'to': end, 'wikidataIds': set(), 'wikipedia': set()})
        item['from'], item['to'] = min(item['from'], start), max(item['to'], end)
        item['wikidataIds'].update(q.strip() for q in p.get('Wikidata', '').split(';') if q.strip())
        item['wikipedia'].update(n.strip() for n in p.get('Wikipedia', '').split(';') if n.strip())
        if (i + 1) % 2000 == 0:
            print(f'Prepared source geometry {i + 1}/{len(features)}', flush=True)
    polities = sorted(metadata.values(), key=lambda p: (p['nameEn'], p['id']))
    for p in polities:
        p['wikidataIds'] = sorted(p['wikidataIds'])
        p['wikipedia'] = sorted(p['wikipedia'])
    write_json(CACHE / 'polities.json', polities)
    segments = [s for id_ in sorted(grouped) for s in temporal_segments(grouped[id_])]
    report['polities'] = len(polities)
    report['segments'] = len(segments)
    return polities, segments, report


def make_chunks(segments):
    simplified = {}
    features = []
    for segment in segments:
        key = segment['geometryKey']
        if key not in simplified:
            simplified[key] = display_geometry(segment['geometry'])
        feature = {'type': 'Feature', 'properties': dict(segment['properties']), 'geometry': simplified[key]}
        # Adjacent source revisions can display identically after simplification.
        # Merge only their DISPLAY interval; original geometries remain separate
        # for event membership, including border changes hidden at globe scale.
        if features:
            previous = features[-1][0]
            a, b = previous['properties'], feature['properties']
            if a['polityId'] == b['polityId'] and ordinal(a['to']) + 1 == ordinal(b['from']) \
                    and a['memberOf'] == b['memberOf'] and a['components'] == b['components'] \
                    and previous['geometry'] == feature['geometry']:
                a['to'] = b['to']
                features[-1] = (previous, len(json_text(previous).encode()))
                continue
        features.append((feature, len(json_text(feature).encode())))
    ranges = []
    def partition(first, last, items):
        size = sum(size for _, size in items)
        if size <= MAX_CHUNK_BYTES or first == last:
            ranges.append((first, last, items)); return
        middle = (first + last) // 2
        partition(first, middle, [(f, s) for f, s in items if ordinal(f['properties']['from']) <= middle and ordinal(f['properties']['to']) >= first])
        partition(middle + 1, last, [(f, s) for f, s in items if ordinal(f['properties']['from']) <= last and ordinal(f['properties']['to']) >= middle + 1])
    partition(ordinal(MIN_YEAR), ordinal(MAX_YEAR), features)
    chunks = []
    for first, last, items in ranges:
        start, end = historical_year(first), historical_year(last)
        filename = f'chunks/{start}_{end}.json'
        # Keep the feature's actual phase dates; shard boundaries are an asset
        # loading detail, not a historical change in that entity's territory.
        data = {'type': 'FeatureCollection', 'features': [f for f, _ in items]}
        write_json(OUTPUT / filename, data)
        payload = (OUTPUT / filename).read_bytes()
        chunks.append({'from': start, 'to': end, 'path': filename, 'bytes': len(payload), 'gzipBytes': len(gzip.compress(payload, mtime=0)), 'features': len(items)})
    # Remove only this pipeline's obsolete shards after the replacement exists.
    keep = {c['path'] for c in chunks}
    for path in (OUTPUT / 'chunks').glob('*.json'):
        if str(path.relative_to(OUTPUT)) not in keep:
            path.unlink()
    return chunks


def event_memberships(segments, polities):
    events_dir = ROOT / 'public/data/events/year'
    if not events_dir.exists():
        raise FileNotFoundError('Existing event year shards are required to build memberships')
    events = [event for path in sorted(events_dir.glob('*.json')) for event in json.loads(path.read_text())]
    if len({e['id'] for e in events}) != len(events):
        raise ValueError('Duplicate event IDs')
    index = {e['id']: [] for e in events}
    groups = collections.defaultdict(list)
    for event in events:
        if MIN_YEAR <= event['y'] <= MAX_YEAR and event['y'] != 0 and isinstance(event.get('lat'), (int, float)) and isinstance(event.get('lng'), (int, float)):
            if not (-90 <= event['lat'] <= 90 and -180 <= event['lng'] <= 180):
                raise ValueError(f'Invalid event coordinates: {event["id"]}')
            groups[event['y']].append(event)
    # One index of unsimplified temporal geometry; date filtering follows the
    # spatial query. covers() includes border points, preserving ambiguity.
    tree = STRtree([s['geometry'] for s in segments])
    for year, year_events in sorted(groups.items()):
        for event in year_events:
            point = Point(event['lng'], event['lat'])
            hits = [segments[int(i)] for i in tree.query(point) if segments[int(i)]['properties']['from'] <= year <= segments[int(i)]['properties']['to'] and segments[int(i)]['geometry'].covers(point)]
            hits.sort(key=lambda s: (s['properties']['type'] != 'POLITY', s['areaKm2'], s['properties']['polityId']))
            index[event['id']] = list(dict.fromkeys(s['properties']['polityId'] for s in hits))
    write_json(OUTPUT / 'event-polities.json', index)
    return {'events': len(events), 'eventsWithCoordinatesInRange': sum(map(len, groups.values())), 'eventsMatched': sum(bool(v) for v in index.values()), 'eventsWithMultipleMemberships': sum(len(v) > 1 for v in index.values())}


def publish_metadata(polities, chunks, report, allow_missing):
    missing = with_names(polities, allow_missing)
    source = {k: SOURCE[k] for k in ('name', 'url', 'version', 'commit', 'sha256')}
    manifest = {'schemaVersion': 1, 'minYear': MIN_YEAR, 'maxYear': MAX_YEAR, 'source': source, 'license': SOURCE['license'], 'polities': polities, 'chunks': chunks}
    write_json(OUTPUT / 'manifest.json', manifest)
    write_json(OUTPUT / 'coverage.json', {'minYear': MIN_YEAR, 'maxYear': MAX_YEAR, 'sourceName': SOURCE['name'], 'sourceUrl': SOURCE['url'], 'license': SOURCE['license']['name'], 'licenseUrl': SOURCE['license']['url'], 'version': SOURCE['version']})
    (ROOT / 'data/history/coverage.json').write_text((OUTPUT / 'coverage.json').read_text())
    report.update(chunks=len(chunks), geometryBytes=sum(c['bytes'] for c in chunks), maximumChunkBytes=max(c['bytes'] for c in chunks), geometryGzipBytes=sum(c.get('gzipBytes', 0) for c in chunks), maximumChunkGzipBytes=max(c.get('gzipBytes', 0) for c in chunks), missingChineseNames=len(missing), nameSources=dict(collections.Counter(p['nameZhSource'] for p in polities)), displaySimplificationDegrees=TOLERANCE, coordinatePrecisionDegrees=GRID)
    write_json(OUTPUT / 'build-report.json', report)
    attribution = f'''# Historical boundaries: Cliopatria\n\n{SOURCE['citation']}\n\nSource: {SOURCE['url']}\n\nVersion: {SOURCE['version']}\n\nCommit: `{SOURCE['commit']}`\n\nSource archive SHA-256: `{SOURCE['sha256']}`\n\nLicense: [Creative Commons Attribution 4.0 International]({SOURCE['license']['url']}). The underlying historical boundary data is by the Cliopatria authors and contributors, Seshat Global History Databank. The original license is reproduced at [LICENSE.md](LICENSE.md). Research paper: https://doi.org/10.1038/s41597-025-04516-9.\n\n## Changes made for this atlas\n\n- Converted the source into compact, temporal GeoJSON shards. Polygon interiors and exteriors use standard GeoJSON winding. Source-invalid polygons are repaired with Shapely 2.1.2; antimeridian crossings, when present, are split at 180 degrees.\n- Display polygons use topology-preserving simplification with a {TOLERANCE}-degree tolerance and a {GRID}-degree coordinate grid. Tiny entities are retained. These are approximate historical reconstructions, not precise legal boundaries.\n- Dates are inclusive historical years: -1 is 1 BCE, and year zero is unavailable. The pinned source contains six BCE records ending at zero; those nonexistent endpoints are clipped to -1 without shifting any other dates.\n- Same-name/type source records get stable SHA-256-derived identifiers. Simultaneously active parts of the same identity are unioned. Distinct polities and composite RELATION entities are kept separate, including overlapping claims or memberships. This atlas does not merge historical entities using modern country codes.\n- Event memberships use each event's occurrence year and coordinates against the repaired **unsimplified** historical polygons. Points on borders may have multiple memberships. Specific POLITY entities sort before RELATION entities, then by source area (smaller first). Missing coordinates, years outside coverage, and unrepresented areas produce an empty membership list; absence is not evidence that an area had no historical polity. Event coordinates themselves may be approximate or describe a related place.\n- Chinese names use committed Wikidata label snapshots only when the source English name matches the entity's English label/alias. Source relations are translated as relations, not renamed after one component's QID. Project-reviewed name corrections take precedence; remaining names use machine translation (Google Translate). Per-entity `nameZhSource` is `wikidata`, `reviewed`, or `mt`; project review includes AI-assisted checking and does not mean official Chinese nomenclature. Final Chinese names are normalized to Simplified Chinese using OpenCC, without changing their provenance. English source names are retained unchanged. Wikidata structured labels are CC0: https://www.wikidata.org/wiki/Wikidata:Licensing.\n\n## Known source limitations\n\nThe pinned release sometimes reuses historical names across periods or assigns a QID that is broader/different from the English source name. For example, the source retains Mali Federation, Serbia-Montenegro, and Estado Novo records through 2024; Later Zhou contains both -750 to -257 records and a 960 record; Tangier International Zone begins in 1912. These values are reproduced from the source, not dates inferred by this atlas. Chinese naming corrections translate the source identity; they do not validate every date, claim, or regime transition. A Wikidata Chinese label is a naming aid, not independent verification that the associated geometry and period are correct. The English source names, fixed release, and source links remain available for comparison.\n\nRebuild instructions and pinned inputs: `data/history/README.md` in the project repository. Data coverage is {MIN_YEAR} through {MAX_YEAR}, with no year zero.\n'''
    (OUTPUT / 'ATTRIBUTION.md').write_text(attribution)
    (OUTPUT / 'LICENSE.md').write_text((ROOT / 'data/history/LICENSE.md').read_text())
    print(json_text(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--allow-missing-names', action='store_true', help='Development preview only; final builds require Chinese names')
    parser.add_argument('--names-only', action='store_true', help='Refresh names/attribution without changing geometry or membership index')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.names_only:
        manifest = json.loads((OUTPUT / 'manifest.json').read_text())
        report = json.loads((OUTPUT / 'build-report.json').read_text())
        publish_metadata(manifest['polities'], manifest['chunks'], report, args.allow_missing_names)
        return
    features = ensure_source(args.offline)
    polities, segments, report = prepare(features)
    # Fail early if final names are absent, before replacing any published shard.
    with_names(polities, args.allow_missing_names)
    chunks = make_chunks(segments)
    report.update(event_memberships(segments, polities))
    publish_metadata(polities, chunks, report, args.allow_missing_names)


if __name__ == '__main__':
    main()
