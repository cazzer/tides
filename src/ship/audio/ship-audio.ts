// Ship mode's sound (tides-a4j): one AudioContext and a master gain, shared by
// the engine/wind voices and the one-shot cues. A module singleton like
// shipInput, so the frame loop and the HUD reach it without React state.
//
// Browsers only let a context start inside a user gesture, and ?ship=1 enters
// without one, so the context is made on the first flight key or tap
// (bindShipAudio), never at import or on entry. It is kept for the page's
// life rather than closed on exit: Safari limits how many a page may make.
// Every event only flips a flag and calls sync(), which is the one place
// that decides whether the context runs: in ship mode, with the tab showing
// and sound unmuted. Otherwise it is suspended, so the app is silent outside
// ship mode and in a hidden tab.

const MUTED_KEY = 'tides.shipAudioMuted'

// The master gain eases to its new level over a few of these, so a mute
// doesn't click.
const MUTE_TIME_CONSTANT = 0.015

/** What a voice or cue plays into: the context and the master gain. */
export interface ShipAudioOutput {
  context: AudioContext
  bus: AudioNode
}

export interface ShipAudioDeps {
  /** A new AudioContext, or null where Web Audio is missing or refuses. */
  createContext: () => AudioContext | null
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Whether a context made now may start (navigator.userActivation). */
  hasActivation: () => boolean
}

export interface ShipAudio {
  /** Ship mode entered: the context may run. */
  activate(): void
  /** Ship mode left: suspend, and stay so until activate(). */
  deactivate(): void
  /** A user gesture: make the context if there is none yet, and resume it. */
  gesture(): void
  setVisible(visible: boolean): void
  isMuted(): boolean
  /** Persisted across reloads. Muted also suspends the context. */
  setMuted(muted: boolean): void
  /** Called when the mute changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * Non-null once a gesture has made the context, while in ship mode. The
   * context may still be suspended (muted, hidden, resuming); what is
   * scheduled then plays once it runs. The same object every call.
   */
  output(): ShipAudioOutput | null
}

export function createShipAudio(deps: ShipAudioDeps): ShipAudio {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let out: ShipAudioOutput | null = null
  let active = false
  let visible = true
  let muted: boolean | null = null
  const listeners = new Set<() => void>()

  // Read on first use rather than at import, so the page touches storage
  // only once ship mode asks.
  const isMuted = () => {
    if (muted == null) {
      try {
        muted = deps.storage?.getItem(MUTED_KEY) === '1'
      } catch {
        muted = false
      }
    }
    return muted
  }

  const sync = () => {
    if (!context || context.state === 'closed') return
    const run = active && visible && !isMuted()
    // 'interrupted' (iOS, after a call or Siri) counts as not running. A
    // resume refused for want of a gesture is retried on the next one, and
    // onstatechange calls back here when either settles.
    if (run && context.state !== 'running') context.resume().catch(() => {})
    else if (!run && context.state === 'running') context.suspend().catch(() => {})
  }

  const unlock = () => {
    if ((context && context.state !== 'closed') || !deps.hasActivation()) return
    context = deps.createContext()
    if (!context) return
    master = context.createGain()
    master.gain.value = isMuted() ? 0 : 1
    master.connect(context.destination)
    context.onstatechange = sync
    out = { context, bus: master }
  }

  return {
    activate() {
      active = true
      sync()
    },
    deactivate() {
      active = false
      sync()
    },
    gesture() {
      if (!active) return
      unlock()
      sync()
    },
    setVisible(next) {
      visible = next
      sync()
    },
    isMuted,
    setMuted(next) {
      if (next === isMuted()) return
      muted = next
      try {
        deps.storage?.setItem(MUTED_KEY, next ? '1' : '0')
      } catch {
        // Private mode or blocked storage: the mute lasts until reload.
      }
      if (context && master) master.gain.setTargetAtTime(next ? 0 : 1, context.currentTime, MUTE_TIME_CONSTANT)
      for (const listener of listeners) listener()
      sync()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    output: () => (active && context?.state !== 'closed' ? out : null),
  }
}

function browserContext(): AudioContext | null {
  try {
    return typeof AudioContext === 'function' ? new AudioContext() : null
  } catch {
    return null
  }
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const shipAudio: ShipAudio = createShipAudio({
  createContext: browserContext,
  storage: browserStorage(),
  // Without the API (older Safari), assume the caller is in a gesture.
  hasActivation: () => (navigator as Partial<Navigator>).userActivation?.isActive ?? true,
})

/** A one-shot sound: the source whose end frees it, and every node it made. */
export interface ShipCue {
  end: AudioScheduledSourceNode
  nodes: AudioNode[]
}

/**
 * Plays a one-shot cue built by `build` at `at` (the context's now), if the
 * sound is running and unmuted; returns whether it did. `build` is not called
 * otherwise, so a silent cue costs nothing. Once `end` ends, it and `nodes`
 * are disconnected.
 */
export function playShipCue(
  build: (out: ShipAudioOutput, at: number) => ShipCue,
  audio: ShipAudio = shipAudio
): boolean {
  const out = audio.output()
  if (!out || out.context.state !== 'running' || audio.isMuted()) return false
  const cue = build(out, out.context.currentTime)
  cue.end.onended = () => {
    cue.end.disconnect()
    for (const node of cue.nodes) node.disconnect()
  }
  return true
}
