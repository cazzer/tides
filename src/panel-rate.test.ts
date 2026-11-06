import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createPanelSchedule,
  PANEL_COPY_PRIORITY,
  PANEL_FULL_RATE_SPEED,
  PANEL_INPUT_MS,
  panelDrawDue,
  panelFrame,
  panelPeriodMs,
  panelsPaced,
  parsePanelRate,
  type PanelRateInput,
} from './panel-rate'

const AUTO = parsePanelRate('?panelhz=auto')
const still: PanelRateInput = { timeScale: 1, jumping: false, demo: false, interactingAt: null, now: 10_000 }

describe('parsePanelRate', () => {
  it('is off (every frame) by default on the high tier and for unreadable values', () => {
    for (const search of ['', '?panelhz=7', '?panelhz=abc', '?panelhz=']) {
      expect(parsePanelRate(search)).toEqual({ mode: 'fixed', hz: 60 })
      expect(panelsPaced(parsePanelRate(search))).toBe(false)
    }
  })
  it('is auto by default on the low tier (tides-0oi.41), and ?panelhz=60 turns it off', () => {
    for (const search of ['', '?panelhz=7', '?panelhz=']) expect(parsePanelRate(search, true)).toEqual({ mode: 'auto', hz: 15 })
    expect(panelsPaced(parsePanelRate('?panelhz=60', true))).toBe(false)
  })
  it('is auto at 15 Hz with ?panelhz=auto', () => {
    expect(parsePanelRate('?panelhz=auto')).toEqual({ mode: 'auto', hz: 15 })
  })
  it('takes the fixed rates', () => {
    for (const hz of [60, 30, 20, 15]) expect(parsePanelRate(`?panelhz=${hz}`)).toEqual({ mode: 'fixed', hz })
  })
  it('paces at all only below 60', () => {
    expect(panelsPaced(parsePanelRate('?panelhz=60'))).toBe(false)
    expect(panelsPaced(parsePanelRate('?panelhz=30'))).toBe(true)
    expect(panelsPaced(AUTO)).toBe(true)
  })
})

describe('panelPeriodMs', () => {
  it('is 15 Hz at real time and paused', () => {
    expect(panelPeriodMs(still, AUTO)).toBeCloseTo(1000 / 15)
    expect(panelPeriodMs({ ...still, timeScale: 0 }, AUTO)).toBeCloseTo(1000 / 15)
  })
  it('goes to the full rate from x3600 up, either way', () => {
    expect(panelPeriodMs({ ...still, timeScale: PANEL_FULL_RATE_SPEED - 1 }, AUTO)).toBeGreaterThan(0)
    for (const timeScale of [3600, 86400, 2592000, -3600]) {
      expect(panelPeriodMs({ ...still, timeScale }, AUTO)).toBe(0)
    }
  })
  it('goes to the full rate while a jump eases or a demo runs', () => {
    expect(panelPeriodMs({ ...still, jumping: true }, AUTO)).toBe(0)
    expect(panelPeriodMs({ ...still, demo: true }, AUTO)).toBe(0)
  })
  it('goes to the full rate for 500 ms after an input', () => {
    expect(panelPeriodMs({ ...still, interactingAt: still.now }, AUTO)).toBe(0)
    expect(panelPeriodMs({ ...still, interactingAt: still.now - PANEL_INPUT_MS + 1 }, AUTO)).toBe(0)
    expect(panelPeriodMs({ ...still, interactingAt: still.now - PANEL_INPUT_MS }, AUTO)).toBeGreaterThan(0)
  })
  it('holds a fixed rate whatever the speed', () => {
    const fixed15 = parsePanelRate('?panelhz=15')
    expect(panelPeriodMs({ ...still, timeScale: 86400, interactingAt: still.now }, fixed15)).toBeCloseTo(1000 / 15)
    expect(panelPeriodMs({ ...still, timeScale: 86400 }, parsePanelRate('?panelhz=20'))).toBe(50)
    expect(panelPeriodMs(still, parsePanelRate('?panelhz=60'))).toBe(0)
  })
})

