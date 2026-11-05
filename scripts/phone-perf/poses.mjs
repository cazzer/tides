// The standard poses (tides-0oi.1). Each has URL params and an in-page step
// that runs after the app has rendered; `settleMs` is the wait before timing
// and `beforeSample` (optional) runs right before the timing window.
//
// Time is pinned to 2026-03-20 19:00 UTC (equinox, local noon at the Grand
// Canyon) with static weather, so runs see the same sky and no forecast
// fetches. Ship and close-zoom poses also run at quality=high in the default
// pose set: only that tier streams surface tiles, and on the low tier (the
// phone's auto tier) the ship parks on the shell floor, so 'sea' and 'land'
// differ only at high.

export const COMMON_PARAMS = { t: '2026-03-20T19:00:00Z', weather: 'static' }

// The main camera held over lat/lon at km above sea level, looking down
// (tilt: degrees from straight down toward north). Same math as the
// perf-audit harness's poseMain: Earth's ground mesh is the first Phong mesh
// under the Earth group.
function mainPose(pose) {
  return `(() => {
    const pose = ${JSON.stringify(pose)}
    const { THREE: T, store } = window.__ppProbe
    const d = Math.PI / 180
    window.__mainPose = (camera) => {
      const earth = store.getState().earth?.current
      if (!earth) return
      let ground = null
      earth.traverse((o) => { if (!ground && o.isMesh && o.material?.isMeshPhongMaterial) ground = o })
      if (!ground) return
      ground.updateWorldMatrix(true, false)
      const c = new T.Vector3().setFromMatrixPosition(ground.matrixWorld)
      if (!ground.geometry.boundingSphere) ground.geometry.computeBoundingSphere()
      const s = new T.Vector3(); ground.getWorldScale(s)
      const R = ground.geometry.boundingSphere.radius * s.x
      const la = pose.lat * d, lo = pose.lon * d
      const up = new T.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).transformDirection(ground.matrixWorld)
      const pos = c.clone().addScaledVector(up, R + (pose.km * R) / 6371)
      camera.position.copy(pos)
      const north = new T.Vector3(0, 1, 0).transformDirection(ground.matrixWorld)
      const look = c.clone()
      if (pose.tilt) {
        const east = north.clone().cross(up).normalize()
        const n2 = up.clone().cross(east).normalize()
        look.copy(pos).addScaledVector(up, -Math.cos(pose.tilt * d)).addScaledVector(n2, Math.sin(pose.tilt * d))
      }
      camera.up.copy(north)
      camera.lookAt(look)
      camera.updateMatrixWorld()
    }
    return true
  })()`
}

// The ship held over lat/lon at km above sea level, at rest, heading degrees
// from east toward north and pitch degrees up (the perf-audit harness's
// setShipPose). On the low tier the collision floor lifts it to the shells.
function shipPose(pose) {
  return `(() => {
    const p = ${JSON.stringify(pose)}
    const { THREE: T } = window.__ppProbe
    const d = Math.PI / 180
    window.__shipPose = (state, earth) => {
      if (!earth) return
      const la = p.lat * d, lo = p.lon * d
      const up = new T.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(earth.spin)
      const north0 = new T.Vector3(0, 1, 0).applyQuaternion(earth.spin)
      const east = north0.clone().cross(up).normalize()
      const north = up.clone().cross(east).normalize()
      state.position.copy(earth.position).addScaledVector(up, earth.radius + (p.km * earth.radius) / 6371)
      state.velocity.set(0, 0, 0); state.angularVelocity.set(0, 0, 0)
      const h = (p.heading || 0) * d, pi = (p.pitch || 0) * d
      const flat = east.clone().multiplyScalar(Math.cos(h)).addScaledVector(north, Math.sin(h))
      const fwd = flat.multiplyScalar(Math.cos(pi)).addScaledVector(up, Math.sin(pi)).normalize()
      const camUp = up.clone().addScaledVector(fwd, -up.dot(fwd)).normalize()
      const right = fwd.clone().cross(camUp).normalize()
      state.orientation.setFromRotationMatrix(new T.Matrix4().makeBasis(right, camUp, fwd.clone().negate()))
    }
    return true
  })()`
}

