import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useFrame, type RootState } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import type * as THREE from 'three'
import { materialsOf, texturesOf } from '../ship/ship-warmup'
import { afterRound, assetsLoaded, phaseAfterUnmount, readyNow, drainWithin, withTimeout, COMPILE_TIMEOUT_MS, GATE_DEADLINE_MS, WARM_BUDGET_MS } from './compile-gate'
import { SceneGateContext, type SceneGate } from './scene-shown'
import { shownOnly, visitDrawn } from './compile-view'
import { compileAndWait } from './compile-wait'

/**
 * Compile rounds in a row that must find nothing new, with every asset
 * loaded, before the gate warms: content under a nested Suspense commits
 * a little after its assets land.
 */
const QUIET_ROUNDS = 2

type Phase = 'compile' | 'compiling' | 'warm' | 'reveal' | 'shown' | 'ready'

// three's program, with what its typings leave out.
type Program = THREE.WebGLProgram & { isReady(): boolean; program?: WebGLProgram }

interface CompileGateProps {
  /** Hold the scene back until its programs are linked (read once, at mount). */
  hold: boolean
  /** Called once the scene has drawn two frames and nothing it waits for (SceneGate.waitFor) is pending. */
  onReady?: () => void
  /** Called on unmount after onReady, so a View mounted again is waited for again. */
  onUnready?: () => void
  children: ReactNode
}

/**
 * Keeps a View's scene hidden on the first load until its shaders are
 * compiled and linked (tides-0oi.6). Cold, three links each program at its
 * first draw, one after another, and the first frame blocked the main thread
 * 1.47 s. Instead, while the loading screen is up, it compiles the scene
 * with compileAndWait (KHR_parallel_shader_compile links in the background),
 * again until a round finds nothing new and the assets are in, then gives
 * each map its upload and each linked program its first use a few per frame
 * (WARM_BUDGET_MS), and only then shows the scene. A compile that doesn't
 * finish in COMPILE_TIMEOUT_MS, or anything still pending GATE_DEADLINE_MS
 * after mount, shows it anyway. An object hidden by design but drawn soon
 * after (the seasons tour's sea-ice shell) is compiled with the rest when it
 * sets userData.compileHidden, and its userData.warmMaps are uploaded.
 *
 * Without `hold` (a View mounted after the first load), it shows at once.
 * What compiles or starts heavy GPU work on its own under it waits for
 * useSceneShown().
 * From a frame callback at priority 0, ahead of drei View's draw: three's
 * compile replaces the renderer's render state, so it mustn't run mid-render.
 */
