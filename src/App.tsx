import * as THREE from 'three'
import { forwardRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { View, OrbitControls, OrthographicCamera } from '@react-three/drei'
import useRefs from 'react-use-refs'

import SolarSystem from './solar-system'
import { useStore } from './store'
import Clock from './clock'

const matrix = new THREE.Matrix4()

export default function App() {
  const [solarSystemView, earthView, moonView] = useRefs()

  return (
    <div className="container">
      <Clock />
      <Canvas
        shadows
        eventSource={document.getElementById('root')}
        className="canvas"
      >
        <View.Port />
      </Canvas>
      <Panel
        ref={solarSystemView}
        gridArea="main"
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
      >
        <Scene
          background="black"
          matrix={matrix}
          moonCamera
        />
      </Panel>
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
    { gridArea, children, ...props }: { gridArea: string; children: any },
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
      </div>
    )
  }
)
