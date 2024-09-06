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
      <Panel ref={solarSystemView} gridArea="main">
        <MainCamera />
        <Scene background="black" matrix={matrix} interactive showOrbitLabels />
        <OrbitControls maxDistance={80} minDistance={5} makeDefault />
      </Panel>
      <Panel ref={earthView} gridArea="top">
        <PanelCamera which="earth" />
        <Scene background="black" matrix={matrix} earthCamera />
      </Panel>
      <Panel ref={moonView} gridArea="bottom">
        <Scene background="black" matrix={matrix} moonCamera />
      </Panel>
    </div>
  )
}

function Scene({
  background = 'white',
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  children,
  ...props
}) {
  return (
    <>
      <color attach="background" args={[background]} />
      <group
        matrixAutoUpdate={false}
        onUpdate={(self) => (self.matrix = matrix)}
        {...props}
      >
        <SolarSystem
          store={useStore}
          earthCamera={earthCamera}
          moonCamera={moonCamera}
          interactive={interactive}
          {...props}
        />
        {children}
      </group>
    </>
  )
}

function MainCamera() {
  // return  <PerspectiveCamera makeDefault position={[0, 50, 80]} far={200000} />
  return (
    <OrthographicCamera
      makeDefault
      position={[100, 80, 80]}
      zoom={3}
      near={0}
    />
  )
}

function PanelCamera({ which }) {
  const { earth, moon } = useStore()
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

const Panel = forwardRef(({ gridArea, children, ...props }, fref) => {
  return (
    <div ref={fref} className="panel" style={{ gridArea }}>
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
})
