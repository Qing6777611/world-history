# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["shapely==2.1.2", "numpy==2.5.4"]
# ///
"""Dissolve the existing modern basemap into a borderless land silhouette.

Run with Python and Shapely (the historical-data build environment includes it):
    uv run scripts/build-land.py
"""
import json
from pathlib import Path

from shapely import union_all
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.geometry.polygon import orient

root = Path(__file__).resolve().parents[1]
source = root / "public/data/countries.geojson"
destination = root / "public/data/land.geojson"
features = json.loads(source.read_text())["features"]
land = union_all([shape(feature["geometry"]) for feature in features])
assert land.is_valid, "Dissolved land must be valid before replacing the artifact"
parts = list(land.geoms) if isinstance(land, MultiPolygon) else [land]
# Match Globe.GL's clockwise exterior convention, including lake holes.
geometry = MultiPolygon([orient(part, sign=-1.0) for part in parts])
artifact = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"ADM0_A3": "__land__", "ATLAS_BACKGROUND": "true", "NAME_EN": "Land", "NAME_ZH": "陆地"},
        "geometry": mapping(geometry),
    }],
}
temporary = destination.with_suffix(".geojson.tmp")
temporary.write_text(json.dumps(artifact, separators=(",", ":"), ensure_ascii=False) + "\n")
temporary.replace(destination)
print(f"Dissolved {len(features)} countries into {len(parts)} land polygons: {destination.stat().st_size:,} bytes")
