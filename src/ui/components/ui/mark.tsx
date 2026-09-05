// The mark (L5): a bench with a light above it, the same drawing as /favicon.svg, the Home Screen icons and the
// push notification's icon. Inline so it takes no request and never flashes.
export function Mark({ size = 22, className }: { size?: number; className?: string | undefined }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" className={className}>
      <rect width="64" height="64" rx="14" fill="#1e2952" />
      <circle cx="32" cy="21" r="8" fill="#38bdf8" />
      <rect x="12" y="35" width="40" height="7" rx="3.5" fill="#ffffff" />
      <rect x="16" y="42" width="6" height="11" rx="2" fill="#ffffff" />
      <rect x="42" y="42" width="6" height="11" rx="2" fill="#ffffff" />
    </svg>
  );
}
