// Compile in the background and wait for the links (tides-0oi.35).
import type * as THREE from 'three'

/** How often the links are checked, ms (as three's compileAsync does). */
const POLL_MS = 10

// What three's typings leave out: WebGLProperties.has, and the program.
interface ProgramProperties {
  has(object: object): boolean
  get(object: object): { currentProgram?: { isReady(): boolean } }
}

/**
 * three's compileAsync (r180) without its throw: compiles what `scene`
 * holds against `target`'s lights, then resolves once every program it
 * started has linked (KHR_parallel_shader_compile links them in the
 * background). three's poll reads each material's program, and a material
 * disposed meanwhile has none (a Suspense boundary that hides its content
 * again runs its dispose effects): the poll threw from a timer, uncaught,
 * and the promise never settled. Here a material disposed since, or
 * holding no program, has nothing left to wait for; its next draw compiles
 * it. Rejects if a check throws, so a caller's error path runs, not its
 * timeout.
 */
export function compileAndWait(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
  target: THREE.Scene | null = null
): Promise<void> {
  const waiting = renderer.compile(scene, camera, target)
  const properties = renderer.properties as unknown as ProgramProperties
  const linked = (material: THREE.Material) => {
    if (!properties.has(material)) return true
    const program = properties.get(material).currentProgram
    return program === undefined || program.isReady()
  }
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        for (const material of waiting) if (linked(material)) waiting.delete(material)
      } catch (error) {
        reject(error)
        return
      }
      if (waiting.size === 0) resolve()
      else setTimeout(check, POLL_MS)
    }
    // Without the extension every program reports ready (its first use
    // links it); three still waits a tick first, and so does this.
    if (renderer.extensions.has('KHR_parallel_shader_compile')) check()
    else setTimeout(check, POLL_MS)
  })
}
