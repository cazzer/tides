// Browser side of the real-weather cloud layer (tides-l3s): the shared
// controller (./realCloudController.ts), whose builds run in the cloud worker
// (tides-9jn.2, ./cloud.worker.ts via ./cloudWorkerClient.ts) where the browser
// can draw there, and on the main thread otherwise. Either way the pipeline is
// ./cloudPipeline.ts; this only uploads its pixels as a texture. The frames are
// cross-faded by the shared blender (./cloudBlend.ts, tides-kzj.4.2).
import { useEffect, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { OUT_H, OUT_W } from '../real-clouds'
import { buildCloudImage, type CloudAssets, type CloudImage, type GeoTextureInfo } from './cloudPipeline'
import { createCloudBlender } from './cloudBlend'
import { createCloudImageBuilder, type CloudWorker } from './cloudWorkerClient'
import { createRealCloudController, type CloudSnapshot, type ImagerySource } from './realCloudController'
import earthSpecular from '../assets/earth-specular-2k.jpg'
import earthDay from '../assets/earth-day-2k.jpg'
import earthDemHigh from '../assets/earth-dem-4k.bin?url'
import earthDemLow from '../assets/earth-dem-2k.bin?url'
import { isLowQuality } from '../quality'

export type { GeoTextureInfo }

const absolute = (url: string) => new URL(url, document.baseURI).href

const assets: CloudAssets = {
  specular: absolute(earthSpecular),
  day: absolute(earthDay),
  // The ground's own (EarthRenderer), so the browser has it already.
  dem: absolute(isLowQuality() ? earthDemLow : earthDemHigh),
}

/** The worker needs OffscreenCanvas 2D (Safari 16.4+) to draw the tiles. */
function canWorkerDraw(): boolean {
  try {
    return (
      typeof Worker === 'function' &&
      typeof OffscreenCanvas === 'function' &&
      new OffscreenCanvas(1, 1).getContext('2d') !== null
    )
  } catch {
    return false
  }
}

const buildImage = createCloudImageBuilder({
  createWorker: () =>
    canWorkerDraw()
      ? (new Worker(new URL('./cloud.worker.ts', import.meta.url), {
          type: 'module',
          name: 'clouds',
        }) as unknown as CloudWorker)
      : null,
  inThread: (source, staticUrl, signal) => buildCloudImage(source, staticUrl, assets, signal),
  assets,
})

function textureOf({ rgba, geo, cold, held }: CloudImage): THREE.DataTexture {
  // Bottom row first, so no flipY; filtered and mipmapped like an image.
  const texture = new THREE.DataTexture(rgba, OUT_W, OUT_H, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  // alphaMap is data, not colour.
  texture.colorSpace = THREE.NoColorSpace
  texture.userData.geo = geo
  texture.userData.cold = Boolean(cold)
  texture.userData.held = Boolean(held)
  texture.needsUpdate = true
  return texture
}

async function buildCloudTexture(
  source: ImagerySource,
  staticUrl: string,
  signal: AbortSignal
): Promise<THREE.DataTexture | null> {
  const image = await buildImage(source, absolute(staticUrl), signal)
  signal.throwIfAborted()
  return image ? textureOf(image) : null
}

export type RealCloudSnapshot = CloudSnapshot<THREE.Texture>

export const realClouds = createRealCloudController<THREE.Texture>({
  build: buildCloudTexture,
  dispose: (texture) => texture.dispose(),
  isCold: (texture) => Boolean(texture.userData.cold),
})

export const realCloudBlend = createCloudBlender()

export function useRealCloudSnapshot(): RealCloudSnapshot {
  return useSyncExternalStore(realClouds.subscribe, realClouds.getSnapshot)
}

/** Stops fetching and frees the blend when `active` turns false. Doesn't
 * subscribe: the frame loop reads the controller itself. */
export function useRealCloudsActive(active: boolean): void {
  useEffect(() => {
    if (active) return
    realClouds.deactivate()
    realCloudBlend.release()
  }, [active])
}
