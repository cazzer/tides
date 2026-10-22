import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { glassPanel } from '../glass-styles'
import { shipInput } from './ship-input'
import {
  bindLevel,
  bindSteer,
  bindThrottle,
  blockPagePinch,
  releaseOnInterruption,
  type StickListener,
} from './touch-controls'
import { BLUE_BAND, STICK_RADIUS_PX, throttleToTrack } from './touch-stick'

const COARSE = '(pointer: coarse)'

// Shown on touch-first devices, and on a hybrid from its first touch.
function useTouchControlsVisible() {
  const [visible, setVisible] = useState(() => window.matchMedia(COARSE).matches)
  useEffect(() => {
    if (visible) return
    const query = window.matchMedia(COARSE)
    const onChange = () => {
      if (query.matches) setVisible(true)
    }
    // Capture, as the controls and the scene stop some presses on the way.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') setVisible(true)
    }
    query.addEventListener('change', onChange)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      query.removeEventListener('change', onChange)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [visible])
  return visible
}

/**
 * Touch ship controls (tides-3bl.4): a floating steer stick on the left, a
 * throttle/roll pad on the right with a hold-to-level button above its
 * track. Writes only shipInput; mounted in ShipView's overlay.
 */
export function TouchShipControls() {
  return useTouchControlsVisible() ? <Controls /> : null
}

const preventDefault = (event: Event) => event.preventDefault()

