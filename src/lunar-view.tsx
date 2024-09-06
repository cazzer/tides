import { useRef } from 'react'
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { Plane, useFBO } from '@react-three/drei'
import * as THREE from 'three'

export default function LunarView({ useCameraStore }: { useCameraStore: any }) {
  const aTarget = useFBO(window.innerWidth / 2, window.innerHeight / 3)
  const bTarget = useFBO(window.innerWidth / 2, window.innerHeight / 3)

  const { earth, moon } = useCameraStore((state: any) => ({
    earth: state.ACam,
    moon: state.BCam,
  }))

  const { scene } = useThree()

  const mnm = new THREE.MeshNormalMaterial()
  const dmm = new THREE.MeshNormalMaterial()

  useFrame(({ gl, camera, scene }) => {
    gl.autoClear = false

    /** Render scene from camera A to a render target */
    scene.overrideMaterial = mnm
    gl.setRenderTarget(aTarget)
    // gl.render(scene, earth.current)

    // /** Render scene from camera B to a different render target */
    // scene.overrideMaterial = dmm
    // gl.setRenderTarget(bTarget)
    // gl.render(scene, BCam.current)

    // render main scene
    scene.overrideMaterial = null
    gl.setRenderTarget(null)
    gl.render(scene, camera)

    // render GUI panels on top of main scene
    gl.render(scene, camera)
    gl.autoClear = true
  }, 1)

  return createPortal(
    <>
      <Plane
        args={[window.innerWidth / 2, window.innerHeight / 3, 1]}
        position-y={0}
      >
        <meshBasicMaterial map={aTarget.texture} color="blue" />
      </Plane>

      {/* <Plane
        args={[window.innerWidth / 2, window.innerHeight / 3, 1]}
        position-y={window.innerWidth / 2}
      >
        <meshBasicMaterial map={bTarget.texture} />
      </Plane> */}
    </>,
    scene
  )
}
