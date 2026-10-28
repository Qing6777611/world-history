import { clampTime, dateParts, timestamp } from "./atlas-model";
import type { Tier } from "./events-db";

export const unitForYear = (year: number): Tier => year >= 1900 ? "day" : year >= 1000 ? "month" : "year";

export function snapToUnit(value: number, unit: Tier) {
  const { year, month, day } = dateParts(value);
  if (unit === "decade") return timestamp(Math.floor(year / 10) * 10 || 1, 1, 1);
  if (unit === "year") return timestamp(year, 1, 1);
  if (unit === "month") return timestamp(year, month, 1);
  return timestamp(year, month, day);
}

export function timelineTime(value: number, endYear: number) {
  const clamped = clampTime(Math.round(value), endYear);
  return snapToUnit(clamped, unitForYear(dateParts(clamped).year));
}

/** Advance calendar units, not approximate durations aligned to the slider's minimum. */
export function shiftCalendarTime(value: number, unit: Tier, amount: number, endYear: number) {
  const date = new Date(value);
  if (unit === "day") date.setUTCDate(date.getUTCDate() + amount);
  else if (unit === "month") {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + amount);
  } else {
    date.setUTCMonth(0, 1);
    // Date's astronomical year 0 represents 1 BCE, so crossing the era skips civil year 0.
    date.setUTCFullYear(date.getUTCFullYear() + amount * (unit === "decade" ? 10 : 1));
  }
  return timelineTime(date.getTime(), endYear);
}
