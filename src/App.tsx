import * as THREE from 'three'
import { forwardRef, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { View, OrbitControls, OrthographicCamera } from '@react-three/drei'
import useRefs from 'react-use-refs'
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode, BlendFunction } from 'postprocessing'

import SolarSystem from './solar-system'
import { useStore, type CameraFocus, type PanelKey } from './store'
import Controls from './controls'
import { PIN_LAYER } from './LocationPin'
import LoadingOverlay from './LoadingOverlay'
import { advanceClock, type Jump } from './sim-clock'
import ViewMenu from './ViewMenu'
import { CloudAttribution } from './CloudAttribution'
import { PlanetAttribution } from './PlanetAttribution'
import { TONE_MAPPING_EXPOSURE } from './lighting'

const FOCUS_VALUES: CameraFocus[] = [
  'clock',
  'earth',
  'sun',
  'moon',
  'location',
]

const PANEL_VALUES: PanelKey[] = ['main', 'top', 'bottom']

const PANEL_OPTIONS: { value: PanelKey; label: string }[] = [
  { value: 'main', label: 'Three Body System' },
  { value: 'top', label: 'View from Earth' },
  { value: 'bottom', label: 'Moon Phase' },
]

const matrix = new THREE.Matrix4()

export default function App() {
  const [solarSystemView, earthView, moonView] = useRefs()
  const [sceneReady, setSceneReady] = useState(false)
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const mainPanel = useStore((s) => s.mainPanel)
  const setMainPanel = useStore((s) => s.setMainPanel)
  const timeScale = useStore((s) => s.timeScale)
  const location = useStore((s) => s.location)
  const weatherSource = useStore((s) => s.weatherSource)
  const layout = useStore((s) => s.layout)
  const showPlanets = useStore((s) => s.showPlanets)

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
    params.set('weather', weatherSource)
    params.set('layout', layout)
    if (showPlanets) {
      params.set('planets', '1')
    } else {
      params.delete('planets')
    }
    if (location) {
      params.set('lat', String(location.lat))
      params.set('lon', String(location.lon))
    } else {
      params.delete('lat')
      params.delete('lon')
    }
    const url = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, '', url)
  }, [cameraFocus, timeScale, location, mainPanel, weatherSource, layout, showPlanets])

  const handlePanelSwap = (panelKey: PanelKey) => {
    if (panelKey !== mainPanel) {
      setMainPanel(panelKey)
    }
  }

  const handleSceneReady = useCallback(() => {
    setSceneReady(true)
  }, [])

  // Single layout mounts only the chosen panel, so the others never render.
  const single = layout === 'single'
  const showPanel = (panelKey: PanelKey) => !single || panelKey === mainPanel
  const panelProps = (panelKey: PanelKey) => ({
    gridArea: single ? 'main' : getGridArea(panelKey, mainPanel),
    // Single layout swaps views through the ViewMenu instead.
    label: single
      ? undefined
      : PANEL_OPTIONS.find((o) => o.value === panelKey)!.label,
    panelKey,
    onSwap: handlePanelSwap,
  })
  // The clock waits for the main scene; in single layout that is the shown one.
  const readyHandler = (panelKey: PanelKey) =>
    single || panelKey === 'main' ? handleSceneReady : undefined

  return (
    <div className="container">
      <LoadingOverlay sceneReady={sceneReady} />
      <Controls />
      <div className={single ? 'viewports viewports--single' : 'viewports'}>
        <Canvas
          shadows
          eventSource={document.getElementById('root')}
          className="canvas"
          gl={{
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: TONE_MAPPING_EXPOSURE,
          }}
        >
          <SimClock running={sceneReady} />
          <View.Port />
        </Canvas>
        {showPanel('main') && (
          <Panel
            ref={solarSystemView}
            {...panelProps('main')}
          >
            <MainCamera />
            <EnablePinLayerForCamera />
            <Scene
              background="black"
              matrix={matrix}
              interactive
              showOrbitLabels
              onReady={readyHandler('main')}
            />
            <OrbitControls
              maxDistance={80}
              minDistance={5}
              makeDefault
            />
          </Panel>
        )}
        {showPanel('top') && (
          <Panel
            ref={earthView}
            {...panelProps('top')}
          >
            <PanelCamera />
            <Scene
              background="black"
              matrix={matrix}
              earthCamera
              onReady={readyHandler('top')}
            />
          </Panel>
        )}
        {showPanel('bottom') && (
          <Panel
            ref={moonView}
            {...panelProps('bottom')}
          >
            <Scene
              background="black"
              matrix={matrix}
              moonCamera
              onReady={readyHandler('bottom')}
            />
          </Panel>
        )}
        {/* Outside the panels, so it (and its focus) survives the view switch. */}
        {single && (
          <ViewMenu
            value={mainPanel}
            options={PANEL_OPTIONS}
            onChange={setMainPanel}
          />
        )}
        <div className="viewport-credits">
          {weatherSource === 'real' && <CloudAttribution />}
          {showPlanets && <PlanetAttribution />}
        </div>
      </div>
    </div>
  )
}

function Scene({
  background = 'white',
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  onReady,
  ...props
}: {
  background?: string
  earthCamera?: boolean
  moonCamera?: boolean
  interactive?: boolean
  onReady?: () => void
  [key: string]: any
}) {
  return (
    <>
      <color
        attach="background"
        args={[background]}
      />
      <Suspense fallback={null}>
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
          {onReady ? <SceneReadySignal onReady={onReady} /> : null}
        </group>
      </Suspense>
    </>
  )
}

/**
 * The one simulation clock. Mounted in the root Canvas, outside every View, so
 * all panels share it; priority -1 runs it before the panels' frames without
 * taking over rendering. That relies on every View portal sharing the root's
 * subscriber list and on drei's View rendering at priority >= 1: moving this
 * inside a View, or dropping the -1, brings back a one-frame lag.
 */
function SimClock({ running }: { running: boolean }) {
  const jump = useRef<Jump | null>(null)
  const runningRef = useRef(running)
  useEffect(() => {
    runningRef.current = running
  }, [running])

  useFrame((state, delta) => {
    const { timestamp, timeScale, initialTimestamp, jumpDate, setJumpDate } =
      useStore.getState()
    const input = {
      now: Date.now(),
      elapsed: state.clock.elapsedTime,
      delta,
      timeScale,
      initialTimestamp,
      jumpTo: jumpDate ? jumpDate.getTime() : null,
    }
    // Until the scene has loaded, restart from ?t= (or now) every frame, so
    // loading time never counts as simulated time (tides-8pz).
    const next = runningRef.current
      ? advanceClock({ timestamp, jump: jump.current }, input)
      : advanceClock(
          { timestamp: null, jump: null },
          { ...input, delta: 0, jumpTo: null }
        )
    jump.current = next.jump
    useStore.setState({ timestamp: next.timestamp })
    if (next.jumpDone) setJumpDate(null)
  }, -1)
  return null
}

function SceneReadySignal({ onReady }: { onReady: () => void }) {
  const hasSignaledRef = useRef(false)
  const frameCountRef = useRef(0)

  useFrame(() => {
    if (hasSignaledRef.current) return

    frameCountRef.current += 1
    if (frameCountRef.current >= 2) {
      hasSignaledRef.current = true
      onReady()
    }
  })

  return null
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
  const camera = useThree((s) => s.camera)
  useFrame(() => {
    camera.layers.enable(PIN_LAYER)
  })
  return null
}

function PanelCamera() {
  const earth = useStore((s) => s.earth)
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
        data-area={gridArea}
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
