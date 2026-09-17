# Modern geographic reference layers

The timeline does not reconstruct historical administrative borders. Country,
province/state and local divisions are modern reference geography from the
following sources. Coverage and administrative levels vary by country.

- Cities and most first-level divisions: Natural Earth, public domain.
  https://www.naturalearthdata.com/about/terms-of-use/
  https://github.com/nvkelso/natural-earth-vector
  Chinese names, importance ranks and coordinates are retained from the source.
  Properties were reduced and boundary geometry simplified for display.
- China provinces and prefecture/city/district divisions: DataV.GeoAtlas.
  https://datav.aliyun.com/tools/atlas/
  https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
  Taiwan, Hong Kong and Macao remain under China in the atlas. Their local
  divisions are from Natural Earth; no independent country entry is created.
- Second-level divisions outside China: geoBoundaries gbOpen, CC BY 4.0,
  https://www.geoboundaries.org/ and https://www.geoboundaries.org/api.html
  https://creativecommons.org/licenses/by/4.0/
  Underlying US county geometry: US Census Bureau MAF/TIGER, 2018, public domain.
  https://www.geoboundaries.org/api/current/gbOpen/USA/ADM2/
  Other countries are fetched on demand and keep the source's reference year.

Prepared on 2026-09-17. These simplified boundaries are for geographic context,
not surveying. City points and administrative areas are different data layers.
