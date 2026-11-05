import { createContext, useContext } from 'react'

/**
 * Whether the scene this sits in is shown: false while the first load holds
 * it back to compile it (CompileGate.tsx). Until then it is no place to
 * compile a program from, as three would compile it without the scene's
 * lights, under the same hidden group; and GPU work started then lands on
 * the gate's own sync calls (a first use waits behind it).
 */
export const SceneShown = createContext(true)

export function useSceneShown(): boolean {
  return useContext(SceneShown)
}