function Controls() {
  const root = useRef<HTMLDivElement>(null)
  const steerZone = useRef<HTMLDivElement>(null)
  const throttleZone = useRef<HTMLDivElement>(null)
  const stickBase = useRef<HTMLDivElement>(null)
  const stickKnob = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const levelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const overlay = root.current!
    const base = stickBase.current!
    const knob = stickKnob.current!
    const trackEl = track.current!
    const thumbEl = thumb.current!
    const level = levelButton.current!

    // The stick's base jumps to the thumb, in the overlay's coordinates
    // (measured once per press), and goes back to its resting ghost after.
    let rect: DOMRect | null = null
    const onStick: StickListener = (stick) => {
      if (!stick) {
        rect = null
        delete base.dataset.active
        base.style.left = ''
        base.style.top = ''
        knob.style.transform = ''
        return
      }
      rect ??= overlay.getBoundingClientRect()
      base.dataset.active = ''
      base.style.left = `${stick.origin.x - rect.left}px`
      base.style.top = `${stick.origin.y - rect.top}px`
      const dx = stick.knob.x - stick.origin.x
      const dy = stick.knob.y - stick.origin.y
      knob.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`
    }

    // The base stays a stick's reach (plus the safe area, which the zone
    // carries as padding) clear of the zone's left and bottom edges.
    const steerEl = steerZone.current!
    const spawnBounds = () => {
      const zone = steerEl.getBoundingClientRect()
      const style = getComputedStyle(steerEl)
      return {
        minX: zone.left + parseFloat(style.paddingLeft) + STICK_RADIUS_PX + SPAWN_MARGIN,
        maxY: zone.bottom - parseFloat(style.paddingBottom) - STICK_RADIUS_PX - SPAWN_MARGIN,
      }
    }

    const steer = bindSteer(steerEl, shipInput, { onStick, spawnBounds })
    const bindings = [
      steer,
      bindThrottle(throttleZone.current!, shipInput, () => trackEl.clientHeight),
      bindLevel(level, shipInput),
    ]
    const releaseAll = () => bindings.forEach((binding) => binding.release())
    const stopInterruptions = releaseOnInterruption(
      { win: window, doc: document, orientation: screen.orientation ?? null },
      releaseAll
    )
    const unblockPinch = blockPagePinch(document)

    // Belt and braces for iOS: no page scroll or long-press menu from the
    // controls.
    const blocked = ['touchmove', 'contextmenu']
    for (const type of blocked) overlay.addEventListener(type, preventDefault, { passive: false })

    // The throttle and level also change from the keyboard on hybrids, so
    // the display follows shipInput rather than the touches.
    let shown = { throttle: NaN, roll: NaN, level: false }
    let frame = requestAnimationFrame(function draw() {
      steer.reassert()
      const { throttle, roll, level: levelling } = shipInput
      if (throttle !== shown.throttle || roll !== shown.roll) {
        thumbEl.style.bottom = `${throttleToTrack(throttle) * 100}%`
        thumbEl.style.transform = `translate(calc(-50% + ${roll * 10}px), 50%)`
      }
      if (levelling !== shown.level) {
        if (levelling) level.dataset.active = ''
        else delete level.dataset.active
      }
      shown = { throttle, roll, level: levelling }
      frame = requestAnimationFrame(draw)
    })

    return () => {
      cancelAnimationFrame(frame)
      for (const type of blocked) overlay.removeEventListener(type, preventDefault)
      unblockPinch()
      stopInterruptions()
      bindings.forEach((binding) => binding.dispose())
    }
  }, [])

  return (
    <Overlay ref={root}>
      <SteerZone
        ref={steerZone}
        aria-hidden
      />
      <ThrottleZone
        ref={throttleZone}
        aria-hidden
      />
      <StickBase
        ref={stickBase}
        aria-hidden
      >
        <StickKnob ref={stickKnob} />
      </StickBase>
      <ThrottleCluster>
        {/* Above the track, out of the thumb's way. Flight Assist lives in
            the HUD (tides-3bl.5), for touch and desktop alike. */}
        <LevelButton
          ref={levelButton}
          type="button"
          aria-label="Level, hold"
          title="Hold to level"
        >
          LEVEL
          <Sublabel>HOLD</Sublabel>
        </LevelButton>
        <Track
          ref={track}
          aria-hidden
        >
          <Reverse />
          <BlueBand />
          <ZeroTick />
          <Thumb ref={thumb} />
        </Track>
      </ThrottleCluster>
    </Overlay>
  )
}

const BLUE = '#4c9ffe'
const AMBER = '#ffa630'
const ZERO = throttleToTrack(0)
const KNOB_SIZE = 52
// Extra room past full deflection between a spawned stick and the zone's edge.
const SPAWN_MARGIN = 8

// Covers the view without taking any presses itself; only the pads and
// buttons do. Custom properties stay scoped here.
const Overlay = styled.div`
  --ship-top-reserve: calc(var(--dock-top) + 56px);
  --track-h: min(36vh, 220px);
  /* Track centred a third of the way up, clear of the home indicator. */
  --track-bottom: max(
    calc(100% / 3 - var(--track-h) / 2),
    calc(env(safe-area-inset-bottom) + 16px)
  );

  @media (orientation: landscape) and (max-height: 500px) {
    --track-h: min(50vh, 200px);
  }

  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
`

// The lower 40% corners, never reaching up into the HUD strip; the middle
// 20% stays free for the reticle and target taps.
const Zone = styled.div`
  position: absolute;
  bottom: 0;
  width: 40%;
  height: min(65%, calc(100% - var(--ship-top-reserve)));
  pointer-events: auto;
  touch-action: none;
`

// The safe-area padding is only read back (spawnBounds), to keep the stick
// off the screen's curved corner and home indicator.
const SteerZone = styled(Zone)`
  left: 0;
  box-sizing: border-box;
  padding: 0 0 env(safe-area-inset-bottom) env(safe-area-inset-left);
`

const ThrottleZone = styled(Zone)`
  right: 0;
`

// At rest a faint ring level with the throttle track; under the thumb while
// held (left/top set inline).
const StickBase = styled.div`
  position: absolute;
  left: calc(var(--dock-inset-left) + 88px);
  bottom: calc(var(--track-bottom) + var(--track-h) / 2);
  width: ${STICK_RADIUS_PX * 2}px;
  height: ${STICK_RADIUS_PX * 2}px;
  border: 1.5px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.03);
  transform: translate(-50%, 50%);
  opacity: 0.45;
  pointer-events: none;
  transition: opacity 150ms ease;

  &[data-active] {
    bottom: auto;
    transform: translate(-50%, -50%);
    opacity: 1;
    transition: none;
  }
`

const StickKnob = styled.div`
  ${glassPanel}
  position: absolute;
  left: 50%;
  top: 50%;
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  border-radius: 50%;
  /* Lighter than the glass panels, to read against black space. */
  background-color: rgba(255, 255, 255, 0.22);
  transform: translate(-50%, -50%);
`

// LEVEL sits above the track, right-aligned with it.
const ThrottleCluster = styled.div`
  position: absolute;
  right: calc(var(--dock-inset-right) + 32px);
  bottom: var(--track-bottom);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 20px;
  pointer-events: none;
`

// A glass pill with a tap target of at least 48px.
const LevelButton = styled.button`
  ${glassPanel}
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 72px;
  min-height: 32px;
  padding: 6px 12px;
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.78);
  font: 600 12px/1 system-ui, sans-serif;
  letter-spacing: 0.06em;
  cursor: pointer;
  pointer-events: auto;
  touch-action: none;

  &::before {
    content: '';
    position: absolute;
    inset: -8px -4px;
  }

  &[data-active] {
    color: #fff;
    border-color: ${BLUE};
  }

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 3px;
  }
`

const Sublabel = styled.span`
  font-size: 9px;
  letter-spacing: 0.12em;
  opacity: 0.6;
`

const Track = styled.div`
  position: relative;
  width: 14px;
  height: var(--track-h);
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.07);
`

const Reverse = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: ${ZERO * 100}%;
  border-radius: 0 0 6px 6px;
  background: ${AMBER};
  opacity: 0.65;
`

const BlueBand = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: ${BLUE_BAND[0] * 100}%;
  height: ${(BLUE_BAND[1] - BLUE_BAND[0]) * 100}%;
  background: ${BLUE};
  opacity: 0.55;
`

const ZeroTick = styled.div`
  position: absolute;
  left: -5px;
  right: -5px;
  bottom: ${ZERO * 100}%;
  height: 2px;
  transform: translateY(50%);
  background: rgba(255, 255, 255, 0.7);
`

const Thumb = styled.div`
  position: absolute;
  left: 50%;
  width: 30px;
  height: 14px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
`
