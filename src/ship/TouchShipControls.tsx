import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { glassPanel } from '../glass-styles'
import { shipInput, throttlePercent } from './ship-input'
import {
  bindSteer,
  bindThrottle,
  blockPagePinch,
  releaseOnInterruption,
  type StickListener,
} from './touch-controls'
import {
  BLUE_BAND,
  REVERSE_DETENT_MS,
  STICK_RADIUS_PX,
  throttleToTrack,
} from './touch-stick'

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
 * Touch ship controls (tides-3bl.4, tides-2hv.3): a floating steer stick on
 * the left, and on the right a spring-return throttle stick (up/down moves
 * the throttle, sideways rolls) with the throttle readout above it. Writes
 * only shipInput; mounted in ShipView's overlay.
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
  const throttleCluster = useRef<HTMLDivElement>(null)
  const throttleBase = useRef<HTMLDivElement>(null)
  const throttleKnob = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const dwell = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = root.current!
    const base = stickBase.current!
    const knob = stickKnob.current!
    const cluster = throttleCluster.current!
    const throttleBaseEl = throttleBase.current!
    const throttleKnobEl = throttleKnob.current!
    const labelEl = label.current!
    const thumbEl = thumb.current!
    const dwellEl = dwell.current!

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

    // The throttle stick's base stays put, so its readout never moves; the
    // knob shows the thumb's offset from where it pressed, and springs back.
    const onThrottleStick: StickListener = (stick) => {
      if (!stick) {
        delete cluster.dataset.active
        throttleKnobEl.style.transform = ''
        return
      }
      cluster.dataset.active = ''
      const dx = stick.knob.x - stick.origin.x
      const dy = stick.knob.y - stick.origin.y
      throttleKnobEl.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`
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
    // A tap to zero flashes the readout, so the cut reads at a glance.
    let flashTimer: ReturnType<typeof setTimeout> | undefined
    const onTap = () => {
      cluster.dataset.flash = ''
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => delete cluster.dataset.flash, FLASH_MS)
    }
    const throttle = bindThrottle(throttleZone.current!, shipInput, {
      base: () => {
        const r = throttleBaseEl.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      onStick: onThrottleStick,
      onTap,
    })
    const bindings = [steer, throttle]
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

    // The throttle also changes from the keyboard on hybrids, so the
    // readout follows shipInput rather than the touches.
    let shown = { throttle: NaN, dwell: NaN }
    let last: number | null = null
    let frame = requestAnimationFrame(function draw(now) {
      const dt = last == null ? 0 : (now - last) / 1000
      last = now
      throttle.step(dt)
      steer.reassert()
      const value = shipInput.throttle
      if (value !== shown.throttle) {
        thumbEl.style.bottom = `${throttleToTrack(value) * 100}%`
        labelEl.textContent = throttlePercent(value)
        if (value < 0) cluster.dataset.reverse = ''
        else delete cluster.dataset.reverse
      }
      const detent = throttle.detentState()
      const held = Math.min(detent.dwellMs / REVERSE_DETENT_MS, 1)
      if (held !== shown.dwell) {
        dwellEl.style.transform = `scaleX(${held})`
        // Coming down from ahead, the wait leads into reverse.
        if (held > 0) cluster.dataset.dwell = detent.arrivedFrom > 0 ? 'reverse' : 'ahead'
        else delete cluster.dataset.dwell
      }
      shown = { throttle: value, dwell: held }
      frame = requestAnimationFrame(draw)
    })

    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(flashTimer)
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
      {/* Flight Assist lives in the HUD (tides-3bl.5), for touch and desktop
          alike; the HUD reads the throttle out too, for screen readers. */}
      <ThrottleCluster
        ref={throttleCluster}
        aria-hidden
      >
        <ThrottleLabel ref={label}>0%</ThrottleLabel>
        <Track>
          <Reverse />
          <BlueBand />
          <ZeroTick />
          <Thumb ref={thumb}>
            <DwellFill ref={dwell} />
          </Thumb>
        </Track>
        <ThrottleBase ref={throttleBase}>
          <ThrottleKnob ref={throttleKnob} />
        </ThrottleBase>
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
// Both sticks rest this far in from their side of the screen, to their centres.
const STICK_INSET = 88
// Each control's zone, as a share of the overlay's width.
const ZONE_SHARE = 40
// How long the readout lights up after a tap zeroes the throttle, in ms.
const FLASH_MS = 160

// A stick's resting centre in from `side`'s edge: STICK_INSET, pulled in on a
// narrow phone (320 px) so the base never pokes out of its zone, and never
// past the screen edge.
const restInset = (side: 'left' | 'right') => `max(
  calc(var(--dock-inset-${side}) + ${STICK_RADIUS_PX}px),
  min(calc(var(--dock-inset-${side}) + ${STICK_INSET}px), calc(${ZONE_SHARE}% - ${STICK_RADIUS_PX}px))
)`

// Covers the view without taking any presses itself; only the zones do.
// Custom properties stay scoped here.
const Overlay = styled.div`
  --ship-top-reserve: calc(var(--dock-top) + 56px);
  /* The band the sticks rest in: their centres sit halfway up it. */
  --stick-h: min(36vh, 220px);
  /* What covers the bottom of the overlay: Safari's bottom bar when the page
     runs full-bleed behind it (--bars-overlap, index.css), then the home
     indicator. */
  --stick-floor: calc(var(--bars-overlap, 0px) + env(safe-area-inset-bottom));
  /* Centred a third of the way up what's visible, clear of the floor. */
  --stick-bottom: max(
    calc(
      var(--bars-overlap, 0px) + (100% - var(--bars-overlap, 0px)) / 3 - var(--stick-h) / 2
    ),
    calc(var(--stick-floor) + 16px)
  );
  /* [TUNE] The throttle readout's height above the throttle stick. */
  --mini-track-h: 84px;

  @media (orientation: landscape) and (max-height: 500px) {
    --stick-h: min(50vh, 200px);
    --mini-track-h: 56px;
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
  width: ${ZONE_SHARE}%;
  height: min(65%, calc(100% - var(--ship-top-reserve)));
  pointer-events: auto;
  touch-action: none;
`

// The padding is only read back (spawnBounds), to keep the stick off the
// screen's curved corner, Safari's bottom bar and the home indicator.
const SteerZone = styled(Zone)`
  left: 0;
  box-sizing: border-box;
  padding: 0 0 var(--stick-floor) env(safe-area-inset-left);
`

const ThrottleZone = styled(Zone)`
  right: 0;
`

// At rest a faint ring level with the throttle stick; under the thumb while
// held (left/top set inline).
const StickBase = styled.div`
  position: absolute;
  left: ${restInset('left')};
  bottom: calc(var(--stick-bottom) + var(--stick-h) / 2);
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

// The readout stacked on the throttle stick, mirroring the steer stick's
// resting ghost: the base's centre is restInset in from the right, at the
// same height. Nothing here takes presses; ThrottleZone does.
const ThrottleCluster = styled.div`
  position: absolute;
  right: ${restInset('right')};
  bottom: calc(var(--stick-bottom) + var(--stick-h) / 2 - ${STICK_RADIUS_PX}px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(50%);
  pointer-events: none;
`

const ThrottleLabel = styled.span`
  min-width: 4.5em;
  color: rgba(255, 255, 255, 0.85);
  font: 600 12px/1 system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  transition:
    color 400ms ease,
    text-shadow 400ms ease;

  [data-reverse] > & {
    color: ${AMBER};
  }

  /* A colour flash, not motion, so it stays under reduced motion. */
  [data-flash] > & {
    color: #fff;
    text-shadow: 0 0 10px ${BLUE};
    transition: none;
  }
`

const Track = styled.div`
  position: relative;
  width: 10px;
  height: var(--mini-track-h);
  /* Clear of the knob at full push, which pokes half its size past the base. */
  margin-bottom: ${KNOB_SIZE / 2}px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  transition: box-shadow 400ms ease;

  [data-flash] > & {
    box-shadow: 0 0 10px ${BLUE};
    transition: none;
  }
`

const Reverse = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: ${ZERO * 100}%;
  border-radius: 0 0 4px 4px;
  background: ${AMBER};
  opacity: 0.65;

  [data-reverse] & {
    opacity: 1;
  }
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
  left: -6px;
  right: -6px;
  bottom: ${ZERO * 100}%;
  height: 2px;
  transform: translateY(50%);
  background: rgba(255, 255, 255, 0.7);
`

// While a pull waits at the zero detent the thumb sits on 0, so it carries
// the wait: it grows, and a fill sweeps across it (amber on the way into
// reverse, blue on the way out) to show how long until the stick carries on
// through. A static fill, so there's no pulse to tone down for reduced motion.
const Thumb = styled.div`
  position: absolute;
  left: 50%;
  width: 22px;
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
  transform: translate(-50%, 50%);

  [data-reverse] & {
    background: ${AMBER};
  }

  [data-dwell] & {
    width: 30px;
    height: 12px;
    border-radius: 6px;
  }
`

const DwellFill = styled.div`
  height: 100%;
  background: ${BLUE};
  transform: scaleX(0);
  transform-origin: left;

  [data-dwell='reverse'] & {
    background: ${AMBER};
  }
`

// A ghost like the steer stick's at rest, firmer while held, and lit in the
// dwell fill's colour while a pull waits at the zero detent.
const ThrottleBase = styled.div`
  position: relative;
  width: ${STICK_RADIUS_PX * 2}px;
  height: ${STICK_RADIUS_PX * 2}px;
  box-sizing: border-box;
  border: 1.5px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.03);
  opacity: 0.6;
  transition: opacity 150ms ease;

  [data-active] > & {
    opacity: 1;
    transition: none;
  }

  [data-dwell] > & {
    border-color: ${BLUE};
    box-shadow: 0 0 12px rgba(76, 159, 254, 0.45);
  }

  [data-dwell='reverse'] > & {
    border-color: ${AMBER};
    box-shadow: 0 0 12px rgba(255, 166, 48, 0.45);
  }
`

// Springs back to centre on release; the ease is off for reduced motion.
const ThrottleKnob = styled.div`
  ${glassPanel}
  position: absolute;
  left: 50%;
  top: 50%;
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.22);
  transform: translate(-50%, -50%);
  transition: transform 120ms ease-out;

  [data-active] & {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`
