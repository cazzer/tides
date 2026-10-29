import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { findDemo } from './demos'
import { prefersReducedMotion } from '../ship/reduced-motion'
import {
  demoClockFrame,
  demoClockTrack,
  demoStepSpan,
  restartDemoClockTrack,
  type DemoRun,
  type DemoSpan,
} from './demo-session'
import { setEarthSpinHold } from './demo-travel'

/**
 * Carries the clock along a step's travel, plays its loop and speed changes,
 * and stops it at the step's `until` (demoClockFrame). Mount it in the root Canvas right after
 * SimClock: the same priority (-1) runs it after SimClock's advance, so its
 * write wins, and before the panels draw, so no frame shows the clock past
 * either. A travel that holds the spin sets Earth's held spin here too.
 */
export function DemoClock() {
  // The step's stop, parsed once a step. Read from the store each frame, not
  // a render: a step change or exit lands between renders, and a stale stop
  // would catch the clock's jump to the new date as a crossing.
  const step = useRef<{ run: DemoRun | null; until: number | null; span: DemoSpan | null }>({
    run: null,
    until: null,
    span: null,
  })
  const track = useRef(demoClockTrack())
  useFrame((_, delta) => {
    const { demo, demoSaved, demoTravel, demoReplay, timestamp, timeScale } = useStore.getState()
    if (demo !== step.current.run) {
      const script = demo && findDemo(demo.id)
      const until = script?.steps[demo.step]?.until
      const span = script && demoSaved ? demoStepSpan(demoSaved, script, demo.step, prefersReducedMotion()) : null
      step.current = { run: demo, until: until ? Date.parse(until) : null, span }
      restartDemoClockTrack(track.current)
    }
    const clock = { span: step.current.span, replay: demoReplay, timeScale }
    const { write, hold } = demoClockFrame(track.current, demoTravel, timestamp, step.current.until, delta, clock)
    setEarthSpinHold(hold)
    if (write) useStore.setState(write)
  }, -1)
  useEffect(() => () => setEarthSpinHold(null), [])
  return null
}
