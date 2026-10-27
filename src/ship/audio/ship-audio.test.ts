import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShipAudio, playShipCue, type ShipAudioDeps, type ShipCue } from './ship-audio'

// Just enough of an AudioContext. State changes land at once and fire
// statechange, as they would once the browser's promise settles; with
// `deferred` they wait for settle(), as a real resume or suspend does.
class FakeAudioContext {
  state: AudioContextState | 'interrupted' = 'running'
  currentTime = 2
  destination = { kind: 'destination' }
  resumes = 0
  suspends = 0
  /** Turn resumes down, as iOS does outside a gesture. */
  refuse = false
  deferred = false
  pending: (() => void)[] = []
  listeners: (() => void)[] = []
  gains: {
    gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> }
    connect: ReturnType<typeof vi.fn>
  }[] = []

  createGain() {
    const node = { gain: { value: -1, setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() }, connect: vi.fn() }
    this.gains.push(node)
    return node
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'statechange') this.listeners.push(listener)
  }
  resume() {
    this.resumes++
    if (this.refuse) return Promise.reject(new Error('not allowed'))
    return this.change('running')
  }
  suspend() {
    this.suspends++
    return this.change('suspended')
  }
  change(state: FakeAudioContext['state']) {
    if (!this.deferred) {
      this.set(state)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.pending.push(() => {
        this.set(state)
        resolve()
      })
    })
  }
  /** Lands every resume and suspend asked for so far, in order. */
  settle() {
    for (const land of this.pending.splice(0)) land()
  }
  set(state: FakeAudioContext['state']) {
    if (this.state === state) return
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

function setup(overrides: Partial<ShipAudioDeps> = {}) {
  const contexts: FakeAudioContext[] = []
  const storage = fakeStorage()
  const deps: ShipAudioDeps = {
    createContext: () => {
      const context = new FakeAudioContext()
      contexts.push(context)
      return context as unknown as AudioContext
    },
    storage,
    hasActivation: () => true,
    ...overrides,
  }
  const audio = createShipAudio(deps)
  const context = () => contexts[0]
  return { audio, contexts, context, storage }
}

// The fade out before a suspend (SUSPEND_DELAY_MS).
const SUSPEND_DELAY_MS = 100

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ship audio unlock (tides-a4j.1)', () => {
  it('makes no context until a gesture in ship mode', () => {
    const { audio, contexts } = setup()
    audio.gesture()
    expect(contexts).toHaveLength(0)
    audio.activate()
    expect(contexts).toHaveLength(0)
    expect(audio.output()).toBeNull()
    audio.gesture()
    expect(contexts).toHaveLength(1)
  })

  it('makes none when the browser reports no user activation', () => {
    const { audio, contexts } = setup({ hasActivation: () => false })
    audio.activate()
    audio.gesture()
    expect(contexts).toHaveLength(0)
    expect(audio.output()).toBeNull()
  })

  it('makes exactly one context across gestures and flights', () => {
    const { audio, contexts } = setup()
    audio.activate()
    audio.gesture()
    audio.gesture()
    audio.deactivate()
    audio.activate()
    audio.gesture()
    expect(contexts).toHaveLength(1)
  })

  it('routes the master gain to the destination and fades it in', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    const bus = context().gains[0]
    expect(bus.gain.value).toBe(0)
    expect(bus.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 2, expect.any(Number))
    expect(bus.connect).toHaveBeenCalledWith(context().destination)
    const out = audio.output()
    expect(out?.bus).toBe(bus)
    expect(audio.output()).toBe(out)
  })

  it('stays silent without Web Audio', () => {
    const { audio } = setup({ createContext: () => null })
    audio.activate()
    expect(() => audio.gesture()).not.toThrow()
    expect(audio.output()).toBeNull()
  })

  it('remakes a closed context on the next gesture', () => {
    const { audio, contexts } = setup()
    audio.activate()
    audio.gesture()
    contexts[0].set('closed')
    expect(audio.output()).toBeNull()
    audio.gesture()
    expect(contexts).toHaveLength(2)
    expect(audio.output()?.context).toBe(contexts[1])
  })

  it('resumes an interrupted context on a gesture', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    context().refuse = true
    context().set('interrupted')
    expect(context().resumes).toBe(1)
    expect(context().state).toBe('interrupted')
    context().refuse = false
    audio.gesture()
    expect(context().state).toBe('running')
  })
})

describe('ship audio running state', () => {
  it('fades out while the tab is hidden, suspends once the fade is done, and resumes when it shows', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    const bus = context().gains[0]
    audio.setVisible(false)
    expect(bus.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 2, expect.any(Number))
    vi.advanceTimersByTime(SUSPEND_DELAY_MS - 1)
    expect(context().state).toBe('running')
    vi.advanceTimersByTime(1)
    expect(context().state).toBe('suspended')
    audio.setVisible(true)
    expect(bus.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 2, expect.any(Number))
    expect(context().state).toBe('running')
  })

  it('suspends outside ship mode, even with the tab showing', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    audio.deactivate()
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(context().state).toBe('suspended')
    expect(audio.output()).toBeNull()
    audio.setVisible(false)
    audio.setVisible(true)
    expect(context().state).toBe('suspended')
    audio.activate()
    expect(context().state).toBe('running')
  })

  it('runs until every binding has let go', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.activate()
    audio.gesture()
    audio.deactivate()
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(context().state).toBe('running')
    expect(audio.output()).not.toBeNull()
    audio.deactivate()
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(context().state).toBe('suspended')
    expect(audio.output()).toBeNull()
  })

  it('suspends a resume that lands after ship mode was left', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    audio.setVisible(false)
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    context().deferred = true
    audio.setVisible(true)
    expect(context().resumes).toBe(1)
    audio.deactivate()
    context().settle()
    expect(context().state).toBe('running')
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    context().settle()
    expect(context().state).toBe('suspended')
  })

  it('resumes a suspend that lands after ship mode was entered again', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    context().deferred = true
    audio.deactivate()
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(context().suspends).toBe(1)
    audio.activate()
    expect(context().resumes).toBe(0)
    context().settle()
    expect(context().state).toBe('suspended')
    expect(context().resumes).toBe(1)
    context().settle()
    expect(context().state).toBe('running')
  })
})

