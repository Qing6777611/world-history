"use client";

import { useEffect, useState } from "react";
import { loadHistoricalEventIndex, loadHistoricalYear } from "../app/historical-geography";

type Snapshot = Awaited<ReturnType<typeof loadHistoricalYear>>;
type HistoryState = {
  year: number;
  status: "loading" | "ready" | "unavailable" | "error";
  snapshot: Snapshot | null;
  eventIndex: Record<string, string[]>;
};

const EMPTY_INDEX: Record<string, string[]> = {};

// A request belongs to one year. Stale responses may warm the bounded loader
// cache, but can never replace the year currently shown on the globe.
export function useHistoricalGeography(year: number, enabled: boolean, attempt: number) {
  const [state, setState] = useState<HistoryState>({ year, status: "loading", snapshot: null, eventIndex: EMPTY_INDEX });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear old geometry before fetching a different year or retrying.
    setState({ year, status: "loading", snapshot: null, eventIndex: EMPTY_INDEX });
    // Coalesce slider motion without delaying a stationary selection noticeably.
    const timer = setTimeout(() => {
      Promise.all([loadHistoricalYear(year), loadHistoricalEventIndex()]).then(([snapshot, eventIndex]) => {
        if (!cancelled) setState({ year, status: snapshot.status, snapshot, eventIndex });
      }).catch(() => {
        if (!cancelled) setState({ year, status: "error", snapshot: null, eventIndex: EMPTY_INDEX });
      });
    }, 100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [year, enabled, attempt]);
  return enabled && state.year === year ? state : { year, status: "loading" as const, snapshot: null, eventIndex: EMPTY_INDEX };
}
