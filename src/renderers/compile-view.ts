// The scene as the first load's compile gate (CompileGate.tsx) compiles it.
import type * as THREE from 'three'
import { materialsOf } from '../ship/ship-warmup'
import { compilesAhead } from './compile-gate'

/**
 * What the first frames draw, and what is compiled ahead of them though
 * hidden (userData.compileHidden): `object` and down.
 */
export function visitDrawn(object: THREE.Object3D, visit: (object: THREE.Object3D) => void) {
  if (!object.visible && !object.userData.compileHidden) return
  visit(object)
  for (const child of object.children) visitDrawn(child, visit)
}

/**
 * What the gate holds (`root`), as compile() should see it: three takes the
 * materials to compile from every object under its first argument, shown or
 * not, but the first frames draw only the shown ones (visitDrawn). Unless
 * `withLater`, it leaves out an object whose material is about to change
 * (compilesAhead), and tells `onDeferred`; its children are still taken.
 * The lights come from the scene, passed as compile's target, so this has
 * none of its own to add.
 *
 * Only the gate's own subtree (tides-0oi.25): what is mounted beside it in
 * the same scene draws all along, with the gate's lights hidden, and links
 * its programs at those draws. Ship mode's dust, rain and well rings are
 * safe there only because they are unlit, so the lights showing changes
 * nothing for them; compiling them here with the lights would build a second
 * program their draws never use. A lit material mounted beside the gate
 * (e.g. at ShipView's SHIP SCENE MOUNT POINT) would relink when the lights
 * show, on the reveal frame: it belongs inside the Scene's children, or
 * needs a warm-up of its own.
 */
export function shownOnly(root: THREE.Object3D, withLater = false, onDeferred?: () => void): THREE.Object3D {
  const view = {
    traverse: (visit: (object: THREE.Object3D) => void) =>
      visitDrawn(root, (object) => {
        if (withLater || compilesAhead(materialsOf(object))) visit(object)
        else onDeferred?.()
      }),
    traverseVisible: () => {},
  }
  return view as unknown as THREE.Object3D
}
