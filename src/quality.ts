// The device's quality tier (tides-qlu), the one place that decides it:
// ?quality=low or ?quality=high in the URL, else low on phones and tablets
// (by user agent) and high everywhere else. Texture sets and mesh detail all
// read it, so a device never mixes tiers.
export type QualityTier = 'low' | 'high'

export function resolveQualityTier(search: string, userAgent: string): QualityTier {
  const override = new URLSearchParams(search).get('quality')
  if (override === 'low' || override === 'high') return override
  return /Android|iPhone|iPad|iPod|Mobi/i.test(userAgent) ? 'low' : 'high'
}

/** This page's tier; high outside a browser. */
export function qualityTier(): QualityTier {
  if (typeof window === 'undefined') return 'high'
  return resolveQualityTier(window.location.search, navigator.userAgent)
}

export function isLowQuality(): boolean {
  return qualityTier() === 'low'
}
