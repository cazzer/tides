import { createContext, useContext, useState, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3, Matrix4 } from 'three'

const CameraContext = createContext({
  focusedObject: null,
  handleFocus: null,
})

export const useCamera = () => useContext(CameraContext)

export const CameraProvider = ({ children }: { children: any }) => {
  const { camera, controls } = useThree()
  const cameraTarget = useRef(new Vector3())
  const [focusedObject, setFocusedObject] = useState(null)

  useFrame(() => {
    if (focusedObject) {
      let target = new Vector3()
      let targetRotation = new Vector3()

      if (focusedObject.instanceId !== undefined) {
        const instanceMatrix = new Matrix4()
        focusedObject.object.getMatrixAt(
          focusedObject.instanceId,
          instanceMatrix
        )
        target = new Vector3().setFromMatrixPosition(instanceMatrix)
      } else {
        focusedObject.object.getWorldPosition(target)
        focusedObject.object.getWorldDirection(targetRotation)
      }

      const smoothness = 0.05
      cameraTarget.current.lerp(target, smoothness)
      camera.lookAt(cameraTarget.current)

      // @ts-ignore
      controls.target.copy(cameraTarget.current)
      // @ts-ignore
      controls.update()
    }
  })

  // Handle focus
  const handleFocus = (event: any) => {
    const object = event.object
    const instanceId = event.instanceId

    if (instanceId !== undefined) {
      setFocusedObject({ object, instanceId })
    } else {
      setFocusedObject({ object })
    }
  }

  return (
    <CameraContext.Provider value={{ focusedObject, handleFocus }}>
      {children}
    </CameraContext.Provider>
  )
}
