import { useStore } from '../store'
import { formatDemoTime } from './demo-script'

const MINUTE = 60_000

/**
 * Writes the demo clock's text ('' before the clock starts) now and whenever
 * the sim time crosses into another minute, outside React: at a demo's 3600×
 * the timestamp changes every frame, and a re-render per frame for a clock
 * shown to the minute is wasted. Returns the unsubscribe.
 */
export function subscribeDemoTime(write: (text: string) => void): () => void {
  let written: number | null | undefined
  const update = (timestamp: number | null) => {
    const minute = timestamp == null ? null : Math.floor(timestamp / MINUTE)
    if (minute === written) return
    written = minute
    write(minute == null ? '' : formatDemoTime(minute * MINUTE))
  }
  update(useStore.getState().timestamp)
  return useStore.subscribe((s, prev) => {
    if (s.timestamp !== prev.timestamp) update(s.timestamp)
  })
}
