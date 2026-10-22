// Cheap tripwires for rendering faults that otherwise show up only as a
// wrong-coloured screen on someone's phone (tides-2hv.1): a NaN position
// smears a mesh across the view, and a lost WebGL context blanks it.

import type * as THREE from 'three'

const finite3 = (v: { x: number; y: number; z: number }) =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

/** "Scene > Group sun > Mesh", for naming an offender. */
function pathOf(object: THREE.Object3D): string {
  const parts: string[] = []
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    parts.unshift(o.name ? `${o.type} ${o.name}` : o.type)
  }
  return parts.join(' > ')
}

// Reused between calls, so checking a scene allocates nothing.
const pending: THREE.Object3D[] = []

/**
 * The first non-finite (NaN or ±Infinity) camera position or orientation, or
 * object position in `scene`, described for a log; null when all are finite.
 */
export function findNonFinite(scene: THREE.Object3D, camera: THREE.Camera): string | null {
  const q = camera.quaternion
  if (!finite3(camera.position)) return `camera position ${camera.position.toArray()}`
  if (!(finite3(q) && Number.isFinite(q.w))) return `camera quaternion ${q.toArray()}`
  pending.length = 0
  pending.push(scene)
  while (pending.length) {
    const object = pending.pop()!
    if (!finite3(object.position)) {
      pending.length = 0
      return `${pathOf(object)} position ${object.position.toArray()}`
    }
    for (const child of object.children) pending.push(child)
  }
  return null
}

/**
 * Dev builds: once per frame per scene, check what each gl.render call is
 * about to draw for non-finite positions, and console.error the first
 * offender (with a stack), once. Every View panel and the Sun's CubeCamera
 * render through the one renderer, so this sees the ship camera and the
 * bodies wherever they are drawn. `frame` reads the current frame number.
 * Returns the uninstaller.
 */
export function watchForNonFinite(gl: THREE.WebGLRenderer, frame: () => number): () => void {
  const render = gl.render
  const checkedAt = new WeakMap<THREE.Object3D, number>()
  let reported = false
  gl.render = function (scene, camera) {
    if (!reported && checkedAt.get(scene) !== frame()) {
      checkedAt.set(scene, frame())
      const offender = findNonFinite(scene, camera)
      if (offender) {
        reported = true
        const message = `[render] non-finite ${offender}`
        console.error(message, new Error(message))
      }
    }
    return render.call(this, scene, camera)
  }
  return () => {
    gl.render = render
  }
}

/**
 * Log WebGL context loss and restoration on `canvas` (all builds: two
 * listeners, nothing per frame). Returns the uninstaller.
 */
export function logContextLoss(canvas: HTMLCanvasElement): () => void {
  const onLost = (event: Event) =>
    console.error('[render] WebGL context lost', (event as WebGLContextEvent).statusMessage ?? '')
  const onRestored = () => console.warn('[render] WebGL context restored')
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  return () => {
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
  }
}
