import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3, Matrix4, type InstancedMesh, type Object3D } from 'three'
import { useStore, type CameraFocus } from './store'
import { calculateLocationAndRotationForLatLng } from './utils'

const CameraContext = createContext({
  handleFocus: null,
})

const FOCUS_VALUES: CameraFocus[] = [
  'clock',
  'earth',
  'sun',
  'moon',
  'location',
]

function getFocusForObject(object: Object3D): CameraFocus | null {
  let o: Object3D | null = object
  while (o) {
    const focus = (o as Object3D & { userData?: { focus?: string } }).userData
      ?.focus
    if (focus && FOCUS_VALUES.includes(focus as CameraFocus)) {
      return focus as CameraFocus
    }
    o = o.parent
  }
  return null
}

export const useCamera = () => useContext(CameraContext)

export const CameraProvider = ({ children }: { children: any }) => {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const cameraTarget = useRef(new Vector3())
  const focusedObject = useRef<{
    object: Object3D
    instanceId?: number
  } | null>(null)
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const earth = useStore((s) => s.earth)
  const sun = useStore((s) => s.sun)
  const moon = useStore((s) => s.moon)
  const clock = useStore((s) => s.clock)
  const locationPin = useStore((s) => s.locationPin)
  const location = useStore((s) => s.location)
  const earthRadius = useStore((s) => s.earthRadius)

  useFrame(() => {
    const target = new Vector3()
    let hasTarget = false

    if (cameraFocus) {
      if (cameraFocus === 'location') {
        if (locationPin?.current) {
          locationPin.current.getWorldPosition(target)
          hasTarget = true
        } else if (location && earth?.current && earthRadius != null) {
          const { position } = calculateLocationAndRotationForLatLng(
            location.lat,
            location.lon,
            earthRadius
          )
          target.set(position.x, position.y, position.z)
          earth.current.localToWorld(target)
          hasTarget = true
        }
      } else {
        const ref =
          cameraFocus === 'clock'
            ? clock
            : cameraFocus === 'earth'
            ? earth
            : cameraFocus === 'sun'
            ? sun
            : moon
        if (ref?.current) {
          if (cameraFocus === 'clock') {
            ref.current.getWorldPosition(target)
          } else {
            target.copy(ref.current.position)
          }
          hasTarget = true
        }
      }
    }

    const focused = focusedObject.current
    if (!hasTarget && focused) {
      if (focused.instanceId !== undefined) {
        const instanced = focused.object as InstancedMesh
        const instanceMatrix = new Matrix4()
        instanced.getMatrixAt(focused.instanceId, instanceMatrix)
        target.copy(new Vector3().setFromMatrixPosition(instanceMatrix))
      } else {
        focused.object.getWorldPosition(target)
      }
      hasTarget = true
    }

    if (hasTarget && controls) {
      const smoothness = 0.05
      cameraTarget.current.lerp(target, smoothness)
      camera.lookAt(cameraTarget.current)
      // @ts-ignore
      controls.target.copy(cameraTarget.current)
      // @ts-ignore
      controls.update()
    }
  })

  // Handle focus: update store (and thus dropdown) when a known body is clicked.
  const handleFocus = useCallback(
    (event: any) => {
      const object = event.intersection?.object ?? event.object
      const instanceId = event.instanceId
      const focus = getFocusForObject(object)
      if (focus) {
        setCameraFocus(focus)
      }
      focusedObject.current =
        instanceId !== undefined ? { object, instanceId } : { object }
    },
    [setCameraFocus]
  )
  const value = useMemo(() => ({ handleFocus }), [handleFocus])

  return (
    <CameraContext.Provider value={value}>
      {children}
    </CameraContext.Provider>
  )
}