/** Runs two panels over `seconds` at `hz` with jittered frame times; returns the draws per frame. */
function run(hz: number, seconds: number, periodMs: number, ids = ['top', 'bottom'], forcedOn = new Set<number>()) {
  const schedule = createPanelSchedule()
  const frames: string[][] = []
  const counts = new Map(ids.map((id) => [id, 0]))
  let t = 0
  for (let i = 0; i < hz * seconds; i++) {
    t += (1000 / hz) * (1 + 0.04 * Math.sin(i * 1.7))
    const drew = ids.filter((id) => panelDrawDue(schedule, id, t / 1000, periodMs, forcedOn.has(i)))
    for (const id of drew) counts.set(id, counts.get(id)! + 1)
    frames.push(drew)
  }
  return { frames, counts }
}

describe('panelDrawDue', () => {
  const period = 1000 / 15
  for (const hz of [60, 120]) {
    it(`draws each panel about 15 times a second at ${hz} Hz`, () => {
      const { counts } = run(hz, 10, period)
      for (const n of counts.values()) expect(n / 10).toBeGreaterThanOrEqual(14.5)
      for (const n of counts.values()) expect(n / 10).toBeLessThanOrEqual(15.5)
    })
    it(`never draws both panels in one frame at ${hz} Hz`, () => {
      const { frames } = run(hz, 10, period)
      expect(frames.slice(1).every((drew) => drew.length <= 1)).toBe(true)
    })
  }
  it("draws each panel 15 times a second, in turn, at the idle cap's 30 Hz (tides-0oi.31)", () => {
    const { frames, counts } = run(30, 10, period)
    for (const n of counts.values()) expect(n / 10).toBeGreaterThanOrEqual(14.5)
    for (const n of counts.values()) expect(n / 10).toBeLessThanOrEqual(15.5)
    expect(frames.slice(1).every((drew) => drew.length <= 1)).toBe(true)
  })
  it('draws both on the first frame (nothing held yet)', () => {
    expect(run(60, 1, period).frames[0]).toEqual(['top', 'bottom'])
  })
  it('draws both every frame at the full rate', () => {
    const { frames } = run(60, 1, 0)
    expect(frames.every((drew) => drew.length === 2)).toBe(true)
  })
  it('draws a forced panel at once, alongside the other', () => {
    const forced = new Set([30, 31, 32, 33])
    const { frames } = run(60, 2, period, ['top', 'bottom'], forced)
    for (const i of forced) expect(frames[i]).toEqual(['top', 'bottom'])
    // and the stagger resumes afterwards
    expect(frames.slice(34).every((drew) => drew.length <= 1)).toBe(true)
  })
  it('keeps a panel held after a gap in frames when it has just drawn', () => {
    const schedule = createPanelSchedule()
    panelDrawDue(schedule, 'a', 1, period, false)
    expect(panelDrawDue(schedule, 'a', 100, period, true)).toBe(true)
    expect(panelDrawDue(schedule, 'a', 100, period, false)).toBe(false)
    expect(panelDrawDue(schedule, 'a', 100 + 1 / 60, period, false)).toBe(false)
  })
  it('calls the same frame time one frame', () => {
    const schedule = createPanelSchedule()
    expect(panelDrawDue(schedule, 'a', 1, period, false)).toBe(true)
    expect(panelDrawDue(schedule, 'a', 1, period, false)).toBe(false)
  })
})

