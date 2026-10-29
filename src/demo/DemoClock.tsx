import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { findDemo } from './demos'
import { reachedUntil, type DemoRun } from './demo-session'
import { DEMO_MAX_DELTA, travelTimestamp, type TravelRun } from './demo-travel'

/**
 * Carries the clock along a step's travel, and stops it at the step's
 * `until`. Mount it in the root Canvas right after SimClock: the same
 * priority (-1) runs it after SimClock's advance, so its write wins, and
 * before the panels draw, so no frame shows the clock past either.
 */
export function DemoClock() {
  // The step's stop, parsed once a step. Read from the store each frame, not
  // a render: a step change or exit lands between renders, and a stale stop
  // would catch the clock's jump to the new date as a crossing.
  const step = useRef<{ run: DemoRun | null; until: number | null }>({ run: null, until: null })
  const travel = useRef<{ run: TravelRun | null; elapsed: number }>({ run: null, elapsed: 0 })
  const previous = useRef<number | null>(null)
  useFrame((_, delta) => {
    const { demo, demoTravel, timestamp } = useStore.getState()
    if (demo !== step.current.run) {
      const until = demo && findDemo(demo.id)?.steps[demo.step]?.until
      step.current = { run: demo, until: until ? Date.parse(until) : null }
      previous.current = null
    }
    if (demoTravel !== travel.current.run) travel.current = { run: demoTravel, elapsed: 0 }
    if (demoTravel) {
      // No stop is checked on the way: a travel back past `until` isn't
      // reaching it, and the step's date is short of it anyway.
      travel.current.elapsed += Math.min(delta, DEMO_MAX_DELTA)
      const done = travel.current.elapsed >= demoTravel.seconds
      const t = done ? demoTravel.to : travelTimestamp(demoTravel, travel.current.elapsed)
      useStore.setState(done ? { timestamp: t, demoTravel: null } : { timestamp: t })
      previous.current = t
      return
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
