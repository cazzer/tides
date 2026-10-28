import * as THREE from 'three'
import { forwardRef, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  View,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from '@react-three/drei'
import useRefs from 'react-use-refs'

import SolarSystem from './solar-system'
import {
  parseFocus,
  serializeSystemAids,
  useStore,
  type PanelKey,
} from './store'
import Controls from './controls'
import { PIN_LAYER } from './LocationPin'
import LoadingOverlay from './LoadingOverlay'
import { advanceClock, type Jump } from './sim-clock'
import ViewMenu from './ViewMenu'
import CompassButton from './CompassButton'
import { TONE_MAPPING_EXPOSURE } from './lighting'
import { SURFACE_TILES_ON } from './surface'
import { MAIN_DISTANCE, MAIN_FOV } from './main-view'
import { ShipView } from './ship/ShipView'
import { ShipButton } from './ship/ShipButton'
import { RenderDiagnostics } from './renderers/RenderDiagnostics'
import { DepthPrecisionProbe } from './renderers/DepthPrecisionProbe'
import { DepthInfo } from './renderers/DepthInfo'
import { persistedView, SHIP_STAR_RADIUS } from './ship/ship-session'
import { mainCameraPose, rememberMainCameraPose } from './main-camera-session'
import { ScaleReadout } from './system-aids/ScaleReadout'
import type { DistanceScale } from './distance-scale'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { DemoBar } from './demo/DemoBar'
import { DemoClock } from './demo/DemoClock'
import { DemoPlayer } from './demo/DemoPlayer'

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
  const showConstellations = useStore((s) => s.showConstellations)
  const showConstellationArt = useStore((s) => s.showConstellationArt)
  const showLunar = useStore((s) => s.showLunar)
  const showZodiac = useStore((s) => s.showZodiac)
  const systemAids = useStore((s) => s.systemAids)
  const shipMode = useStore((s) => s.shipMode)
  const demo = useStore((s) => s.demo)

  // Read ?focus=, ?speed=, and ?panel= from URL on mount (before writing)
  useEffect(() => {
    const focus = parseFocus(
      new URLSearchParams(window.location.search).get('focus'),
      useStore.getState().showPlanets
    )
    if (focus) {
      setCameraFocus(focus)
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
    // A demo's view is never written: the URL keeps the user's own, and
    // leaving the demo (demo in the deps) writes the view it restores.
    if (useStore.getState().demo) return
    // Ship mode forces planets and speed: the URL keeps the user's own view,
    // so leaving ship mode leaves it as it was. The deps below cover it:
    // shipSaved changes only with shipMode.
    const view = persistedView(useStore.getState())
    const params = new URLSearchParams(window.location.search)
    params.set('focus', view.cameraFocus)
    params.set('speed', String(view.timeScale))
    params.set('panel', view.mainPanel)
    params.set('weather', weatherSource)
    params.set('layout', view.layout)
    if (view.showPlanets) {
      params.set('planets', '1')
    } else {
      params.delete('planets')
    }
    if (showConstellations) {
      params.set('constellations', showConstellationArt ? 'art' : '1')
    } else {
      params.delete('constellations')
    }
    if (showLunar) {
      params.set('lunar', '1')
    } else {
      params.delete('lunar')
    }
    if (showZodiac) {
      params.set('zodiac', '1')
    } else {
      params.delete('zodiac')
    }
    const aids = serializeSystemAids(systemAids)
    if (aids != null) {
      params.set('aids', aids)
    } else {
      params.delete('aids')
    }
    if (location) {
      params.set('lat', String(location.lat))
      params.set('lon', String(location.lon))
    } else {
      params.delete('lat')
      params.delete('lon')
    }
    if (shipMode) {
      params.set('ship', '1')
    } else {
      params.delete('ship')
    }
    const url = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, '', url)
  }, [cameraFocus, timeScale, location, mainPanel, weatherSource, layout, showPlanets, showConstellations, showConstellationArt, showLunar, showZodiac, systemAids, shipMode, demo])

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
      <DepthInfo />
      {!shipMode && !demo && <Controls />}
      {demo && <DemoBar />}
      <div className={single || shipMode ? 'viewports viewports--single' : 'viewports'}>
        <Canvas
          shadows
          eventSource={document.getElementById('root')}
          className="canvas"
          gl={{
            // Reversed-Z where EXT_clip_control is there, standard depth
            // otherwise (tides-zmw.9.3; shaders/depth.glsl).
            reversedDepthBuffer: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: TONE_MAPPING_EXPOSURE,
            // The surface tiles' handover from the globe (tides-zmw.9.7)
            // needs a stencil buffer; without the tiles, the default (none).
            stencil: SURFACE_TILES_ON,
          }}
        >
          <SimClock running={sceneReady} />
          <DemoClock />
          <RenderDiagnostics />
          <DepthPrecisionProbe />
          <View.Port />
        </Canvas>
        {shipMode && (
          <ShipView>
            <Scene
              background="black"
              matrix={matrix}
              showOrbitLabels
              calendar={false}
              starRadius={SHIP_STAR_RADIUS}
              distanceScale="flight"
              ship
              onReady={handleSceneReady}
            />
          </ShipView>
        )}
        {!shipMode && showPanel('main') && (
          <Panel
            ref={solarSystemView}
            {...panelProps('main')}
            overlay={
              panelProps('main').gridArea === 'main' ? (
                <>
                  {showPlanets && systemAids.scale && <ScaleReadout />}
                  {!demo && <ShipButton />}
                </>
              ) : undefined
            }
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
            <MainControls />
            <MainCameraSession />
            <DemoPlayer />
          </Panel>
        )}
        {!shipMode && showPanel('top') && (
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
        {!shipMode && showPanel('bottom') && (
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
        {/* A demo picks the view itself, and its bar covers this corner. */}
        {single && !shipMode && !demo && (
          <ViewMenu
            value={mainPanel}
            options={PANEL_OPTIONS}
            onChange={setMainPanel}
          />
        )}
        {single && !shipMode && !demo && mainPanel === 'top' && <CompassButton />}
      </div>
    </div>
  )
}

function Scene({
  background = 'white',
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  distanceScale = 'system',
  ship = false,
  onReady,
  ...props
}: {
  background?: string
  earthCamera?: boolean
  moonCamera?: boolean
  interactive?: boolean
  distanceScale?: DistanceScale
  ship?: boolean
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
            distanceScale={distanceScale}
            ship={ship}
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

const MAIN_EYE = new THREE.Vector3(100, 80, 80)
  .setLength(MAIN_DISTANCE)
  .toArray()

// near and far are set every frame (camera.tsx useMainNearFar).
function MainCamera() {
  const pose = mainCameraPose()
  return (
    <PerspectiveCamera
      makeDefault
      fov={MAIN_FOV}
      position={pose?.position ?? MAIN_EYE}
      quaternion={pose?.quaternion}
      up={pose?.up}
      near={1}
      far={4000}
    />
  )
}

// camera.tsx useEyeDistance sets minDistance and maxDistance. The target
// always follows the focus, so a pan would only be undone.
function MainControls() {
  return (
    <OrbitControls
      target={mainCameraPose()?.target ?? [0, 0, 0]}
      enablePan={false}
      makeDefault
    />
  )
}

function MainCameraSession() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  useEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera || camera instanceof THREE.PerspectiveCamera) || !controls) return
    return useStore.subscribe((state, previous) => {
      if ((!previous.shipMode && state.shipMode) || (!previous.demo && state.demo)) {
        rememberMainCameraPose(camera, controls as OrbitControlsImpl)
      }
    })
  }, [camera, controls])
  return null
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

  // Not the default camera, so nothing picks through it: under reversed-Z
  // (tides-zmw.9.3) three r180's Raycaster starts an orthographic ray at the
  // standard NDC depth, about 2 far out, so picking would miss everything.
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
      overlay,
      children,
      ...props
    }: {
      gridArea: string
      label?: string
      panelKey: PanelKey
      onSwap: (panelKey: PanelKey) => void
      /** DOM controls over the view, e.g. the ship button. */
      overlay?: ReactNode
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
        {overlay}
      </div>
    )
  }
)
