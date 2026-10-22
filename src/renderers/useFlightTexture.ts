// Fetches a body's flight-only map (tides-01v.6) once the ship comes within
// range of it, without suspending: callers show their 2k map until this
// returns the KTX2 one. Everything is released when ship mode ends.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { useStore } from '../store'
import { flightTextureCap } from '../quality'
import {
  canUseFlightTextures,
  createFlightTextureCache,
  flightTextureUrl,
  inFlightTextureRange,
  type FlightTextureCache,
  type FlightTextureKey,
} from '../flight-textures'

let loader: Promise<KTX2Loader> | null = null
let cache: FlightTextureCache | null = null
/** This flight's loads still in progress on `loader`. */
const loading = new Set<Promise<unknown>>()

// The colour space comes from each file's KTX2 header, sRGB (pinned by
// flight-textures.test.ts).
async function loadFlightTexture(
  url: string,
  gl: THREE.WebGLRenderer,
  isCurrent: () => boolean
): Promise<THREE.Texture> {
  loader ??= import('./ktx2Loader').then((m) => m.createFlightKtx2Loader(gl))
  const texture = await (await loader).loadAsync(url)
  if (isCurrent()) {
    texture.anisotropy = gl.capabilities.getMaxAnisotropy()
    // Upload now, between frames, so the frame that swaps it in doesn't.
    gl.initTexture(texture)
  }
  return texture
}

function flightCache(gl: THREE.WebGLRenderer): FlightTextureCache {
  return (cache ??= createFlightTextureCache((url, isCurrent) => {
    const load = loadFlightTexture(url, gl, isCurrent)
    loading.add(load)
    const settle = () => loading.delete(load)
    load.then(settle, settle)
    return load
  }))
}

/** Disposes the flight maps and the transcoder's worker (ship exit). */
export function releaseFlightTextures(): void {
  cache?.release()
  cache = null
  // A disposed KTX2Loader still transcodes a file it was fetching, in a
  // worker nothing would then terminate: let those loads finish first.
  const done = Promise.allSettled([...loading])
  loading.clear()
  const released = loader
  loader = null
  void done.then(() => released?.then((l) => l.dispose(), () => {}))
}

/** This device's URL for `key`, or undefined where the tier is off. */
function deviceFlightUrl(key: FlightTextureKey, gl: THREE.WebGLRenderer): string | undefined {
  const cap = flightTextureCap(gl.capabilities.maxTextureSize)
  if (cap === null || !canUseFlightTextures((ext) => gl.extensions.has(ext))) return undefined
  return flightTextureUrl(key, cap)
}

const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()

/**
 * The flight map for `key`, or null until it arrives (and outside ship
 * mode). `anchor` sits at the body's centre; `radius` is in its local units.
 */
export function useFlightTexture(
  key: FlightTextureKey | undefined,
  anchor: RefObject<THREE.Object3D | null>,
  radius: number
): THREE.Texture | null {
  const shipMode = useStore((s) => s.shipMode)
  const gl = useThree((s) => s.gl)
  const url = useMemo(() => (key ? deviceFlightUrl(key, gl) : undefined), [key, gl])
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  const requested = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useFrame(({ camera }) => {
    const body = anchor.current
    if (!shipMode || !url || requested.current || !body) return
    body.getWorldPosition(_position)
    const worldRadius = radius * body.getWorldScale(_scale).x
    if (!inFlightTextureRange(camera.position.distanceTo(_position) - worldRadius, worldRadius)) return
    requested.current = true
    void flightCache(gl)
      .request(url)
      .then((loaded) => {
        if (mounted.current) setTexture(loaded)
      })
  })

  // Ship mode mounts its own scene, so this hook's maps live and die with
  // one flight; outside it, it never loads.
  return shipMode ? texture : null
}