// A demo entered at a step. Calling goToDemoStep twice cuts a travel straight
// to the step's date (demo-session.ts); replayDemoStep restarts the step's
// clock just before timing, so every run times the same stretch.
function demoStep(id, step) {
  return `(() => {
    const s = window.__ppProbe.store.getState()
    if (s.demo?.id !== ${JSON.stringify(id)}) s.startDemo(${JSON.stringify(id)})
    const after = window.__ppProbe.store.getState()
    if (after.demo?.id !== ${JSON.stringify(id)}) throw new Error('startDemo(${id}) did not start the demo')
    after.goToDemoStep(${step})
    window.__ppProbe.store.getState().goToDemoStep(${step})
    return true
  })()`
}
const replayStep = `(() => { window.__ppProbe.store.getState().replayDemoStep(); return true })()`

export const POSES = [
  {
    id: 'system',
    label: 'System view, default',
    params: {},
    // The first load plays the opening move (opening.ts, 3.6 s after the
    // loader fades); wait it out instead of emulating reduced motion, which
    // changes what the app draws.
    settleMs: 8000,
  },
  {
    id: 'earth-100km',
    label: 'Earth close zoom, 100 km',
    params: { focus: 'earth' },
    setup: mainPose({ lat: 36.1, lon: -112.1, km: 100, tilt: 30 }),
    // Streamed tiles take 15-20 s to load at low altitude.
    settleMs: 22000,
    tiers: ['auto', 'high'],
  },
  {
    id: 'ship-sea',
    label: 'Ship low over sea (Pacific, 3 km)',
    params: { ship: '1' },
    setup: shipPose({ lat: 20, lon: -130, km: 3, heading: 0, pitch: -8 }),
    settleMs: 22000,
    tiers: ['auto', 'high'],
  },
  {
    id: 'ship-land',
    label: 'Ship over land (Grand Canyon, 4 km)',
    params: { ship: '1' },
    setup: shipPose({ lat: 36.1, lon: -112.1, km: 4, heading: 90, pitch: -10 }),
    settleMs: 22000,
    tiers: ['auto', 'high'],
  },
  {
    // Asked for by the perf-audit stream: at phone size on desktop the aurora
    // alone took 13-14.5 ms of a 17-19 ms frame. Northern Scandinavia at
    // 19:00 UTC on the equinox is night, under the oval (static weather = the
    // default Kp), looking north across it.
    id: 'aurora-night',
    label: 'Night close zoom over the auroral oval (68N 20E, 300 km, looking north)',
    params: { focus: 'earth' },
    setup: mainPose({ lat: 66, lon: 20, km: 300, tilt: 70 }),
    settleMs: 15000,
    tiers: ['auto', 'high'],
  },
  {
    id: 'seasons',
    label: 'Seasons tour, step 1 (June solstice)',
    params: {},
    setup: demoStep('seasons', 1),
    settleMs: 6000,
    beforeSample: replayStep,
  },
  {
    id: 'solar-eclipse',
    label: 'Solar eclipse tour, step 0',
    params: {},
    setup: demoStep('solar-eclipse', 0),
    settleMs: 6000,
    beforeSample: replayStep,
  },
]

// One measurement per (pose, tier), in a stable order.
export function expandPoses(poses, { tiers: forcedTiers, only } = {}) {
  const wanted = only?.length ? poses.filter((p) => only.includes(p.id)) : poses
  if (only?.length && wanted.length !== only.length) {
    const known = poses.map((p) => p.id).join(', ')
    throw new Error(`Unknown pose in POSES=${only.join(',')} (known: ${known})`)
  }
  return wanted.flatMap((pose) =>
    (forcedTiers ?? pose.tiers ?? ['auto']).map((tier) => ({
      ...pose,
      tier,
      key: tier === 'auto' ? pose.id : `${pose.id}@${tier}`,
    }))
  )
}

// Rotates the order each round, so no pose always runs first (cold) or last
// (hottest phone).
export function roundOrder(items, round) {
  const n = items.length
  return items.map((_, i) => items[(i + round) % n])
}

export function poseUrl(base, pose) {
  const params = new URLSearchParams({ ...COMMON_PARAMS, ...pose.params })
  if (pose.tier !== 'auto') params.set('quality', pose.tier)
  return `${base}?${params}`
}
