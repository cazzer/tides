import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { findDemo } from './demos'
import { reachedUntil, type DemoRun } from './demo-session'

/**
 * Stops the clock at the demo step's `until`. Mount it in the root Canvas
 * right after SimClock: the same priority (-1) runs it after SimClock's
 * advance and before the panels draw, so no frame shows the clock past it.
 */
export function DemoClock() {
  // The step's stop, parsed once a step. Read from the store each frame, not
  // a render: a step change or exit lands between renders, and a stale stop
  // would catch the clock's jump to the new date as a crossing.
  const step = useRef<{ run: DemoRun | null; until: number | null }>({ run: null, until: null })
  const previous = useRef<number | null>(null)
  useFrame(() => {
    const { demo, timestamp } = useStore.getState()
    if (demo !== step.current.run) {
      const until = demo && findDemo(demo.id)?.steps[demo.step]?.until
      step.current = { run: demo, until: until ? Date.parse(until) : null }
      previous.current = null
    }
    const { until } = step.current
    if (until != null && timestamp != null && reachedUntil(previous.current, timestamp, until)) {
      useStore.setState({ timestamp: until, timeScale: 0 })
      previous.current = until
      return
    }
    previous.current = timestamp
  }, -1)
  return null
}
