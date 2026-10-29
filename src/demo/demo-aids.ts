// The running step's demo-only aids (tides-zec.1), read straight from
// `s.demo` and the script, never stored: leaving the demo (demo null) turns
// every one off, and nothing of them reaches the URL.

import { useStore } from '../store'
import type { Demo, DemoAids } from './demo-script'
import type { DemoRun } from './demo-session'
import { findDemo } from './demos'

/**
 * Whether `key` is on at `step`: as the latest step up to it that sets it
 * left it. A plain loop, no allocation: the store selector runs on every
 * clock tick.
 */
export function demoAidAt(demo: Demo, step: number, key: keyof DemoAids): boolean {
  for (let i = Math.min(step, demo.steps.length - 1); i >= 0; i--) {
    const on = demo.steps[i].aids?.[key]
    if (on !== undefined) return on
  }
  return false
}

export function demoAidOn(s: { demo: DemoRun | null }, key: keyof DemoAids): boolean {
  if (!s.demo) return false
  const demo = findDemo(s.demo.id)
  return demo ? demoAidAt(demo, s.demo.step, key) : false
}

/**
 * Whether the main view hides the Moon: a demo travel's hold (every view)
 * or the step's aids.hideMoon (the main view's). Its name and orbit loop go
 * with it (BodyLabels, OrbitGuides).
 */
export function mainViewHidesMoon(s: { demo: DemoRun | null; demoTravel: { hideMoon: boolean } | null }): boolean {
  return (s.demoTravel?.hideMoon ?? false) || demoAidOn(s, 'hideMoon')
}

/** Whether the running step has `key` on; re-renders only when that changes. */
export function useDemoAid(key: keyof DemoAids): boolean {
  return useStore((s) => demoAidOn(s, key))
}
