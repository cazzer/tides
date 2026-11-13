// How the system view's aids letter their labels (tides-2hv.10), so body
// names and any other aid's labels (tides-2hv.9's AU rings) read as one
// family. The labels are troika text through drei's <Text>, in its default
// font, as the month names and clock are (orbit-label.tsx).

/**
 * Body names' cap-to-baseline size on screen, CSS px: the Sun, Earth and the
 * planets, then every moon (Earth's included). [TUNE] Under ~11 px the
 * outline eats the counters on a 2× phone; over ~14 they crowd the clock.
 */
export const BODY_LABEL_PX = 13
export const MOON_LABEL_PX = 11.5

/**
 * Taken off both sizes on a phone-width view (PHONE_VIEW_PX), where the same
 * label covers a larger share of the screen. [TUNE]
 */
export const PHONE_LABEL_SHRINK_PX = 1

/** A view this wide or narrower letters at phone size; index.css's breakpoint. */
export const PHONE_VIEW_PX = 600

/**
 * A soft grey: near-white (#d8d8d8) was jarring against the black sky
 * (tides-ufyr.24). Still brighter than the month names' grey (#404040),
 * which recede on purpose; a name has to read against the starfield and the
 * planets' orbit lines. The fades (labelOpacity, resolveLabels) scale its
 * opacity, so this is the colour at full strength.
 */
export const LABEL_COLOR = '#9aa0a6'

/** A dark edge, as the clock has, so a name stays readable over the Sun. */
export const LABEL_OUTLINE_WIDTH = '8%'
export const LABEL_OUTLINE_COLOR = 'black'

/** Gap between a body's disc (or ring edge) and its label, CSS px. [TUNE] */
export const LABEL_GAP_PX = 6
