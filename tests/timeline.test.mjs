import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { DAY, MIN_TIME, MIN_YEAR, dateParts, getMaxTime, timestamp } from "../app/atlas-model.ts";
import { shiftCalendarTime, timelineTime, unitForYear } from "../app/timeline-model.ts";

const recordedYears = readdirSync(new URL("../public/data/events/year/", import.meta.url))
  .filter(name => /^-?\d+\.json$/.test(name))
  .map(name => Number(name.slice(0, -5)))
  .sort((a, b) => a - b);
const ancientYears = recordedYears.filter(year => year < -500);

test("timeline minimum matches the earliest real year shard", () => {
  assert.ok(recordedYears.length > 0, "the recorded history dataset must not be empty");
  assert.equal(MIN_YEAR, recordedYears[0]);
  assert.equal(MIN_TIME, timestamp(recordedYears[0]));
  assert.deepEqual(dateParts(MIN_TIME), { year: recordedYears[0], month: 1, day: 1 });
});

test("every recorded year before 500 BCE remains reachable on the timeline", () => {
  assert.ok(ancientYears.length > 0, "regression fixtures include history before the old -500 cutoff");
  for (const year of ancientYears) {
    const actual = timelineTime(timestamp(year, 6, 15), 2026);
    assert.deepEqual(dateParts(actual), { year, month: 1, day: 1 }, `recorded year ${year} must not be clamped away`);
  }
});

test("year and month keyboard travel cannot snap back to the same date", () => {
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(500), "year", 1, 2026)), { year: 501, month: 1, day: 1 });
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(500), "year", -1, 2026)), { year: 499, month: 1, day: 1 });
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(1453, 9), "month", 1, 2026)), { year: 1453, month: 10, day: 1 });
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(1453, 1), "month", -1, 2026)), { year: 1452, month: 12, day: 1 });
});

test("calendar travel crosses BCE without introducing year zero", () => {
  assert.equal(dateParts(shiftCalendarTime(timestamp(-1), "year", 1, 2026)).year, 1);
  assert.equal(dateParts(shiftCalendarTime(timestamp(1), "year", -1, 2026)).year, -1);
  assert.equal(dateParts(shiftCalendarTime(timestamp(-5), "year", 10, 2026)).year, 6);
});

test("day travel respects leap days and timeline boundaries", () => {
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(2000, 2, 28), "day", 1, 2026)), { year: 2000, month: 2, day: 29 });
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(1900, 2, 28), "day", 1, 2026)), { year: 1900, month: 3, day: 1 });
  assert.equal(shiftCalendarTime(MIN_TIME, "year", -1, 2026), MIN_TIME);
  assert.equal(shiftCalendarTime(getMaxTime(2026), "day", 1, 2026), getMaxTime(2026));
});

test("the dataset's earliest date remains the left boundary for pointer and keyboard navigation", () => {
  assert.equal(timelineTime(MIN_TIME, 2026), MIN_TIME);
  assert.equal(timelineTime(MIN_TIME - DAY, 2026), MIN_TIME);
  assert.equal(timelineTime(timestamp(MIN_YEAR - 100), 2026), MIN_TIME);
  for (const unit of ["day", "month", "year", "decade"]) {
    assert.equal(shiftCalendarTime(MIN_TIME, unit, -1, 2026), MIN_TIME, `${unit} cannot travel before the dataset`);
    assert.equal(shiftCalendarTime(MIN_TIME, unit, -10, 2026), MIN_TIME, `${unit} fast travel cannot pass the left boundary`);
  }
  assert.equal(shiftCalendarTime(MIN_TIME, "year", 1, 2026), timestamp(MIN_YEAR + 1));
  assert.equal(shiftCalendarTime(timestamp(MIN_YEAR + 1), "year", -1, 2026), MIN_TIME);
});

test("pointer dates use exact day indices while retaining historical scope", () => {
  const dates = [[MIN_YEAR, 1, 1], ...ancientYears.map(year => [year, 10, 23]), [-500, 1, 1], [-1, 12, 31], [500, 8, 20], [1453, 9, 15], [2026, 10, 23]];
  for (const [year, month, day] of dates) {
    const value = timestamp(year, month, day);
    const index = (value - MIN_TIME) / DAY;
    assert.equal(Number.isInteger(index), true);
    assert.equal(MIN_TIME + index * DAY, value);
    const normalized = timelineTime(value, 2026);
    assert.equal(dateParts(normalized).year, year);
    assert.equal(dateParts(normalized).month, unitForYear(year) === "year" ? 1 : month);
    assert.equal(dateParts(normalized).day, unitForYear(year) === "day" ? day : 1);
  }
});

test("calendar navigation makes progress across granularity transitions", () => {
  assert.equal(dateParts(shiftCalendarTime(timestamp(999), "year", 1, 2026)).year, 1000);
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(1899, 12), "month", 1, 2026)), { year: 1900, month: 1, day: 1 });
  assert.deepEqual(dateParts(shiftCalendarTime(timestamp(1900), "day", -1, 2026)), { year: 1899, month: 12, day: 1 });
});
