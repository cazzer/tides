import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { findDemo } from './demos'
import { reachedUntil } from './demo-session'

/**
 * Stops the clock at the demo step's `until`. Mount it in the root Canvas
 * right after SimClock: the same priority (-1) runs it after SimClock's
 * advance and before the panels draw, so no frame shows the clock past it.
 */
export function DemoClock() {
  const previous = useRef<number | null>(null)
  useFrame(() => {
    const { demo, timestamp } = useStore.getState()
    const until = demo && findDemo(demo.id)?.steps[demo.step]?.until
    if (until && timestamp != null) {
      const stop = Date.parse(until)
      if (reachedUntil(previous.current, timestamp, stop)) {
        useStore.setState({ timestamp: stop, timeScale: 0 })
        previous.current = stop
        return
      }
    }
    previous.current = timestamp
  }, -1)
  return null
}
