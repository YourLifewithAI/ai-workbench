// A media query as React state. `useSyncExternalStore` so the value is right on the first render and follows the
// window: the village exists at `md` and above (D-71), and the phone layout below it must be exactly what it was.
import { useSyncExternalStore } from 'react';

/** Tailwind v4's `md` breakpoint. A rem in a media query is always the initial 16px, so this is 768px. */
export const MD = '(min-width: 48rem)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
