/** Blueprint's mark: a table card on a drafting grid, in the ink color. */
export function BlueprintLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect width="24" height="24" rx="6" fill="hsl(var(--foreground))" />
      <path d="M6 6h12v12H6z" stroke="hsl(var(--background))" strokeOpacity=".3" strokeDasharray="1.5 1.5" />
      <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="hsl(var(--background))" />
      <path d="M7.5 10.5h9M10.5 10.5v6" stroke="hsl(var(--foreground))" strokeWidth="1.2" />
    </svg>
  );
}
