import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useFrame, type RootState } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import type * as THREE from 'three'
import { materialsOf, texturesOf } from '../ship/ship-warmup'
import { assetsLoaded, drainWithin, withTimeout, COMPILE_TIMEOUT_MS, WARM_BUDGET_MS } from './compile-gate'
import { SceneShown } from './scene-shown'

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
  /** Called once the scene has drawn two frames. */
  onReady?: () => void
  children: ReactNode
}

/**
 * Keeps a View's scene hidden on the first load until its shaders are
 * compiled and linked (tides-0oi.6). Cold, three links each program at its
 * first draw, one after another, and the first frame blocked the main thread
 * 1.47 s. Instead, while the loading screen is up, it compiles the scene
 * with compileAsync (KHR_parallel_shader_compile links in the background),
 * again until a round finds nothing new and the assets are in, then gives
 * each map its upload and each linked program its first use a few per frame
 * (WARM_BUDGET_MS), and only then shows the scene. A compile that doesn't
 * finish in COMPILE_TIMEOUT_MS shows it anyway.
 *
 * Without `hold` (a View mounted after the first load), it shows at once.
 * What compiles or starts heavy GPU work on its own under it waits for
 * useSceneShown().
 * From a frame callback at priority 0, ahead of drei View's draw: three's
 * compile replaces the renderer's render state, so it mustn't run mid-render.
 */
export function CompileGate({ hold, onReady, children }: CompileGateProps) {
  const [held] = useState(() => hold)
  const [shown, setShown] = useState(!held)
  const group = useRef<THREE.Group>(null)
  const phase = useRef<Phase>(held ? 'compile' : 'reveal')
  // Bumped on unmount (and StrictMode's replayed one), so a round still
  // compiling then is dropped.
  const generation = useRef(0)
  const alive = useRef(false)
  const quiet = useRef(0)
  const warm = useRef<(() => void)[]>([])
  const drawn = useRef(0)
  const ready = useRef(onReady)
  useLayoutEffect(() => {
    ready.current = onReady
  })
  useLayoutEffect(() => {
    // The refs themselves: counters, not nodes React swaps.
    const [live, rounds, at] = [alive, generation, phase]
    live.current = true
    return () => {
      live.current = false
      rounds.current++
      if (at.current === 'compiling') at.current = 'compile'
    }
  }, [])

  useFrame((state) => {
    const root = group.current
    if (!alive.current || !root) return
    switch (phase.current) {
      case 'compile':
        compileRound(state, root)
        return
      case 'warm':
        warm.current = drainWithin(warm.current, WARM_BUDGET_MS, () => performance.now(), (job) => job())
        if (warm.current.length === 0) reveal(root)
        return
      case 'reveal':
        reveal(root)
        return
      case 'shown':
        if (++drawn.current >= 2) {
          phase.current = 'ready'
          ready.current?.()
        }
        return
    }
  }, 0)

  function compileRound({ gl, scene, camera }: RootState, root: THREE.Group) {
    const generationAtStart = generation.current
    const before = gl.info.programs?.length ?? 0
    const loaded = assetsLoaded(useProgress.getState())
    // Shown only for the call: three gathers the lights it compiles
    // against from what is visible.
    root.visible = true
    let linked: Promise<unknown>
    try {
      linked = gl.compileAsync(shownOnly(scene), camera, scene)
    } finally {
      root.visible = false
    }
    const added = (gl.info.programs?.length ?? 0) !== before
    phase.current = 'compiling'
    withTimeout(linked, COMPILE_TIMEOUT_MS).then(
      (outcome) => {
        if (generation.current !== generationAtStart || phase.current !== 'compiling') return
        if (outcome === 'timeout') {
          console.warn(`CompileGate: shaders not linked after ${COMPILE_TIMEOUT_MS} ms; showing the scene anyway`)
          phase.current = 'reveal'
          return
        }
        quiet.current = added || !loaded ? 0 : quiet.current + 1
        if (quiet.current < QUIET_ROUNDS) {
          phase.current = 'compile'
          return
        }
        warm.current = warmJobs(gl, root)
        phase.current = 'warm'
      },
      (error: unknown) => {
        if (generation.current !== generationAtStart) return
        console.error('CompileGate: compile failed; showing the scene', error)
        phase.current = 'reveal'
      }
    )
  }

  function reveal(root: THREE.Group) {
    phase.current = 'shown'
    drawn.current = 0
    // Now, so this frame's draw has it; the state keeps the prop in step.
    root.visible = true
    setShown(true)
  }

  return (
    <group
      ref={group}
      visible={shown}
    >
      <SceneShown.Provider value={shown}>{children}</SceneShown.Provider>
    </group>
  )
}

/**
 * `scene` as compile() should see it: three takes the materials to compile
 * from every object under its first argument, shown or not, but the first
 * frame draws only the shown ones. The lights come from `scene` itself,
 * passed as compile's target, so this one has none of its own to add.
 */
function shownOnly(scene: THREE.Object3D): THREE.Object3D {
  const view = {
    traverse: (visit: (object: THREE.Object3D) => void) => scene.traverseVisible(visit),
    traverseVisible: () => {},
  }
  return view as unknown as THREE.Object3D
}

/**
 * The first-draw work left once every program is compiled: each shown map's
 * upload, then each linked program's first use (where ANGLE-Metal finishes
 * the link, 2-9 ms each, tides-warmup-findings). A program not linked yet by
 * its turn is left to its draw, as one gone since is. Maps only from the
 * material itself: one an onBeforeCompile adds is uploaded at its draw
 * (warming those changed a far Earth by 1 LSB on ~15 px, tides-0oi.6).
 */
function warmJobs(gl: THREE.WebGLRenderer, root: THREE.Group): (() => void)[] {
  const maps = new Set<THREE.Texture>()
  for (const child of root.children) {
    child.traverseVisible((object) => {
      for (const material of materialsOf(object)) {
        for (const texture of texturesOf(material)) {
          if (texture.version > 0 && !texture.isRenderTargetTexture) maps.add(texture)
        }
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
