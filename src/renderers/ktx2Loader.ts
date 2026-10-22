// The KTX2 loader for the flight maps (tides-01v.6), imported dynamically so
// the loader and its Basis transcoder stay out of the main bundle until ship
// mode needs them. The transcoder ships with three; Vite copies both files
// into the build under hashed names.
import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import transcoderJsUrl from 'three/examples/jsm/libs/basis/basis_transcoder.js?url'
import transcoderWasmUrl from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url'

export function createFlightKtx2Loader(gl: THREE.WebGLRenderer): KTX2Loader {
  // KTX2Loader fetches its transcoder by fixed names under one path; the
  // hashed names can't share a path, so map each name to its URL. Its own
  // manager keeps these loads off the app's loading overlay.
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.endsWith('basis_transcoder.js')) return transcoderJsUrl
    if (url.endsWith('basis_transcoder.wasm')) return transcoderWasmUrl
    return url
  })
  // One worker: maps arrive one body at a time.
  return new KTX2Loader(manager).detectSupport(gl).setWorkerLimit(1)
}
