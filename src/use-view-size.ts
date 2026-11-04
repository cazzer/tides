// The view's size and place in CSS px as they are now, for code that lays
// things out in screen px each frame. Inside a drei <View>, r3f's `size` is
// the tracked element's rect as of the last time the view re-rendered (drei's
// CanvasView), so after a layout change it can stay at the old panel's size
// until something re-renders the app. This reads the element the view's
// events are connected to (the tracked element) through a ResizeObserver and
// on the window's resize instead, into a ref: no re-render, and no reading
// layout in the frame loop.
import { useCallback, useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import type { ViewSize } from './main-view'

/** The view's size, and its top left corner in viewport px. */
export interface ViewRect extends ViewSize {
  left: number
  top: number
}

/** The live rect, or `fallback` (r3f's size) before the element is known. */
export function useViewSize(): (fallback: ViewRect) => ViewRect {
  const element = useThree((s) => s.events.connected as HTMLElement | undefined)
  const size = useRef<ViewRect>({ width: 0, height: 0, left: 0, top: 0 })

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return
    const live = size.current
    const read = () => {
      const rect = element.getBoundingClientRect()
      live.width = element.clientWidth
      live.height = element.clientHeight
      live.left = rect.left
      live.top = rect.top
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    window.addEventListener('resize', read)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', read)
      live.width = 0
      live.height = 0
    }
  }, [element])

  // Stable: the ref is read when called, in the frame loop.
  return useCallback(
    (fallback: ViewRect) => (size.current.width > 0 && size.current.height > 0 ? size.current : fallback),
    []
  )
}