describe('ship audio mute', () => {
  it('starts unmuted and reads a saved mute', () => {
    expect(setup().audio.isMuted()).toBe(false)
    const storage = fakeStorage({ 'tides.shipAudioMuted': '1' })
    expect(setup({ storage }).audio.isMuted()).toBe(true)
  })

  it('persists the mute', () => {
    const { audio, storage } = setup()
    audio.setMuted(true)
    expect(storage.items.get('tides.shipAudioMuted')).toBe('1')
    audio.setMuted(false)
    expect(storage.items.get('tides.shipAudioMuted')).toBe('0')
  })

  it('survives storage that throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const { audio } = setup({ storage })
    expect(audio.isMuted()).toBe(false)
    expect(() => audio.setMuted(true)).not.toThrow()
    expect(audio.isMuted()).toBe(true)
  })

  it('fades the master gain out and suspends, then back', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    const bus = context().gains[0]
    audio.setMuted(true)
    expect(bus.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 2, expect.any(Number))
    expect(context().state).toBe('running')
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(context().state).toBe('suspended')
    audio.gesture()
    expect(context().state).toBe('suspended')
    audio.setMuted(false)
    expect(bus.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 2, expect.any(Number))
    expect(context().state).toBe('running')
  })

  it('never suspends for a mute taken back within the fade', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    audio.setMuted(true)
    vi.advanceTimersByTime(SUSPEND_DELAY_MS / 2)
    audio.setMuted(false)
    vi.advanceTimersByTime(SUSPEND_DELAY_MS * 2)
    expect(context().suspends).toBe(0)
    expect(context().state).toBe('running')
    expect(context().gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 2, expect.any(Number))
  })

  it('makes a muted context silent from the start', () => {
    const { audio, context } = setup({ storage: fakeStorage({ 'tides.shipAudioMuted': '1' }) })
    audio.activate()
    audio.gesture()
    const bus = context().gains[0]
    expect(bus.gain.value).toBe(0)
    expect(bus.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 2, expect.any(Number))
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(context().state).toBe('suspended')
  })

  it('tells subscribers when the mute changes, and only then', () => {
    const { audio } = setup()
    const listener = vi.fn()
    const unsubscribe = audio.subscribe(listener)
    audio.setMuted(true)
    audio.setMuted(true)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    audio.setMuted(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('playShipCue', () => {
  const cue = () => {
    const end = { onended: null as (() => void) | null, disconnect: vi.fn() }
    const nodes = [{ disconnect: vi.fn() }, { disconnect: vi.fn() }]
    return { end, nodes, cue: { end, nodes } as unknown as ShipCue }
  }

  it("doesn't build a cue before the sound is unlocked", () => {
    const { audio } = setup()
    audio.activate()
    const build = vi.fn()
    expect(playShipCue(build, audio)).toBe(false)
    expect(build).not.toHaveBeenCalled()
  })

  it("doesn't build a cue while suspended or muted, nor in the fade before", () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    const build = vi.fn()
    audio.setVisible(false)
    expect(context().state).toBe('running')
    expect(audio.isRunning()).toBe(false)
    expect(playShipCue(build, audio)).toBe(false)
    vi.advanceTimersByTime(SUSPEND_DELAY_MS)
    expect(playShipCue(build, audio)).toBe(false)
    audio.setVisible(true)
    // Still running through the fade before the suspend.
    audio.setMuted(true)
    expect(playShipCue(build, audio)).toBe(false)
    expect(build).not.toHaveBeenCalled()
  })

  it('cuts a sounding cue short inside the fade on a mute', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    const stop = vi.fn()
    const end = { onended: null as (() => void) | null, disconnect: vi.fn(), stop }
    playShipCue(() => ({ end, nodes: [] }) as unknown as ShipCue, audio)
    audio.setMuted(true)
    expect(stop).toHaveBeenCalledTimes(1)
    const at = stop.mock.calls[0][0] as number
    expect(at).toBeGreaterThan(context().currentTime)
    expect(at).toBeLessThan(context().currentTime + SUSPEND_DELAY_MS / 1000)
    // Once it has ended it is left alone.
    end.onended?.()
    audio.setMuted(false)
    audio.setVisible(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('builds a cue at the current time and frees it when it ends', () => {
    const { audio, context } = setup()
    audio.activate()
    audio.gesture()
    const { end, nodes, cue: built } = cue()
    const build = vi.fn(() => built)
    expect(playShipCue(build, audio)).toBe(true)
    expect(build).toHaveBeenCalledWith(audio.output(), context().currentTime)
    expect(nodes[0].disconnect).not.toHaveBeenCalled()
    end.onended?.()
    expect(end.disconnect).toHaveBeenCalled()
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalled()
  })
})
