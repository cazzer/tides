import { useProgress } from '@react-three/drei'
import { useEffect, useMemo, useState } from 'react'

const FADE_OUT_MS = 450

function getItemName(item?: string) {
  if (!item) return ''
  try {
    const pathname = item.includes('://') ? new URL(item).pathname : item
    const segments = pathname.split('/')
    return decodeURIComponent(segments[segments.length - 1] || item)
  } catch {
    const segments = item.split('/')
    return segments[segments.length - 1] || item
  }
}

export default function LoadingOverlay({
  sceneReady,
}: {
  sceneReady: boolean
}) {
  const { active, progress, item, loaded, total } = useProgress()
  const [isVisible, setIsVisible] = useState(true)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const assetsLoaded = total > 0 && loaded >= total && !active
  const canHide = assetsLoaded && sceneReady

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
      const timeout = window.setTimeout(() => {
        setIsVisible(false)
      }, FADE_OUT_MS)

      return () => {
        window.clearTimeout(timeout)
      }
    }
  }, [active, sceneReady, canHide])

  const clampedProgress = Math.max(0, Math.min(100, progress || 0))

  const statusText = useMemo(() => {
    if (active && total > 0) {
      const assetName = getItemName(item)
      if (assetName) {
        return `Loading ${Math.min(loaded, total)}/${total}: ${assetName}`
      }
      return `Loading ${Math.min(loaded, total)}/${total} assets...`
    }

    if (assetsLoaded && !sceneReady) {
      return 'Spinning up orbits...'
    }

    if (active) {
      return 'Painting the planets...'
    }

    return 'Done'
  }, [active, assetsLoaded, item, loaded, sceneReady, total])

  if (!isVisible) return null

  return (
    <div
      className={`loading-overlay ${isFadingOut ? 'loading-overlay--hidden' : ''}`}
      aria-live="polite"
      aria-busy={active}
      role="status"
    >
      <div className="loading-overlay__content">
        <div className="loading-overlay__bar-bg">
          <div
            className="loading-overlay__bar-fill"
            style={{ width: `${clampedProgress}%` }}
          />
        </div>
        <div className="loading-overlay__subtext">{statusText}</div>
      </div>
    </div>
  )
}
