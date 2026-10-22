import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from './store'
import { SURFACE_FOV } from './sky'
import { RESET_DURATION, easeLook } from './sky-look'
import { defaultLook, lookOnDrag, type Reset } from './sky-look-drag'
import { easeFov } from './sky-zoom'
import { useSkyZoom } from './sky-zoom-gesture'

/**
 * Drag to look around View from Earth (tides-2dp) and pinch to zoom
 * (tides-2j7): the sky follows the pointer, and a double tap eases back
 * to the default view facing the equator, zoomed out. Listens on the
 * panel's own element (the View's tracking div), so the main view's
 * OrbitControls and the panel label keep their pointers; presses that move
 * less than DRAG_THRESHOLD stay taps.
 */
export function SkyLookControls() {
  const element = useThree((s) => s.events.connected) as HTMLElement | undefined
  // Until drei's View hands over its div, the portal inherits the canvas's
  // event source, which spans every panel.
  const shared = useThree((s) => s.previousRoot?.getState().events.connected)
  const reset = useRef<Reset | null>(null)

  const panel = element !== shared ? element : undefined

  useEffect(() => (panel ? lookOnDrag(panel, reset) : undefined), [panel])
  useSkyZoom(panel, reset)

  useFrame(() => {
    const easing = reset.current
    if (!easing) return
    // Compass mode, turned back on mid-ease, owns the view.
    if (useStore.getState().compass) {
      reset.current = null
      return
    }
    const t = (performance.now() - easing.start) / RESET_DURATION
    if (t >= 1) {
      reset.current = null
      useStore.setState({ skyLook: null, skyFov: null })
    } else {
      useStore.setState({
        skyLook: easeLook(easing.from, defaultLook(), t),
        skyFov: easeFov(easing.fromFov, SURFACE_FOV, t),
      })
    }
  })

  return null
}
