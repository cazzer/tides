import { useProgress } from '@react-three/drei'
import { useEffect, useState } from 'react'
import { startOpening } from './opening'
import { prefersReducedMotion } from './ship/reduced-motion'

/**
 * How long the overlay takes to fade into the scene, ms: long enough to
 * overlap the opening move's start (opening.ts), which begins with it. Under
 * reduced motion, a short plain fade.
 */
export const FADE_OUT_MS = 1200
export const REDUCED_FADE_OUT_MS = 400

const MARK_URL = `${import.meta.env.BASE_URL}icon.svg`

export default function LoadingOverlay({
  sceneReady,
}: {
  sceneReady: boolean
}) {
  const { active, progress, loaded, total } = useProgress()
  const [isVisible, setIsVisible] = useState(true)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const assetsLoaded = total > 0 && loaded >= total && !active
  const canHide = assetsLoaded && sceneReady
  const fadeMs = prefersReducedMotion() ? REDUCED_FADE_OUT_MS : FADE_OUT_MS

  useEffect(() => {
    // Only the first load covers the app; a view mounted later (single
    // layout) loads its assets behind the scenes.
    if (active && !sceneReady) {
      setIsVisible(true)
      setIsFadingOut(false)
      return
    }

    if (canHide) {
      setIsFadingOut(true)
      startOpening(performance.now())
      const timeout = window.setTimeout(() => {
        setIsVisible(false)
      }, fadeMs)

      return () => {
        window.clearTimeout(timeout)
      }
    }
  }, [active, sceneReady, canHide, fadeMs])

  // Assets are most of the wait; the last stretch is the scene compiling.
  const shown = assetsLoaded ? 100 : Math.max(0, Math.min(100, progress || 0)) * 0.9

  if (!isVisible) return null

  return (
    <div
      className={`loading-overlay ${isFadingOut ? 'loading-overlay--hidden' : ''}`}
      style={{ transitionDuration: `${fadeMs}ms` }}
    >
      {/* Said once as it loads and once as it's ready; the bar's value
          changes are attributes, which a live region doesn't read out. */}
      <p
        className="visually-hidden"
        aria-live="polite"
      >
        {isFadingOut ? 'Tides is ready' : 'Loading Tides'}
      </p>
      <div
        className="loading-overlay__content"
        aria-hidden={isFadingOut || undefined}
      >
        <img
          className="loading-overlay__mark"
          src={MARK_URL}
          alt=""
          width={96}
          height={96}
        />
        <div className="loading-overlay__name">Tides</div>
        <div
          className="loading-overlay__bar-bg"
          role="progressbar"
          aria-label="Loading"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shown)}
        >
          <div
            className="loading-overlay__bar-fill"
            style={{ transform: `scaleX(${shown / 100})` }}
          />
        </div>
      </div>
    </div>
  )
}
