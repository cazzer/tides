import { describe, expect, it, vi } from 'vitest'
import { bindShipAudio } from './bind-ship-audio'
import type { ShipAudio } from './ship-audio'

type Listener = (event: never) => void

// Just enough of window and document for the binding.
function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    listeners,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    fire(type: string, event: object = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as never)
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

function setup(visibilityState = 'visible') {
  const win = fakeTarget()
  const doc = Object.assign(fakeTarget(), { visibilityState: visibilityState as DocumentVisibilityState })
  const audio = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    gesture: vi.fn(),
    setVisible: vi.fn(),
    isMuted: () => false,
    setMuted: vi.fn(),
    subscribe: () => () => {},
    output: () => null,
  } satisfies ShipAudio
  const cleanup = bindShipAudio(audio, win, doc)
  return { win, doc, audio, cleanup }
}

describe('ship audio binding (tides-a4j.1)', () => {
  it('activates on bind without a gesture', () => {
    const { audio } = setup()
    expect(audio.activate).toHaveBeenCalledTimes(1)
    expect(audio.gesture).not.toHaveBeenCalled()
    expect(audio.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('starts hidden in a hidden tab', () => {
    expect(setup('hidden').audio.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('unlocks on a key or a pointer, but not on Escape', () => {
    const { win, audio } = setup()
    win.fire('keydown', { key: 'Escape' })
    expect(audio.gesture).not.toHaveBeenCalled()
    win.fire('keydown', { key: 'w' })
    win.fire('pointerdown')
    win.fire('pointerup')
    expect(audio.gesture).toHaveBeenCalledTimes(3)
  })

  it('follows the tab hiding and showing', () => {
    const { doc, audio } = setup()
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    expect(audio.setVisible).toHaveBeenLastCalledWith(false)
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    expect(audio.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('removes every listener and deactivates on cleanup', () => {
    const { win, doc, audio, cleanup } = setup()
    cleanup()
    expect(win.count()).toBe(0)
    expect(doc.count()).toBe(0)
    expect(audio.deactivate).toHaveBeenCalledTimes(1)
  })
})
