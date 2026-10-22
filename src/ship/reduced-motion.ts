// The live prefers-reduced-motion setting, cheap enough to read every frame
// (MediaQueryList.matches tracks changes without a listener).

let query: MediaQueryList | null | undefined

export function prefersReducedMotion(): boolean {
  if (query === undefined) {
    query =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
  }
  return query?.matches ?? false
}
