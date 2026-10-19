// Browser side of the real-weather cloud layer (tides-l3s): the shared
// controller (./realCloudController.ts), whose builds run in the cloud worker
// (tides-9jn.2, ./cloud.worker.ts via ./cloudWorkerClient.ts) where the browser
// can draw there, and on the main thread otherwise. Either way the pipeline is
// ./cloudPipeline.ts; this only uploads its pixels as a texture.
import { useEffect, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { OUT_H, OUT_W } from '../real-clouds'
import { buildCloudImage, type CloudAssets, type CloudImage, type GeoTextureInfo } from './cloudPipeline'
import { createCloudImageBuilder, type CloudWorker } from './cloudWorkerClient'
import { createRealCloudController, type CloudSnapshot, type ImagerySource } from './realCloudController'
import earthSpecular from '../assets/earth-specular-2k.jpg'
import earthDay from '../assets/earth-day-2k.jpg'
import earthBump from '../assets/earth-bump-2k.jpg'

export type { GeoTextureInfo }

const absolute = (url: string) => new URL(url, document.baseURI).href

const assets: CloudAssets = {
  specular: absolute(earthSpecular),
  day: absolute(earthDay),
  bump: absolute(earthBump),
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

function textureOf({ rgba, geo }: CloudImage): THREE.DataTexture {
  // Bottom row first, so no flipY; filtered and mipmapped like an image.
  const texture = new THREE.DataTexture(rgba, OUT_W, OUT_H, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  // alphaMap is data, not colour.
  texture.colorSpace = THREE.NoColorSpace
  texture.userData.geo = geo
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
})

export function useRealCloudSnapshot(): RealCloudSnapshot {
  return useSyncExternalStore(realClouds.subscribe, realClouds.getSnapshot)
}

/** The shared snapshot; stops fetching when `active` turns false. */
export function useRealClouds(active: boolean): RealCloudSnapshot {
  useEffect(() => {
    if (!active) realClouds.deactivate()
  }, [active])
  return useRealCloudSnapshot()
}
