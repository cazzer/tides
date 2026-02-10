import * as THREE from 'three'
import { forwardRef, useEffect, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { View, OrbitControls, OrthographicCamera } from '@react-three/drei'
import useRefs from 'react-use-refs'
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode, BlendFunction } from 'postprocessing'

import SolarSystem from './solar-system'
import { useStore, type CameraFocus } from './store'
import Controls from './controls'

const FOCUS_VALUES: CameraFocus[] = ['clock', 'earth', 'sun', 'moon']

const matrix = new THREE.Matrix4()

export default function App() {
  const [solarSystemView, earthView, moonView] = useRefs()
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const location = useStore((s) => s.location)

  // Read ?focus= from URL on mount (before writing)
  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get('focus')
    if (focus && FOCUS_VALUES.includes(focus as CameraFocus)) {
      setCameraFocus(focus as CameraFocus)
    }
  }, [setCameraFocus])

  // Write focus to URL when it changes; skip first run so we don't overwrite URL before read
  const isFirstWrite = useRef(true)
  useEffect(() => {
    if (isFirstWrite.current) {
      isFirstWrite.current = false
      return
    }
    const params = new URLSearchParams(window.location.search)
    params.set('focus', cameraFocus)
    if (location) {
      params.set('lat', String(location.lat))
      params.set('lon', String(location.lon))
    } else {
      params.delete('lat')
      params.delete('lon')
    }
    const url = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, '', url)
  }, [cameraFocus, location])

  return (
    <div className="container">
      <Controls />
      <div className="viewports">
        <Canvas
          shadows
          eventSource={document.getElementById('root')}
          className="canvas"
          gl={{
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.0,
          }}
        >
          <View.Port />
        </Canvas>
        <Panel
          ref={solarSystemView}
          gridArea="main"
          label="Three Body System"
        >
          <MainCamera />
          <Scene
            background="black"
            matrix={matrix}
            interactive
            showOrbitLabels
          />
          <OrbitControls
            maxDistance={80}
            minDistance={5}
            makeDefault
          />
        </Panel>
        <Panel
          ref={earthView}
          gridArea="top"
          label="View from Earth"
        >
          <PanelCamera />
          <Scene
            background="black"
            matrix={matrix}
            earthCamera
          />
        </Panel>
        <Panel
          ref={moonView}
          gridArea="bottom"
          label="Moon Phase"
        >
          <Scene
            background="black"
            matrix={matrix}
            moonCamera
          />
        </Panel>
      </div>
    </div>
  )
}

function Scene({
  background = 'white',
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  ...props
}) {
  return (
    <>
      <color
        attach="background"
        args={[background]}
      />
      <group
        matrixAutoUpdate={false}
        onUpdate={(self) => (self.matrix = matrix)}
        {...props}
      >
        <SolarSystem
          earthCamera={earthCamera}
          moonCamera={moonCamera}
          interactive={interactive}
          {...props}
        />
      </group>
    </>
  )
}

function MainCamera() {
  return (
    <OrthographicCamera
      makeDefault
      position={[100, 80, 80]}
      zoom={10}
      near={0}
    />
  )
}

function PanelCamera() {
  const { earth } = useStore()
  if (!earth) {
    return
  }

  return (
    <OrthographicCamera
      position={[
        earth.current.position.x,
        earth.current.position.y,
        earth.current.position.z,
      ]}
      zoom={5}
    />
  )
}

// @ts-ignore
const Panel = forwardRef(
  (
    {
      gridArea,
      label,
      children,
      ...props
    }: { gridArea: string; label?: string; children: any },
    fref
  ) => {
    return (
      <div
        // @ts-ignore
        ref={fref}
        className="panel"
        style={{ gridArea }}
      >
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
          }}
        >
          {children}
        </View>
        {label && <span className="panel-label">{label}</span>}
      </div>
    )
  }
)
