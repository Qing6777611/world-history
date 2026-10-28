# Modern geographic reference layers

These layers provide modern reference geography. Country, province/state
boundaries and city points use the following sources; coverage and administrative
levels vary by country. Historical polity boundaries are attributed separately
in [history/ATTRIBUTION.md](history/ATTRIBUTION.md).

- Cities and most first-level divisions: Natural Earth, public domain.
  https://www.naturalearthdata.com/about/terms-of-use/
  https://github.com/nvkelso/natural-earth-vector
  Chinese names, importance ranks and coordinates are retained from the source.
  Properties were reduced and boundary geometry simplified for display.
- China provinces: DataV.GeoAtlas.
  https://datav.aliyun.com/tools/atlas/
  https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
  Taiwan, Hong Kong and Macao remain under China in the atlas;
  no independent country entry is created.

Prepared on 2026-09-17. These simplified boundaries are for geographic context,
not surveying. City points and administrative areas are different data layers.

`cities.json` stores compact tuples `[name, country, lat, lng, rank, capital]`
to keep the first-load payload small; coordinates are rounded to three decimals.
Boundary files keep a `{features, source, sourceUrl, label}` wrapper and are
loaded per country on demand.

`land.geojson` dissolves the Natural Earth country polygons into a single
borderless land silhouette for historical mode. It retains modern coastlines
and lake holes and does not imply historical political affiliation. Rebuild with
`uv run scripts/build-land.py`; the Natural Earth public-domain terms also apply.
