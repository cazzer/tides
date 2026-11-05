// Callbacks for a scene's onBeforeRender, shared by every hook that needs
// one (the cloud layer's faceCamera, the sized body spheres' forced top
// level, the sky panel's round discs). Each used to chain the property by
// hand and put its predecessor back on cleanup, which drops any hook
// installed after it whenever they unmount out of order, or silences the
// ones before it if it doesn't call through. Here each scene gets one
// dispatcher, which calls the callbacks in the order they were added and is
// taken off again once the last one goes.
import type * as THREE from 'three'

/** The renderer, and the camera the scene is about to draw for. */
export type SceneBeforeRender = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void

interface Dispatch {
  callbacks: Set<SceneBeforeRender>
  /** The scene's own onBeforeRender when the dispatcher went on. */
  previous: THREE.Scene['onBeforeRender']
  dispatcher: THREE.Scene['onBeforeRender']
}
const dispatches = new WeakMap<THREE.Scene, Dispatch>()

/**
 * Calls `callback` each time `scene` is about to draw (after three has
 * updated its matrices and the camera's), after the callbacks added before
 * it. Returns its removal.
 */
export function addSceneBeforeRender(scene: THREE.Scene, callback: SceneBeforeRender): () => void {
  let dispatch = dispatches.get(scene)
  if (!dispatch) {
    const callbacks = new Set<SceneBeforeRender>()
    const previous = scene.onBeforeRender
    const dispatcher: THREE.Scene['onBeforeRender'] = function (this: THREE.Scene, renderer, ...rest) {
      previous.call(this, renderer, ...rest)
      for (const each of callbacks) each(renderer, rest[1])
    }
    dispatch = { callbacks, previous, dispatcher }
    dispatches.set(scene, dispatch)
    scene.onBeforeRender = dispatcher
  }
  // A wrapper per add, so the same function added twice is two entries.
  const entry: SceneBeforeRender = (renderer, camera) => callback(renderer, camera)
  dispatch.callbacks.add(entry)
  const held = dispatch
  return () => {
    if (!held.callbacks.delete(entry) || held.callbacks.size > 0) return
    if (scene.onBeforeRender === held.dispatcher) scene.onBeforeRender = held.previous
    if (dispatches.get(scene) === held) dispatches.delete(scene)
  }
}
