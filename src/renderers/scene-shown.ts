import { createContext, useContext } from 'react'

/** The first load's hold on the scene this sits in (CompileGate.tsx). */
export interface SceneGate {
  /**
   * Whether the scene is shown: false while the first load holds it back to
   * compile it. Until then it is no place to compile a program from, as
   * three would compile it without the scene's lights, under the same hidden
   * group; and GPU work started then lands on the gate's own sync calls (a
   * first use waits behind it).
   */
  shown: boolean
  /**
   * Holds the scene's ready (the end of the loading screen) until `done`
   * returns true, or the gate's deadline; returns the release.
   */
  waitFor(done: () => boolean): () => void
}

export const SceneGateContext = createContext<SceneGate>({ shown: true, waitFor: () => () => {} })

export function useSceneGate(): SceneGate {
  return useContext(SceneGateContext)
}

export function useSceneShown(): boolean {
  return useContext(SceneGateContext).shown
}