describe('panelFrame', () => {
  const rect = { x: 0, y: 0, z: 389, w: 400 }
  const paced = { ready: true, valid: true, rect, heldRect: rect, periodMs: 1000 / 15 }
  const notDue = (forced: boolean) => forced
  it('draws and copies on the first frame (no copy yet)', () => {
    expect(panelFrame({ ...paced, valid: false, heldRect: { x: 0, y: 0, z: 0, w: 0 } }, notDue)).toEqual({ draw: true, copy: true })
  })
  it('holds while the copy stands in and nothing is due', () => {
    expect(panelFrame(paced, notDue)).toEqual({ draw: false, copy: false })
    expect(panelFrame(paced, () => true)).toEqual({ draw: true, copy: true })
  })
  it('redraws at once after a pixel ratio or rect change', () => {
    expect(panelFrame({ ...paced, rect: { x: 0, y: 0, z: 292, w: 300 } }, notDue)).toEqual({ draw: true, copy: true })
    expect(panelFrame({ ...paced, rect: { ...rect, x: 1 } }, notDue)).toEqual({ draw: true, copy: true })
  })
  it('draws without a copy at the full rate, and redraws with one once paced again', () => {
    expect(panelFrame({ ...paced, periodMs: 0 }, () => true)).toEqual({ draw: true, copy: false })
    // the full-rate draw left no valid copy, so the first paced frame is forced
    expect(panelFrame({ ...paced, valid: false }, notDue)).toEqual({ draw: true, copy: true })
  })
  it('draws every frame and copies nothing until ready', () => {
    expect(panelFrame({ ...paced, ready: false }, notDue)).toEqual({ draw: true, copy: false })
  })
})

// Every useFrame in src, with its priority resolved through the constants it names.
function frameCallbackPriorities(): { file: string; arg: string; value: number | null }[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  const src = join(__dirname)
  walk(src)
  const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
  const constants = new Map<string, string>()
  for (const text of texts.values()) {
    for (const m of text.matchAll(/(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*([^\n;]+)/g)) constants.set(m[1], m[2].trim())
  }
  const resolve = (expr: string, depth = 0): number | null => {
    expr = expr.trim()
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr)
    const sum = expr.match(/^([A-Z][A-Z0-9_]*)\s*([+-])\s*(\d+(?:\.\d+)?)$/)
    if (sum && depth < 5) {
      const base = resolve(sum[1], depth + 1)
      return base === null ? null : base + (sum[2] === '+' ? 1 : -1) * Number(sum[3])
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(expr) && constants.has(expr) && depth < 5) return resolve(constants.get(expr)!, depth + 1)
    return null
  }
  const out: { file: string; arg: string; value: number | null }[] = []
  // useFrame, and hooks that pass their own `priority = n` parameter on to it (useShipAudioFrame).
  const hooks: { name: string; fallback: string | null }[] = [{ name: 'useFrame', fallback: '0' }]
  for (let h = 0; h < hooks.length; h++) {
    const { name, fallback } = hooks[h]
    for (const [file, text] of texts) {
      const call = name + '('
      let i = text.indexOf(call)
      while (i >= 0) {
        // the call's last top-level argument
        let depth = 0, j = i + call.length, commas = 0, lastComma = -1
        for (; j < text.length; j++) {
          const c = text[j]
          if ('([{'.includes(c)) depth++
          else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
          else if (c === ',' && depth === 0) { commas++; lastComma = j }
        }
        const line = text.slice(text.lastIndexOf('\n', i) + 1, i)
        const isDefinition = /function\s+$/.test(line) || /^\s*import\b/.test(line) || /[\w.]$/.test(line)
        if (!isDefinition) {
          const arg = (name === 'useFrame' ? lastComma < 0 : commas === 0) ? fallback ?? '' : text.slice(lastComma + 1, j).trim()
          const param = arg.match(/^[a-z]\w*$/)
          const wrapper = param && text.slice(0, i).match(new RegExp(`function\\s+(use\\w+)\\([^)]*\\b${arg}\\s*=\\s*([^,)]+)[^)]*\\)[^{]*\\{[^]*$`))
          if (wrapper) hooks.push({ name: wrapper[1], fallback: wrapper[2].trim() })
          else out.push({ file: relative(src, file), arg, value: resolve(arg) })
        }
        i = text.indexOf(call, j)
      }
    }
  }
  return out
}

describe('PANEL_COPY_PRIORITY', () => {
  it('comes after every other frame callback in src', () => {
    const calls = frameCallbackPriorities()
    expect(calls.some((c) => c.arg === 'PANEL_COPY_PRIORITY')).toBe(true)
    const others = calls.filter((c) => c.arg !== 'PANEL_COPY_PRIORITY')
    expect(others.length).toBeGreaterThan(10)
    expect(others.filter((c) => c.value === null)).toEqual([])
    expect(others.filter((c) => c.value! >= PANEL_COPY_PRIORITY)).toEqual([])
  })
})
