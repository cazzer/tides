import { useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import OrbitingBody from './OrbitingBody'
import SunRenderer from './renderers/SunRenderer'
import EarthRenderer from './renderers/EarthRenderer'
import MoonRenderer from './renderers/MoonRenderer'
import Starfield from './renderers/Starfield'
import { scaleLog, easeExpInOut } from 'd3'
import { CameraProvider } from './camera'
import { OrbitLabel } from './orbit-label'
import { useStore } from './store'

import earthTextureHigh from './assets/earth-day.jpg'
import earthTextureLow from './assets/earth-day-2k.jpg'
import moonTextureHigh from './assets/moon.jpg'
import moonTextureLow from './assets/moon-2k.jpg'
import { interpolateValue } from './utils'
import {
  EARTH_AXIAL_TILT,
  EARTH_ORBIT_RADIUS,
  earthPosition,
  earthSpin,
  moonPosition,
  moonSpin,
  sunSpin,
} from './ephemeris'

const scaleDiameter = scaleLog().domain([3474800, 1392700000]).range([1, 10])

const JUMP_DURATION_MS = 5000

useTexture.preload(earthTextureHigh)

export default function SolarSystem({
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  showOrbitLabels,
}: {
  earthCamera?: boolean
  moonCamera?: boolean
  interactive?: boolean
  showOrbitLabels?: boolean
}) {
  const earthTexture = getEarthTexture()
  const moonTexture = getMoonTexture()
  useTexture.preload(earthTexture)
  useTexture.preload(moonTexture)
  const setPlanet = useStore((s) => s.setPlanet)
  const timeScale = useStore((s) => s.timeScale)
  const initialTimestamp = useStore((s) => s.initialTimestamp)
  const jumpDate = useStore((s) => s.jumpDate)
  const setJumpDate = useStore((s) => s.setJumpDate)
  const sun = useRef(null)
  const earth = useRef(null)
  const moon = useRef(null)

  useEffect(() => {
    setPlanet('earth', earth)
    setPlanet('sun', sun)
    setPlanet('moon', moon)
  }, [])

  useFrame((state, delta) => {
    const simulationState = state as typeof state & {
      timestamp?: number
      startJumpAt?: number | null
      startJumpClock?: number | null
    }
    const currentTimestamp =
      typeof simulationState.timestamp === 'number'
        ? simulationState.timestamp
        : initialTimestamp ?? Date.now()
    let newTime

    if (jumpDate) {
      if (!simulationState.startJumpAt) {
        simulationState.startJumpAt = currentTimestamp
        simulationState.startJumpClock = state.clock.elapsedTime
      }

      const jumpDateMillis = jumpDate.getTime()
      const jumpStartClock = simulationState.startJumpClock ?? state.clock.elapsedTime
      const jumpElapsedMs = (state.clock.elapsedTime - jumpStartClock) * 1000
      const jumpProgress = Math.min(1, Math.max(0, jumpElapsedMs / JUMP_DURATION_MS))
      newTime = interpolateValue(
        simulationState.startJumpAt ?? currentTimestamp,
        jumpDateMillis,
        jumpProgress,
        easeExpInOut
      )
      if (jumpProgress >= 1) {
        setJumpDate(null)
        simulationState.startJumpAt = null
        simulationState.startJumpClock = null
      }
    } else {
      newTime = currentTimestamp + delta * 1000 * timeScale
    }

    state.set({
      // @ts-ignore
      timestamp: newTime,
    })
  })

  return (
    <CameraProvider>
      <ambientLight intensity={1} />

      <Starfield />

      <OrbitingBody
        ref={sun}
        focusKey="sun"
        spinAt={sunSpin}
        interactive={interactive}
      >
        <SunRenderer
          diameter={scaleDiameter(1392700000)}
        />
      </OrbitingBody>
      <OrbitingBody
        surfaceCamera={earthCamera}
        moonCamera={moonCamera}
        ref={earth}
        focusKey="earth"
        storeLabel="earth"
        diameter={scaleDiameter(12742000)}
        positionAt={earthPosition}
        spinAt={earthSpin}
        axialTilt={EARTH_AXIAL_TILT}
        interactive={interactive}
      >
        <EarthRenderer
          diameter={scaleDiameter(12742000)}
          texture={earthTexture}
        />
      </OrbitingBody>
      {showOrbitLabels && <OrbitLabel radius={EARTH_ORBIT_RADIUS} />}
      <OrbitingBody
        ref={moon}
        focusKey="moon"
        diameter={scaleDiameter(3474800)}
        positionAt={moonPosition}
        spinAt={moonSpin}
        axialTilt={-1.53}
        interactive={interactive}
      >
        <MoonRenderer
          diameter={scaleDiameter(3474800)}
          texture={moonTexture}
        />
      </OrbitingBody>
    </CameraProvider>
  )
}

function getMoonTexture() {
  if (typeof window === 'undefined') return moonTextureHigh
  const quality = getQualityOverride()
  const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  const useLow = quality === 'low' || (quality !== 'high' && isMobile)
  return useLow ? moonTextureLow : moonTextureHigh
}

function getEarthTexture() {
  if (typeof window === 'undefined') return earthTextureHigh
  const quality = getQualityOverride()
  const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  const useLow = quality === 'low' || (quality !== 'high' && isMobile)
  return useLow ? earthTextureLow : earthTextureHigh
}

function getQualityOverride() {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('quality')
  if (value === 'low' || value === 'high') return value
  return null
}

function fitCameraToObjects(camera, objects, controls) {
  const offset = 1

  const boundingBox = new THREE.Box3()

  // get bounding box of object - this will be used to setup controls and camera>
  objects.forEach((object: any) => {
    boundingBox.expandByObject(object)
  })

  const center = new THREE.Vector3()
  boundingBox.getCenter(center)

  const size = new THREE.Vector3()
  boundingBox.getSize(size)

  // get the max side of the bounding box (fits to width OR height as needed )
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = 50 * (Math.PI / 180)
  // let cameraZ = Math.abs((maxDim / 4) * Math.tan(fov * 2))
  let cameraZ = 100

  cameraZ *= offset // zoom out a little so that objects don't fill the screen

  camera.position.z = center.z
  camera.position.x = center.x + 30
  camera.position.y = 100

  const minZ = boundingBox.min.z
  const cameraToFarEdge = minZ < 0 ? -minZ + cameraZ : cameraZ - minZ

  camera.far = cameraToFarEdge * 3
  camera.updateProjectionMatrix()

  if (controls) {
    // set camera to rotate around center of loaded object
    // controls.target = new THREE.Vector3(0, 0, 0)
    controls.target = center

    // prevent camera from zooming out far enough to create far plane cutoff
    controls.maxDistance = cameraToFarEdge * 2

    controls.saveState()
  } else {
    camera.lookAt(center)
  }
}
