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

// An element whose closest() matches when its tag is in the selector list.
const element = (tag: string) => ({
  closest: (selector: string) => (selector.split(',').some((s) => s.trim() === tag) ? element(tag) : null),
})

function setup(visibilityState = 'visible', { dialog = false } = {}) {
  const win = fakeTarget()
  const doc = Object.assign(fakeTarget(), {
    visibilityState: visibilityState as DocumentVisibilityState,
    querySelector: ((selector: string) => (dialog && selector === 'dialog[open]' ? {} : null)) as Document['querySelector'],
  })
  let muted = false
  const audio = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    gesture: vi.fn(),
    setVisible: vi.fn(),
    isMuted: () => muted,
    setMuted: vi.fn((next: boolean) => void (muted = next)),
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

  const keyM = (extra: object = {}) => ({
    code: 'KeyM',
    key: 'm',
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    target: element('body'),
    preventDefault: vi.fn(),
    ...extra,
  })

  it('toggles the mute on M', () => {
    const { win, audio } = setup()
    const first = keyM()
    win.fire('keydown', first)
    expect(first.preventDefault).toHaveBeenCalled()
    expect(audio.setMuted).toHaveBeenLastCalledWith(true)
    win.fire('keydown', keyM())
    expect(audio.setMuted).toHaveBeenLastCalledWith(false)
  })

  it('leaves M alone held, with a modifier, while typing, behind a dialog, or already handled', () => {
    const { win, audio } = setup()
    for (const extra of [
      { repeat: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { target: element('input') },
      { defaultPrevented: true },
    ]) {
      const event = keyM(extra)
      win.fire('keydown', event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(audio.setMuted).not.toHaveBeenCalled()
    const behindDialog = setup('visible', { dialog: true })
    behindDialog.win.fire('keydown', keyM())
    expect(behindDialog.audio.setMuted).not.toHaveBeenCalled()
  })

  it('removes every listener and deactivates on cleanup', () => {
    const { win, doc, audio, cleanup } = setup()
    cleanup()
    expect(win.count()).toBe(0)
    expect(doc.count()).toBe(0)
    expect(audio.deactivate).toHaveBeenCalledTimes(1)
  })
})
