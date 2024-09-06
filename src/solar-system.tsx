import { useRef, useState, useEffect } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import Planet from './planet'
import * as THREE from 'three'
// import { scaleDiameter } from './utils'
import { OrbitControls, mesh } from '@react-three/drei'
import { scaleLog, scaleLinear } from 'd3'
import { CameraProvider } from './camera'
import { useStore } from './store'
import { scaleTime } from './utils'
import { OrbitLabel } from './orbit-label'

const scaleDiameter = scaleLog().domain([3474800, 1392700000]).range([1, 10])
const scaleOrbit = scaleLinear()
  .domain([384400000, 149597870700])
  .range([10, 50])

export default function SolarSystem({
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  showOrbitLabels,
  store,
}: {
  earthCamera?: boolean
  moonCamera?: boolean
  interactive?: boolean
  showOrbitLabels?: boolean
  store?: any
}) {
  const [cameraFocus, setCameraFocus] = useState(null)
  const { setPlanet, timeScale, time, setTime } = store()
  const sun = useRef()
  const earth = useRef()
  const moon = useRef()

  useEffect(() => {
    setPlanet('moon', moon)
  }, [])

  useFrame((state, delta) => {
    const newTime =
      (parseInt(state.timestamp) || Date.now()) + delta * 1000 * timeScale
    state.set({
      timestamp: newTime,
    })
  })

  useThree()

  return (
    <CameraProvider>
      <ambientLight intensity={1} />

      <Planet
        ref={sun}
        emitLight
        initialPosition={[0, 0, 0]}
        diameter={scaleDiameter(1392700000)}
        rotationPeriod={609.12 * 3600000}
        texture="https://upload.wikimedia.org/wikipedia/commons/thumb/9/99/Map_of_the_full_sun.jpg/1280px-Map_of_the_full_sun.jpg"
        interactive={interactive}
      />
      <Planet
        surfaceCamera={earthCamera}
        moonCamera={moonCamera}
        ref={earth}
        storeLabel="earth"
        parent={sun}
        showOrbit={showOrbitLabels}
        diameter={scaleDiameter(12742000)}
        rotationPeriod={24 * 3600000}
        orbitalDistance={scaleOrbit(149597870700)}
        orbitalPeriod={8764.8 * 3600000}
        orbitalVelocity={29.8}
        orbitalInclination={0}
        axialTilt={23.4}
        texture="https://upload.wikimedia.org/wikipedia/commons/0/04/Solarsystemscope_texture_8k_earth_daymap.jpg"
        interactive={interactive}
      />
      <Planet
        ref={moon}
        storeLabel="moon"
        parent={earth}
        diameter={scaleDiameter(3474800)}
        orbitalDistance={scaleOrbit(384400000)}
        orbitalPeriod={655.728 * 3600000}
        orbitalInclination={21}
        rotationPeriod={655.728 * 3600000}
        axialTilt={1.53}
        texture="https://upload.wikimedia.org/wikipedia/commons/4/4b/Solarsystemscope_texture_2k_haumea_fictional.jpg"
        interactive={interactive}
      />
    </CameraProvider>
  )
}
