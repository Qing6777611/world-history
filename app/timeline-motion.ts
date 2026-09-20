// Timeline input → sustained time-machine rotation → an inertial slowdown.
// Store input separately from the date so calendar edits and data refreshes
// never spin the camera. Speed is measured in timeline widths per second.
export type TimelineMotion = {
  velocity: number;
  updatedAt: number;
  releasedAt: number | null;
};

export const MAX_TIME_TRAVEL_SPEED = 1080;

export function timelineTravelSpeed(input: TimelineMotion, now: number, forward: number) {
  if (!input.velocity) return 0;
  // After release, retain the momentum present at that instant instead of
  // applying both the input-age and release decays to the same gesture.
  const heldUntil=input.releasedAt ?? now;
  const heldAge=Math.max(0,heldUntil-input.updatedAt-180);
  const releaseAge=input.releasedAt===null ? 0 : Math.max(0,now-input.releasedAt);
  const envelope=Math.exp(-heldAge/450-releaseAge/520);
  if (envelope < .002) return 0;
  const speed = 24 + (MAX_TIME_TRAVEL_SPEED - 24) * (1 - Math.exp(-Math.abs(input.velocity) * 7));
  return Math.sign(input.velocity) * forward * speed * envelope;
}
