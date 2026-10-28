import { useEffect, useRef } from "react";

/**
 * Keep a ref pointed at the newest value without writing to it during render.
 * Use it for callbacks and imperative bridges that read state after a commit.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
