// Timeline input → a brief directional impulse → smooth return to idle.
// Store input separately from the date so calendar edits and data refreshes
// never spin the camera. Speed is measured in timeline widths per second.
export type TimelineMotion = {
  velocity: number;
  updatedAt: number;
  releasedAt: number | null;
};

export const MAX_TIME_TRAVEL_SPEED = 180;

export function timelineTravelSpeed(input: TimelineMotion, now: number, forward: number) {
  if (!input.velocity) return 0;
  const age = Math.max(0, now - input.updatedAt - 80);
  const releaseAge = input.releasedAt === null ? 0 : Math.max(0, now - input.releasedAt);
  const envelope = Math.exp(-age / 130 - releaseAge / 220);
  if (envelope < .01) return 0;
  const speed = 24 + (MAX_TIME_TRAVEL_SPEED - 24) * (1 - Math.exp(-Math.abs(input.velocity) * 4));
  return Math.sign(input.velocity) * forward * speed * envelope;
}
