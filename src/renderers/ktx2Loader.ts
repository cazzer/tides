// The KTX2 loaders for the flight maps (tides-01v.6) and the body maps
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

export function createFlightKtx2Loader(gl: THREE.WebGLRenderer): KTX2Loader {
  // One worker: maps arrive one body at a time.
  return new KTX2Loader(transcoderManager()).detectSupport(gl).setWorkerLimit(1)
}

/**
 * The body maps' loader, kept for the page's life (a planet toggled back on
 * reloads from useLoader's cache, not the file). One worker: a 2k map
 * transcodes in a few ms, and the 26 arrive spread over the planets' load.
 */
export function createBodyKtx2Loader(gl: THREE.WebGLRenderer): KTX2Loader {
  return new KTX2Loader(transcoderManager()).detectSupport(gl).setWorkerLimit(1)
}
