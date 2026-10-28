// The running step's demo-only aids (tides-zec.1), read straight from
// `s.demo` and the script, never stored: leaving the demo (demo null) turns
// every one off, and nothing of them reaches the URL.

import { useStore } from '../store'
import type { Demo, DemoAids } from './demo-script'
import type { DemoRun } from './demo-session'
import { findDemo } from './demos'

/** Steps 0..step's aids folded, each step's over the ones before. */
export function demoAidsAt(demo: Demo, step: number): DemoAids {
  const aids: DemoAids = {}
  for (const s of demo.steps.slice(0, step + 1)) Object.assign(aids, s.aids)
  return aids
}

export function demoAidOn(s: { demo: DemoRun | null }, key: keyof DemoAids): boolean {
  if (!s.demo) return false
  const demo = findDemo(s.demo.id)
  return demo ? demoAidsAt(demo, s.demo.step)[key] === true : false
}

/** Whether the running step has `key` on; re-renders only when that changes. */
export function useDemoAid(key: keyof DemoAids): boolean {
  return useStore((s) => demoAidOn(s, key))
}