export function CompileGate({ hold, onReady, onUnready, children }: CompileGateProps) {
  const [held] = useState(() => hold)
  const [shown, setShown] = useState(!held)
  const group = useRef<THREE.Group>(null)
  const phase = useRef<Phase>(held ? 'compile' : 'reveal')
  // Bumped on unmount (and StrictMode's replayed one), so a round still
  // compiling then is dropped.
  const generation = useRef(0)
  const alive = useRef(false)
  const quiet = useRef(0)
  // Whether the next round takes in the objects compilesAhead leaves out,
  // and whether one has (afterRound).
  const final = useRef(false)
  const tookLater = useRef(false)
  const warm = useRef<(() => void)[]>([])
  const drawn = useRef(0)
  const deadline = useRef(Infinity)
  const waiting = useRef(new Set<() => boolean>())
  const callbacks = useRef({ onReady, onUnready })
  useLayoutEffect(() => {
    callbacks.current = { onReady, onUnready }
  })
  useLayoutEffect(() => {
    // The refs themselves: counters, not nodes React swaps.
    const [live, rounds, at, calls, frames] = [alive, generation, phase, callbacks, drawn]
    live.current = true
    return () => {
      live.current = false
      rounds.current++
      const after = phaseAfterUnmount(at.current)
      at.current = after.phase
      if (after.unready) {
        frames.current = 0
        calls.current.onUnready?.()
      }
    }
  }, [])
  const gate = useMemo<SceneGate>(
    () => ({
      shown,
      waitFor: (done) => {
        waiting.current.add(done)
        return () => void waiting.current.delete(done)
      },
    }),
    [shown]
  )

  useFrame((state) => {
    const root = group.current
    if (!alive.current || !root || phase.current === 'ready') return
    const now = performance.now()
    if (deadline.current === Infinity) deadline.current = now + GATE_DEADLINE_MS
    const late = now > deadline.current
    if (late && phase.current !== 'shown') {
      console.warn(`CompileGate: not ready after ${GATE_DEADLINE_MS} ms; showing the scene`)
      reveal(root, state)
      return
    }
    switch (phase.current) {
      case 'compile':
        compileRound(state, root)
        return
      case 'warm':
        warm.current = drainWithin(warm.current, WARM_BUDGET_MS, () => performance.now(), (job) => job())
        if (warm.current.length === 0) reveal(root)
        return
      case 'reveal':
        reveal(root, state)
        return
      case 'shown':
        drawn.current++
        if (!readyNow({ drawn: drawn.current, pending: [...waiting.current].some((done) => !done()), late })) return
        phase.current = 'ready'
        callbacks.current.onReady?.()
        return
    }
  }, 0)

  function compileRound({ gl, scene, camera }: RootState, root: THREE.Group) {
    const generationAtStart = generation.current
    const before = gl.info.programs?.length ?? 0
    const loaded = assetsLoaded(useProgress.getState())
    const takesLater = final.current
    let deferred = false
    let linked: Promise<unknown>
    // Shown only for the call: three gathers the lights it compiles
    // against from what is visible.
    root.visible = true
    try {
      if (takesLater) tookLater.current = true
      linked = compileAndWait(
        gl,
        shownOnly(root, takesLater, () => (deferred = true)),
        camera,
        scene
      )
    } catch (error) {
      console.error('CompileGate: compile failed; showing the scene', error)
      phase.current = 'reveal'
      return
    } finally {
      root.visible = false
    }
    const added = (gl.info.programs?.length ?? 0) !== before
    phase.current = 'compiling'
    withTimeout(linked, COMPILE_TIMEOUT_MS).then(
      (outcome) => {
        if (generation.current !== generationAtStart || phase.current !== 'compiling') return
        if (outcome === 'timeout') console.warn(`CompileGate: shaders not linked after ${COMPILE_TIMEOUT_MS} ms; showing the scene anyway`)
        const round = afterRound({ outcome, added, loaded, quiet: quiet.current, deferred, final: takesLater }, QUIET_ROUNDS)
        quiet.current = round.quiet
        final.current = round.final
        if (round.next === 'warm') warm.current = warmJobs(gl, root)
        phase.current = round.next
      },
      (error: unknown) => {
        if (generation.current !== generationAtStart || phase.current !== 'compiling') return
        console.error('CompileGate: compile failed; showing the scene', error)
        phase.current = 'reveal'
      }
    )
  }

  function reveal(root: THREE.Group, state?: RootState) {
    phase.current = 'shown'
    drawn.current = 0
    // Now, so this frame's draw has it; the state keeps the prop in step.
    root.visible = true
    setShown(true)
    // Shown early (the deadline, a round timed out or failed): what the
    // rounds left out (compilesAhead) draws as it is, so its compile at
    // least starts in the background before this frame's draw.
    if (held && state && !tookLater.current) {
      tookLater.current = true
      try {
        compileAndWait(state.gl, shownOnly(root, true), state.camera, state.scene).catch(() => {})
      } catch {
        // The draw compiles it.
      }
    }
  }

  return (
    <group
      ref={group}
      visible={shown}
    >
      <SceneGateContext.Provider value={gate}>{children}</SceneGateContext.Provider>
    </group>
  )
}

/**
 * The first-draw work left once every program is compiled: each drawn map's
 * upload, then each linked program's first use (where ANGLE-Metal finishes
 * the link, 2-9 ms each, tides-warmup-findings). A program not linked yet by
 * its turn is left to its draw, as one gone since is. Maps from the material
 * itself and an object's userData.warmMaps: one an onBeforeCompile adds is
 * otherwise uploaded at its draw (warming all of those changed a far Earth by
 * 1 LSB on ~15 px, tides-0oi.6).
 */
function warmJobs(gl: THREE.WebGLRenderer, root: THREE.Group): (() => void)[] {
  const maps = new Set<THREE.Texture>()
  for (const child of root.children) {
    visitDrawn(child, (object) => {
      const extra = (object.userData.warmMaps as THREE.Texture[] | undefined) ?? []
      for (const texture of [...materialsOf(object).flatMap(texturesOf), ...extra]) {
        if (texture.version > 0 && !texture.isRenderTargetTexture) maps.add(texture)
      }
    })
  }
  const jobs = [...maps].map((texture) => () => gl.initTexture(texture))
  for (const program of (gl.info.programs ?? []) as Program[]) {
    jobs.push(() => {
      if (program.program && program.isReady()) program.getUniforms()
    })
  }
  return jobs
}
