import type { DistanceScale } from '../distance-scale'

/** What every system-view aid is given (see SystemAids.tsx). */
export interface SystemAidProps {
  /** Which spacing the bodies use, so an aid lines up with them. */
  distanceScale: DistanceScale
  /** In ship mode; each aid decides whether it shows there. */
  ship: boolean
}
