import * as THREE from 'three'
import { forwardRef, useEffect, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { View, OrbitControls, OrthographicCamera } from '@react-three/drei'
import useRefs from 'react-use-refs'
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode, BlendFunction } from 'postprocessing'

import SolarSystem from './solar-system'
import { useStore, type CameraFocus, type PanelKey } from './store'
import Controls from './controls'
import { PIN_LAYER } from './LocationPin'

const FOCUS_VALUES: CameraFocus[] = [
  'clock',
  'earth',
  'sun',
  'moon',
  'location',
]

const PANEL_VALUES: PanelKey[] = ['main', 'top', 'bottom']

const matrix = new THREE.Matrix4()

export default function App() {
  const [solarSystemView, earthView, moonView] = useRefs()
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const mainPanel = useStore((s) => s.mainPanel)
  const setMainPanel = useStore((s) => s.setMainPanel)
  const timeScale = useStore((s) => s.timeScale)
  const location = useStore((s) => s.location)

  // Read ?focus=, ?speed=, and ?panel= from URL on mount (before writing)
  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get('focus')
    if (focus && FOCUS_VALUES.includes(focus as CameraFocus)) {
      setCameraFocus(focus as CameraFocus)
    }
    const panel = new URLSearchParams(window.location.search).get('panel')
    if (panel && PANEL_VALUES.includes(panel as PanelKey)) {
      setMainPanel(panel as PanelKey)
    }
  }, [setCameraFocus, setMainPanel])

  // Write focus and speed to URL when they change; skip first run so we don't overwrite URL before read
  const isFirstWrite = useRef(true)
  useEffect(() => {
    if (isFirstWrite.current) {
      isFirstWrite.current = false
      return
    }
    const params = new URLSearchParams(window.location.search)
    params.set('focus', cameraFocus)
    params.set('speed', String(timeScale))
    params.set('panel', mainPanel)
    if (location) {
      params.set('lat', String(location.lat))
      params.set('lon', String(location.lon))
    } else {
      params.delete('lat')
      params.delete('lon')
    }
    const url = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, '', url)
  }, [cameraFocus, timeScale, location, mainPanel])

  const handlePanelSwap = (panelKey: PanelKey) => {
    if (panelKey !== mainPanel) {
      setMainPanel(panelKey)
    }
  }

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
          gridArea={getGridArea('main', mainPanel)}
          label="Three Body System"
          panelKey="main"
          onSwap={handlePanelSwap}
        >
          <MainCamera />
          <EnablePinLayerForCamera />
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
          gridArea={getGridArea('top', mainPanel)}
          label="View from Earth"
          panelKey="top"
          onSwap={handlePanelSwap}
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
          gridArea={getGridArea('bottom', mainPanel)}
          label="Moon Phase"
          panelKey="bottom"
          onSwap={handlePanelSwap}
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

/** Ensures the main view's camera sees the location pin (PIN_LAYER). Only used in the main panel. */
function EnablePinLayerForCamera() {
  const { camera } = useThree()
  useFrame(() => {
    camera.layers.enable(PIN_LAYER)
  })
  return null
}

function PanelCamera() {
  const { earth } = useStore()
  if (!earth?.current) {
    return null
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

function getGridArea(panelKey: PanelKey, mainPanel: PanelKey) {
  if (panelKey === mainPanel) return 'main'
  if (mainPanel === 'top') {
    return panelKey === 'main' ? 'top' : 'bottom'
  }
  if (mainPanel === 'bottom') {
    return panelKey === 'main' ? 'bottom' : 'top'
  }
  return panelKey
}

// @ts-ignore
const Panel = forwardRef(
  (
    {
      gridArea,
      label,
      panelKey,
      onSwap,
      children,
      ...props
    }: {
      gridArea: string
      label?: string
      panelKey: PanelKey
      onSwap: (panelKey: PanelKey) => void
      children: any
    },
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
        {label && (
          <button
            className="panel-label"
            type="button"
            onClick={() => onSwap(panelKey)}
          >
            {label}
          </button>
        )}
      </div>
    )
  }
)
