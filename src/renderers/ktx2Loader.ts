// The KTX2 loader for the flight maps (tides-01v.6) and the body maps
// (tides-0oi.14), imported dynamically so the loader and its Basis
// transcoder stay out of the main bundle until a map needs them. The
// transcoder ships with three; Vite copies both files into the build under
// hashed names.
import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import transcoderJsUrl from 'three/examples/jsm/libs/basis/basis_transcoder.js?url'
import transcoderWasmUrl from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url'

// KTX2Loader fetches its transcoder by fixed names under one path; the
// hashed names can't share a path, so map each name to its URL. Its own
// manager keeps these loads off the app's loading overlay.
function transcoderManager(): THREE.LoadingManager {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.endsWith('basis_transcoder.js')) return transcoderJsUrl
    if (url.endsWith('basis_transcoder.wasm')) return transcoderWasmUrl
    return url
  })
  return manager
}

let shared: KTX2Loader | null = null

/**
 * The page's one KTX2Loader, for the flight maps and the body maps alike:
 * each loader keeps its own worker and transcoder heap, so it is made once
 * and never disposed. One worker: maps arrive a body at a time.
 */
export function getKtx2Loader(gl: THREE.WebGLRenderer): KTX2Loader {
  return (shared ??= new KTX2Loader(transcoderManager()).detectSupport(gl).setWorkerLimit(1))
}
