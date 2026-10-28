# Historical boundaries: Cliopatria

Chalstrey, Ed, & Bennett, James (2026). Seshat-Global-History-Databank/cliopatria (v0.2.0). Zenodo. https://doi.org/10.5281/zenodo.20274630

Source: https://github.com/Seshat-Global-History-Databank/cliopatria

Version: v0.2.0

Commit: `ad28a691b7c07c1fca89d0e0636d324667d2a258`

Source archive SHA-256: `d01ae3a20d358cc5d54f69d9d725d390767d9c8759ac89ad6f90c58d106f3370`

License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The underlying historical boundary data is by the Cliopatria authors and contributors, Seshat Global History Databank. The original license is reproduced at [LICENSE.md](LICENSE.md). Research paper: https://doi.org/10.1038/s41597-025-04516-9.

## Changes made for this atlas

- Converted the source into compact, temporal GeoJSON shards. Polygon interiors and exteriors use standard GeoJSON winding. Source-invalid polygons are repaired with Shapely 2.1.2; antimeridian crossings, when present, are split at 180 degrees.
- Display polygons use topology-preserving simplification with a 0.06-degree tolerance and a 0.0001-degree coordinate grid. Tiny entities are retained. These are approximate historical reconstructions, not precise legal boundaries.
- Dates are inclusive historical years: -1 is 1 BCE, and year zero is unavailable. The pinned source contains six BCE records ending at zero; those nonexistent endpoints are clipped to -1 without shifting any other dates.
- Same-name/type source records get stable SHA-256-derived identifiers. Simultaneously active parts of the same identity are unioned. Distinct polities and composite RELATION entities are kept separate, including overlapping claims or memberships. This atlas does not merge historical entities using modern country codes.
- Event memberships use each event's occurrence year and coordinates against the repaired **unsimplified** historical polygons. Points on borders may have multiple memberships. Specific POLITY entities sort before RELATION entities, then by source area (smaller first). Missing coordinates, years outside coverage, and unrepresented areas produce an empty membership list; absence is not evidence that an area had no historical polity. Event coordinates themselves may be approximate or describe a related place.
- Chinese names use committed Wikidata label snapshots only when the source English name matches the entity's English label/alias. Source relations are translated as relations, not renamed after one component's QID. Project-reviewed name corrections take precedence; remaining names use machine translation (Google Translate). Per-entity `nameZhSource` is `wikidata`, `reviewed`, or `mt`; project review includes AI-assisted checking and does not mean official Chinese nomenclature. Final Chinese names are normalized to Simplified Chinese using OpenCC, without changing their provenance. English source names are retained unchanged. Wikidata structured labels are CC0: https://www.wikidata.org/wiki/Wikidata:Licensing.

## Known source limitations

The pinned release sometimes reuses historical names across periods or assigns a QID that is broader/different from the English source name. For example, the source retains Mali Federation, Serbia-Montenegro, and Estado Novo records through 2024; Later Zhou contains both -750 to -257 records and a 960 record; Tangier International Zone begins in 1912. These values are reproduced from the source, not dates inferred by this atlas. Chinese naming corrections translate the source identity; they do not validate every date, claim, or regime transition. A Wikidata Chinese label is a naming aid, not independent verification that the associated geometry and period are correct. The English source names, fixed release, and source links remain available for comparison.

Rebuild instructions and pinned inputs: `data/history/README.md` in the project repository. Data coverage is -3400 through 2024, with no year zero.
