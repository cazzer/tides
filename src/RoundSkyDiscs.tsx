import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { roundDiscMatrix } from './sky'

const center = new THREE.Vector3()
const squash = new THREE.Matrix4()
const parentInverse = new THREE.Matrix4()

/**
 * Keeps the sky Sun and Moon round in the View from Earth panel (see
 * roundDiscMatrix). Each body's OrbitingBody group takes the squash just
 * before the panel draws, once the camera has moved for the frame; other
 * cameras (the Sun's CubeCamera) leave it as it was.
 */
export function RoundSkyDiscs({
  bodies,
}: {
  bodies: RefObject<THREE.Object3D | null>[]
}) {
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  useEffect(() => roundDiscsBeforeRender(scene, camera, bodies), [scene, camera, bodies])

  return null
}

// Outside the component: the react-hooks lint rejects mutating the scene from
// useThree in place. Returns the cleanup.
function roundDiscsBeforeRender(
  scene: THREE.Scene,
  camera: THREE.Camera,
  bodies: RefObject<THREE.Object3D | null>[]
) {
  const previous = scene.onBeforeRender
  scene.onBeforeRender = (_renderer, _scene, renderCamera) => {
    if (renderCamera !== camera) return
    for (const body of bodies) {
      const group = body.current?.parent
      if (!body.current || !group?.parent) continue
      group.matrixAutoUpdate = false
      center.copy(body.current.position).applyMatrix4(group.parent.matrixWorld)
      roundDiscMatrix(squash, center, camera)
      parentInverse.copy(group.parent.matrixWorld).invert()
      group.matrix.multiplyMatrices(parentInverse, squash).multiply(group.parent.matrixWorld)
      group.updateMatrixWorld(true)
    }
  }
  return () => {
    scene.onBeforeRender = previous
    for (const body of bodies) {
      const group = body.current?.parent
      if (!group) continue
      group.matrixAutoUpdate = true
      group.matrix.identity()
    }
  }
}
