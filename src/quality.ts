// The device's quality tier (tides-qlu), the one place that decides it:
// ?quality=low or ?quality=high in the URL, else the choice saved in Settings
// (tides-lh5), else low on phones and tablets (by user agent) and high
// everywhere else. Texture sets and mesh detail all read it once at load, so a
// device never mixes tiers and a new choice applies on reload.
export type QualityTier = 'low' | 'high'
export type QualityChoice = 'auto' | QualityTier

const QUALITY_KEY = 'tides.quality'

/** The tier the URL or the saved choice forces, or null to go by user agent. */
function forcedTier(search: string, saved: string | null): QualityTier | null {
  const override = new URLSearchParams(search).get('quality')
  if (override === 'low' || override === 'high') return override
  return saved === 'low' || saved === 'high' ? saved : null
}

export function resolveQualityTier(search: string, userAgent: string, saved: string | null = null): QualityTier {
  return forcedTier(search, saved) ?? (/Android|iPhone|iPad|iPod|Mobi/i.test(userAgent) ? 'low' : 'high')
}

/** The choice saved on this device; 'auto' when none, or storage is unavailable. */
export function savedQualityChoice(): QualityChoice {
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(QUALITY_KEY)
    return saved === 'low' || saved === 'high' ? saved : 'auto'
  } catch {
    return 'auto'
  }
}

/** Saves the choice for the next load; false when storage refused it. */
export function saveQualityChoice(choice: QualityChoice): boolean {
  try {
    if (choice === 'auto') localStorage.removeItem(QUALITY_KEY)
    else localStorage.setItem(QUALITY_KEY, choice)
    return true
  } catch {
    return false
  }
}

/** This page's tier; high outside a browser. */
export function qualityTier(): QualityTier {
  if (typeof window === 'undefined') return 'high'
  return resolveQualityTier(window.location.search, navigator.userAgent, savedQualityChoice())
}

export function isLowQuality(): boolean {
  return qualityTier() === 'low'
}

/**
 * iPadOS reports a desktop Safari UA ("Macintosh"); only its touch points
 * tell it from a Mac, which reports 0.
 */
export function isTouchMac(userAgent: string, maxTouchPoints: number): boolean {
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1
}

/**
 * The widest flight-only map (tides-01v.6) this device fetches, or null for
 * none: 8k on desktops, 4k on phones and tablets, iPads included (their tier
 * stays 'high' for the Earth maps, but an 8k map is a third of a phone-class
 * memory budget), and never wider than the GPU takes.
 */
export function resolveFlightTextureCap(
  search: string,
  userAgent: string,
  maxTouchPoints: number,
  maxTextureSize: number,
  saved: string | null = null
): 8192 | 4096 | null {
  const forced = forcedTier(search, saved)
  const mobile =
    forced === 'low' ||
    (forced !== 'high' && (resolveQualityTier('', userAgent) === 'low' || isTouchMac(userAgent, maxTouchPoints)))
  const cap = mobile ? 4096 : 8192
  if (maxTextureSize >= cap) return cap
  return maxTextureSize >= 4096 ? 4096 : null
}

/** This page's flight map cap; 8k outside a browser. */
export function flightTextureCap(maxTextureSize: number): 8192 | 4096 | null {
  if (typeof window === 'undefined') return 8192
  return resolveFlightTextureCap(
    window.location.search,
    navigator.userAgent,
    navigator.maxTouchPoints ?? 0,
    maxTextureSize,
    savedQualityChoice()
  )
}
