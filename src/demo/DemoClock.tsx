import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { findDemo } from './demos'
import { demoClockFrame, demoClockTrack, type DemoRun } from './demo-session'
import { setEarthSpinHold } from './demo-travel'

/**
 * Carries the clock along a step's travel, and stops it at the step's
 * `until` (demoClockFrame). Mount it in the root Canvas right after
 * SimClock: the same priority (-1) runs it after SimClock's advance, so its
 * write wins, and before the panels draw, so no frame shows the clock past
 * either. A travel that holds the spin sets Earth's held spin here too.
 */
export function DemoClock() {
  // The step's stop, parsed once a step. Read from the store each frame, not
  // a render: a step change or exit lands between renders, and a stale stop
  // would catch the clock's jump to the new date as a crossing.
  const step = useRef<{ run: DemoRun | null; until: number | null }>({ run: null, until: null })
  const track = useRef(demoClockTrack())
  useFrame((_, delta) => {
    const { demo, demoTravel, timestamp } = useStore.getState()
    if (demo !== step.current.run) {
      const until = demo && findDemo(demo.id)?.steps[demo.step]?.until
      step.current = { run: demo, until: until ? Date.parse(until) : null }
      track.current.previous = null
    }
    const { write, hold } = demoClockFrame(track.current, demoTravel, timestamp, step.current.until, delta)
    setEarthSpinHold(hold)
    if (write) useStore.setState(write)
  }, -1)
  useEffect(() => () => setEarthSpinHold(null), [])
  return null
}
