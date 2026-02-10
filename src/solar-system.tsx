import { useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { DateTime } from 'luxon'
import OrbitingBody from './OrbitingBody'
import SunRenderer from './renderers/SunRenderer'
import EarthRenderer from './renderers/EarthRenderer'
import MoonRenderer from './renderers/MoonRenderer'
import { scaleLog, scaleLinear, easeExpInOut } from 'd3'
import suncalc from 'suncalc'
import { CameraProvider } from './camera'
import { useStore } from './store'

import sunTexture from './assets/sun-8k.jpg'
import earthTexture from './assets/earth-8k-day.jpg'
import moonTexture from './assets/moon-8k.jpg'
import { interpolateValue } from './utils'

const scaleDiameter = scaleLog().domain([3474800, 1392700000]).range([1, 10])
const scaleOrbit = scaleLinear()
  .domain([384400000, 149597870700])
  .range([10, 50])

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
  const { setPlanet, timeScale, jumpDate, jumpDateSetAt, setJumpDate } =
    useStore()
  const sun = useRef()
  const earth = useRef()
  const moon = useRef()

  useEffect(() => {
    setPlanet('earth', earth)
    setPlanet('sun', sun)
    setPlanet('moon', moon)
  }, [])

  useFrame((state, delta) => {
    let newTime

    if (jumpDate) {
      // @ts-ignore
      if (!state.startJumpAt) {
        // @ts-ignore
        state.startJumpAt = state.timestamp
      }

      const duration = 5000
      const jumpDateMillis = jumpDate.getTime()
      const jumpDateSetAtMillis = jumpDateSetAt.getTime()
      newTime = interpolateValue(
        // @ts-ignore
        state.startJumpAt,
        jumpDateMillis,
        (Date.now() - jumpDateSetAtMillis) / duration,
        easeExpInOut
      )
      if (Date.now() - jumpDateSetAtMillis > duration) {
        setJumpDate(null)
        // @ts-ignore
        state.startJumpAt = null
      }
    } else {
      newTime =
        // @ts-ignore
        (parseInt(state.timestamp) || Date.now()) + delta * 1000 * timeScale
    }

    state.set({
      // @ts-ignore
      timestamp: newTime,
    })
  })

  const earthOrbitalPeriod = 365.256 * 24 * 3600000
  const start = DateTime.utc(2024, 1, 1, 0, 0, 0)
  const end = DateTime.utc(2024, 12, 31, 23, 59, 59)
  const summerSolstice = DateTime.utc(2024, 6, 20, 20, 51, 0)

  const angle =
    ((summerSolstice.toMillis() - start.toMillis()) /
      (end.toMillis() - start.toMillis())) *
      Math.PI *
      2 -
    Math.PI / 2

  const earthOffset = suncalc.getPosition(new Date(), 0, 0)

  return (
    <CameraProvider>
      <ambientLight intensity={1} />

      <OrbitingBody
        ref={sun}
        focusKey="sun"
        rotationPeriod={609.12 * 3600000}
        interactive={interactive}
      >
        <SunRenderer
          diameter={scaleDiameter(1392700000)}
          texture={sunTexture}
        />
      </OrbitingBody>
      <OrbitingBody
        surfaceCamera={earthCamera}
        moonCamera={moonCamera}
        ref={earth}
        focusKey="earth"
        storeLabel="earth"
        parent={sun}
        showOrbit={showOrbitLabels}
        diameter={scaleDiameter(12742000)}
        rotationPeriod={24 * 3600000}
        orbitalDistance={scaleOrbit(149597870700)}
        orbitalPeriod={earthOrbitalPeriod}
        orbitalInclination={0}
        orbitOffset={angle}
        rotationOffset={2 * Math.PI * earthOffset.azimuth}
        axialTilt={23.4}
        interactive={interactive}
      >
        <EarthRenderer
          diameter={scaleDiameter(12742000)}
          texture={earthTexture}
        />
      </OrbitingBody>
      <OrbitingBody
        ref={moon}
        focusKey="moon"
        parent={earth}
        diameter={scaleDiameter(3474800)}
        orbitalDistance={scaleOrbit(384400000)}
        orbitalPeriod={655.728 * 3600000}
        orbitOffset={(8 / 180) * Math.PI}
        orbitalInclination={-21}
        rotationPeriod={655.728 * 3600000}
        rotationOffset={2.5}
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
