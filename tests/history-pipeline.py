"""Run with the Python environment pinned by build-historical-geography.py."""
import importlib.util
import sys
from pathlib import Path
import unittest
from shapely.geometry import Point, Polygon

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('history_builder', Path(__file__).resolve().parents[1] / 'scripts/build-historical-geography.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class HistoricalPipelineTests(unittest.TestCase):
    def test_calendar_skips_zero_without_shifting_bce(self):
        self.assertEqual(builder.ordinal(1) - builder.ordinal(-1), 1)
        self.assertEqual(builder.normalize_range(-50, 0), (-50, -1))
        self.assertEqual(builder.normalize_range(-3400, -3201), (-3400, -3201))
        self.assertEqual(builder.historical_year(builder.ordinal(2024)), 2024)
        with self.assertRaises(ValueError):
            builder.ordinal(0)

    def test_dateline_split_preserves_hole_and_does_not_cover_greenwich(self):
        raw = {'type': 'Polygon', 'coordinates': [
            [[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]],
            [[175, -5], [175, 5], [-175, 5], [-175, -5], [175, -5]],
        ]}
        geom, count = builder.normalize_dateline(raw)
        self.assertEqual(count, 1)
        self.assertTrue(geom.is_valid)
        self.assertAlmostEqual(geom.area, 300)
        self.assertTrue(geom.covers(Point(171, 0)))
        self.assertTrue(geom.covers(Point(-171, 0)))
        self.assertFalse(geom.covers(Point(179, 0)))
        self.assertFalse(geom.covers(Point(0, 0)))
        self.assertGreaterEqual(geom.bounds[0], -180)
        self.assertLessEqual(geom.bounds[2], 180)

    def test_temporal_union_is_one_entity_and_keeps_no_year_zero(self):
        def record(start, end, geom):
            return {'polityId': 'clio-test', 'type': 'POLITY', 'from': start, 'to': end,
                    'geometry': geom, 'areaKm2': 1, 'memberOf': [], 'components': []}
        a = Polygon([(0, 0), (2, 0), (2, 2), (0, 2)])
        b = Polygon([(1, 0), (3, 0), (3, 2), (1, 2)])
        result = builder.temporal_segments([record(-2, 1, a), record(-1, 2, b)])
        self.assertEqual([(r['properties']['from'], r['properties']['to']) for r in result], [(-2, -2), (-1, 1), (2, 2)])
        self.assertAlmostEqual(result[1]['geometry'].area, 6)
        for year in [-2, -1, 1, 2]:
            self.assertEqual(sum(r['properties']['from'] <= year <= r['properties']['to'] for r in result), 1)

    def test_small_entities_are_not_removed_by_display_precision(self):
        small = Polygon([(0, 0), (.000001, 0), (.000001, .000001), (0, .000001)])
        shown = builder.display_geometry(small)
        self.assertEqual(shown['type'], 'Polygon')
        self.assertGreater(len(shown['coordinates'][0]), 3)

    def test_stable_identity_distinguishes_relations(self):
        self.assertEqual(builder.stable_id('Rome', 'POLITY'), builder.stable_id('Rome', 'POLITY'))
        self.assertNotEqual(builder.stable_id('Rome', 'POLITY'), builder.stable_id('Rome', 'RELATION'))


if __name__ == '__main__':
    unittest.main()
