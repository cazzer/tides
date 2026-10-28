import { describe, expect, it } from 'vitest'
import { holdRealTime } from './close-zoom-rules'

describe('holdRealTime', () => {
  it('holds faster speeds at real time in close zoom, keeping their direction, with a cue', () => {
    expect(holdRealTime(3600, true)).toEqual({ timeScale: 1, cue: true })
    expect(holdRealTime(-86400, true)).toEqual({ timeScale: -1, cue: true })
  })

  it('leaves real time, slower and paused as they are', () => {
    expect(holdRealTime(1, true)).toEqual({ timeScale: 1, cue: false })
    expect(holdRealTime(0, true)).toEqual({ timeScale: 0, cue: false })
    expect(holdRealTime(-1, true)).toEqual({ timeScale: -1, cue: false })
  })

  it('leaves everything as it is outside close zoom', () => {
    expect(holdRealTime(3600, false)).toEqual({ timeScale: 3600, cue: false })
  })
})
