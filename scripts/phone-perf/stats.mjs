// Frame-time statistics shared by the run and the report.

export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

const REFRESH_PERIODS_MS = [1000 / 144, 1000 / 120, 1000 / 90, 1000 / 60, 1000 / 30]

// The display's vsync period, from the fastest steady frames: the 10th
// percentile delta snapped to the nearest common refresh rate. A run where
// every frame misses reads as a slower panel, which is why the report shows
// the estimate next to the dropped share.
export function estimateRefreshPeriod(deltas) {
  const fast = percentile(deltas, 10)
  if (fast === null) return null
  let best = REFRESH_PERIODS_MS[0]
  for (const period of REFRESH_PERIODS_MS) {
    if (Math.abs(period - fast) < Math.abs(best - fast)) best = period
  }
  return best
}

// Share of vsync slots that showed no new frame: a delta of k periods means
// k - 1 slots were missed.
export function droppedFrameShare(deltas, periodMs) {
  if (deltas.length === 0 || !periodMs) return null
  let slots = 0
  let missed = 0
  for (const delta of deltas) {
    const span = Math.max(1, Math.round(delta / periodMs))
    slots += span
    missed += span - 1
  }
  return missed / slots
}

// periodMs: the display's vsync period when known (the phone reports its
// render rate); else estimated from the fastest frames, which reads a slower
// panel when every frame misses.
export function summariseFrames(deltas, periodMs = estimateRefreshPeriod(deltas)) {
  const total = deltas.reduce((sum, d) => sum + d, 0)
  return {
    frames: deltas.length,
    p50: percentile(deltas, 50),
    p95: percentile(deltas, 95),
    p99: percentile(deltas, 99),
    max: deltas.length ? Math.max(...deltas) : null,
    meanFps: total > 0 ? (deltas.length * 1000) / total : null,
    refreshHz: periodMs ? Math.round(1000 / periodMs) : null,
    droppedShare: droppedFrameShare(deltas, periodMs),
  }
}

// Spread of a per-run metric across repeated runs of one pose.
export function noiseBand(values) {
  const present = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (present.length === 0) return null
  const mean = present.reduce((s, v) => s + v, 0) / present.length
  const variance =
    present.length > 1
      ? present.reduce((s, v) => s + (v - mean) ** 2, 0) / (present.length - 1)
      : 0
  const min = Math.min(...present)
  const max = Math.max(...present)
  return {
    runs: present.length,
    mean,
    min,
    max,
    stdev: Math.sqrt(variance),
    spreadPct: mean > 0 ? ((max - min) / mean) * 100 : 0,
  }
}
