import { useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { IconChevronRight, IconQuestionMark, IconX } from '@tabler/icons-react'
import { glassButton, glassFloatingButton, glassPanel, PHONE } from '../glass-styles'
import { BLUE_ZONE, speedFraction, turnRateMultiplier } from './flight'
import { shipInput, THROTTLE_MAX, THROTTLE_MIN } from './ship-input'
import { getShipTarget, setShipTarget, shipTelemetry } from './ship-telemetry'
import { bodyName, formatDistance, formatEta, formatSpeed } from './ship-distances'
import { shipNav, targetMarker } from './ship-targeting'
import { ShipControlsDialog } from './ShipControlsDialog'

// Text redraws this often; the throttle bar follows every frame. Faster text
// is unreadable and flickers in the last digit.
const TEXT_INTERVAL_MS = 100

// The wide-turn cue (speed label, dimmed fill past the blue zone) comes on
// once the turn rate drops below this share of full (flight.ts
// turnRateMultiplier) and goes off once it is back above WIDE_TURN_OFF. The
// gap keeps a speed settling at the band's top from flickering the cue or
// repeating its announcement.
const WIDE_TURN_ON = 0.99
const WIDE_TURN_OFF = 0.995

const SEEN_KEY = 'tides.shipControlsSeen'

function controlsSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function rememberControlsSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Private mode or blocked storage: the dialog shows again next entry.
  }
}

// Throttle −0.25..1 along the bar, as a share of its width.
const SPAN = THROTTLE_MAX - THROTTLE_MIN
const ZERO_AT = -THROTTLE_MIN / SPAN
const at = (throttle: number) => `${((throttle - THROTTLE_MIN) / SPAN) * 100}%`

function percent(throttle: number): string {
  const value = Math.round(throttle * 100)
  return value < 0 ? `−${-value}%` : `${value}%`
}

interface Readouts {
  speed: HTMLElement | null
  wideTurn: HTMLElement | null
  bar: HTMLElement | null
  throttle: HTMLElement | null
  forward: HTMLElement | null
  reverse: HTMLElement | null
  assist: HTMLButtonElement | null
  assistValue: HTMLElement | null
  nearest: HTMLElement | null
  targetCell: HTMLElement | null
  target: HTMLElement | null
  markerLabel: HTMLElement | null
  announcer: HTMLElement | null
}

/**
 * Ship mode's heads-up display (tides-3bl.5): speed, throttle, Flight Assist,
 * nearest body and target, in a strip along the top; the target marker; a
 * '?' that reopens the controls dialog, which also opens on the first entry
 * of a session. Values are written straight to the DOM from one rAF loop
 * (shipTelemetry, shipInput and ShipTargeting's shipNav), never through React
 * state. Distances are true km/AU and speed is km/s or c; see
 * ship-distances.ts for how they come from the compressed scene.
 */
export function ShipHud() {
  const [controlsOpen, setControlsOpen] = useState(false)
  const readouts = useRef<Readouts>({
    speed: null,
    wideTurn: null,
    bar: null,
    throttle: null,
    forward: null,
    reverse: null,
    assist: null,
    assistValue: null,
    nearest: null,
    targetCell: null,
    target: null,
    markerLabel: null,
    announcer: null,
  })

  // Opened a task after mount, once ShipView has moved focus to its exit
  // button: that is where the dialog returns it on close.
  useEffect(() => {
    if (controlsSeen()) return
    const timer = setTimeout(() => setControlsOpen(true))
    return () => clearTimeout(timer)
  }, [])

  const closeControls = useCallback(() => {
    rememberControlsSeen()
    setControlsOpen(false)
  }, [])

  useEffect(() => {
    const r = readouts.current
    let frame = 0
    let textAt = -Infinity
    let throttleShown = NaN
    let targetShown: string | null | undefined
    let assistShown: boolean | undefined
    let wideShown: boolean | undefined

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const throttle = shipTelemetry.throttle
      if (throttle !== throttleShown && r.forward && r.reverse) {
        throttleShown = throttle
        r.forward.style.transform = `scaleX(${Math.max(0, throttle) / THROTTLE_MAX})`
        r.reverse.style.transform = `scaleX(${Math.max(0, -throttle) / -THROTTLE_MIN})`
      }
      if (now - textAt < TEXT_INTERVAL_MS) return
      textAt = now

      set(r.speed, formatSpeed(shipTelemetry.speed * shipNav.kmPerUnit))
      set(r.throttle, percent(throttle))
      // From speed, as the flight model does: with FA off a ship coasting
      // fast turns wide whatever the throttle says.
      const fraction = speedFraction(shipTelemetry.speed, shipTelemetry.speedCap)
      const turn = turnRateMultiplier(fraction)
      const wide = wideShown ? turn < WIDE_TURN_OFF : turn < WIDE_TURN_ON
      if (wide !== wideShown) {
        // Nothing to announce on the first pass, as for the target.
        if (wideShown !== undefined) {
          set(r.announcer, wide ? 'Turn rate reduced at high speed' : 'Full turn rate')
        }
        wideShown = wide
        r.bar?.toggleAttribute('data-wide-turn', wide)
        if (r.wideTurn) r.wideTurn.hidden = !wide
      }
      const assist = shipInput.flightAssist
      if (assist !== assistShown && r.assist) {
        assistShown = assist
        r.assist.setAttribute('aria-pressed', String(assist))
        set(r.assistValue, assist ? 'On' : 'Off')
      }
      const nearest = shipNav.nearestKey
      set(r.nearest, nearest ? `${bodyName(nearest)} · ${formatDistance(shipNav.nearestKm)}` : '—')

      const target = getShipTarget()
      if (target !== targetShown) {
        // An announcement on the first pass would only repeat the default.
        if (targetShown !== undefined) {
          set(r.announcer, target ? `Target locked: ${bodyName(target)}` : 'Target cleared')
        }
        targetShown = target
        if (r.targetCell) r.targetCell.hidden = !target
        set(r.markerLabel, target ? bodyName(target) : '')
      }
      if (target) {
        const eta = shipTelemetry.target?.etaSeconds ?? Infinity
        const range = `${bodyName(target)} · ${formatDistance(shipNav.targetKm)}`
        // No ETA while not closing on it.
        set(r.target, Number.isFinite(eta) ? `${range} · ETA ${formatEta(eta)}` : range)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  // The marker's frame loop needs the view's size and the strip's bottom
  // edge; reading layout every frame would force a reflow each time.
  const markerLayer = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const layer = markerLayer.current
    const hud = strip.current
    if (!layer || !hud) return
    const measure = () => {
      targetMarker.width = layer.clientWidth
      targetMarker.height = layer.clientHeight
      targetMarker.hudBottom = hud.offsetTop + hud.offsetHeight
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(layer)
    observer.observe(hud)
    return () => observer.disconnect()
  }, [])

  const toggleAssist = () => {
    shipInput.flightAssist = !shipInput.flightAssist
    const r = readouts.current
    r.assist?.setAttribute('aria-pressed', String(shipInput.flightAssist))
    set(r.assistValue, shipInput.flightAssist ? 'On' : 'Off')
  }

  const bind = <K extends keyof Readouts>(key: K) =>
    (element: Readouts[K]) => {
      readouts.current[key] = element
    }

  return (
    <>
      <MarkerLayer
        ref={markerLayer}
        aria-hidden
      >
        <Marker
          ref={(element) => {
            targetMarker.current = element
            return () => {
              targetMarker.current = null
            }
          }}
          hidden
        >
          <MarkerLabel ref={bind('markerLabel')} />
          <EdgeArrow
            size={28}
            stroke={2.5}
          />
        </Marker>
      </MarkerLayer>
      <HelpButton
        type="button"
        onClick={() => setControlsOpen(true)}
        // A held Enter would repeat into the dialog it opens and press its
        // button, closing it again.
        onKeyDown={(event) => {
          if (event.repeat) event.preventDefault()
        }}
        aria-label="Show ship controls"
        aria-haspopup="dialog"
        title="Controls"
      >
        <IconQuestionMark
          size={20}
          stroke={1.75}
        />
      </HelpButton>
      <Strip
        ref={strip}
        role="group"
        aria-label="Flight instruments"
        data-ship-ui
      >
        <Row>
          <Cell>
            <Label>
              Speed
              <span
                ref={bind('wideTurn')}
                hidden
              >
                {' · wide turns'}
              </span>
            </Label>
            <Value ref={bind('speed')}>—</Value>
          </Cell>
          <Cell $grow>
            <Label>
              Throttle <span ref={bind('throttle')}>0%</span>
            </Label>
            <Bar
              ref={bind('bar')}
              aria-hidden
            >
              <BlueZone />
              <ZeroMark />
              <Reverse ref={bind('reverse')} />
              <Forward ref={bind('forward')} />
              <PastBand />
            </Bar>
          </Cell>
          <AssistButton
            ref={bind('assist')}
            type="button"
            onClick={toggleAssist}
            aria-pressed="true"
            title="Flight assist (Z)"
          >
            <Switch aria-hidden />
            <AssistText>
              <Label as="span">Flight assist</Label>
              <Value
                as="span"
                ref={bind('assistValue')}
              >
                On
              </Value>
            </AssistText>
          </AssistButton>
        </Row>
        <Row>
          <Cell $grow>
            <Label>Nearest</Label>
            <Value ref={bind('nearest')}>—</Value>
          </Cell>
          <Cell
            ref={bind('targetCell')}
            $grow
            hidden
          >
            <Label>Target</Label>
            <TargetLine>
              <Value ref={bind('target')} />
              <ClearButton
                type="button"
                onClick={() => setShipTarget(null)}
                aria-label="Clear target"
                title="Clear target"
              >
                <IconX
                  size={14}
                  stroke={2}
                />
              </ClearButton>
            </TargetLine>
          </Cell>
        </Row>
      </Strip>
      <VisuallyHidden
        ref={bind('announcer')}
        role="status"
      />
      <ShipControlsDialog
        open={controlsOpen}
        onClose={closeControls}
      />
    </>
  )
}

function set(element: HTMLElement | null, text: string) {
  if (element && element.textContent !== text) element.textContent = text
}

// As ShipView's exit button, which sits at the top-left at this inset.
const EXIT_INSET = 'calc((var(--dock-height) - var(--dock-button-size, 40px)) / 2)'
const TOP = `calc(var(--dock-top) + ${EXIT_INSET})`
const LEFT = `calc(var(--dock-inset-left) + ${EXIT_INSET})`
const BUTTON = 'var(--dock-button-size, 40px)'
const GAP = '8px'
// The texture credit owns the top-right corner (index.css).
const CREDIT_ROOM = '270px'

const HelpButton = styled.button`
  ${glassFloatingButton}
  position: absolute;
  top: ${TOP};
  left: calc(${LEFT} + ${BUTTON} + ${GAP});
  z-index: 1;
`

// Right of the exit and help buttons on a wide screen; on a phone the credit
// leaves no room up there, so it takes a full-width row under them.
const Strip = styled.div`
  ${glassPanel}
  position: absolute;
  top: ${TOP};
  left: calc(${LEFT} + 2 * (${BUTTON} + ${GAP}));
  max-width: calc(100% - (${LEFT} + 2 * (${BUTTON} + ${GAP})) - ${CREDIT_ROOM});
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  min-height: ${BUTTON};
  padding: 4px 6px 4px 14px;
  border-radius: 20px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;

  ${PHONE} {
    top: calc(${TOP} + ${BUTTON} + ${GAP});
    left: ${LEFT};
    right: calc(var(--dock-inset-right) + ${EXIT_INSET});
    max-width: none;
    flex-direction: column;
    gap: 4px;
    padding: 6px 6px 6px 12px;
    border-radius: 16px;
  }
`

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;

  ${PHONE} {
    gap: 12px;
  }
`

const Cell = styled.div<{ $grow?: boolean }>`
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  flex: ${(p) => (p.$grow ? '1 1 auto' : '0 0 auto')};

  &[hidden] {
    display: none;
  }
`

const Label = styled.div`
  font-size: 11px;
  line-height: 14px;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
`

const Value = styled.div`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const TargetLine = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  color: #8fd8ff;
`

const Bar = styled.div`
  position: relative;
  width: 100%;
  min-width: 72px;
  max-width: 120px;
  height: 6px;
  margin: 5px 0 4px;
  background-color: rgba(255, 255, 255, 0.12);
  border-radius: 3px;
  overflow: hidden;

  ${PHONE} {
    max-width: none;
  }
`

// BLUE_ZONE is a share of the speed cap, drawn on the throttle: with FA on the
// speed settles to throttle · cap, so the throttle that holds the ship in the
// band is the band. When the speed is past it (data-wide-turn), PastBand dims
// the fill beyond the band's top.
const BlueZone = styled.div`
  position: absolute;
  inset: 0 auto 0 ${at(BLUE_ZONE[0])};
  width: calc(${at(BLUE_ZONE[1])} - ${at(BLUE_ZONE[0])});
  background-color: rgba(76, 159, 254, 0.35);
`

const ZeroMark = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: ${ZERO_AT * 100}%;
  width: 1px;
  background-color: rgba(255, 255, 255, 0.5);
`

const Forward = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: ${ZERO_AT * 100}%;
  right: 0;
  background-color: rgba(255, 255, 255, 0.85);
  transform: scaleX(0);
  transform-origin: left;
`

// Over Forward from the blue zone's top to the end; shown with the wide-turn
// cue. Dimming, not a colour: amber already means reverse and FA off.
const PastBand = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: ${at(BLUE_ZONE[1])};
  right: 0;
  background-color: rgba(0, 0, 0, 0.55);
  display: none;

  [data-wide-turn] > & {
    display: block;
  }
`

// Reverse thrust grows leftward from zero, in amber.
const Reverse = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: ${ZERO_AT * 100}%;
  background-color: #f0a640;
  transform: scaleX(0);
  transform-origin: right;
`

// A pill with a switch, so it reads as something to tap; off is amber all
// over, not just in its text.
const AMBER = '#f0a640'
const AssistButton = styled.button`
  ${glassButton}
  width: auto;
  height: auto;
  min-height: 34px;
  gap: 8px;
  padding: 2px 10px 2px 8px;
  margin-left: auto;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 12px;
  background-color: rgba(255, 255, 255, 0.08);
  font: inherit;
  color: rgba(255, 255, 255, 0.92);
  line-height: 16px;
  text-align: left;

  &:hover {
    background-color: rgba(255, 255, 255, 0.16);
  }

  &[aria-pressed='false'] {
    color: ${AMBER};
    border-color: rgba(240, 166, 64, 0.7);
    background-color: rgba(240, 166, 64, 0.14);
  }

  &[aria-pressed='false'] ${Label} {
    color: rgba(240, 166, 64, 0.85);
  }

  /* Touch keeps :hover after a tap. */
  @media (hover: none) {
    &:hover {
      background-color: rgba(255, 255, 255, 0.08);
    }

    &[aria-pressed='false']:hover {
      background-color: rgba(240, 166, 64, 0.14);
    }
  }
`

const AssistText = styled.span`
  display: flex;
  flex-direction: column;
`

const Switch = styled.span`
  position: relative;
  flex-shrink: 0;
  width: 24px;
  height: 14px;
  border-radius: 7px;
  background-color: #4c9ffe;
  transition: background-color 150ms ease;

  &::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 12px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: #fff;
    transition: left 150ms ease;
  }

  [aria-pressed='false'] > & {
    background-color: transparent;
    box-shadow: inset 0 0 0 1.5px ${AMBER};
  }

  [aria-pressed='false'] > &::after {
    left: 2px;
    background-color: ${AMBER};
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;

    &::after {
      transition: none;
    }
  }
`

const ClearButton = styled.button`
  ${glassButton}
  width: 24px;
  height: 24px;
  margin: -4px 0;
  position: relative;

  /* A 40px tap target around the small glyph. */
  &::before {
    content: '';
    position: absolute;
    inset: -8px;
  }
`

const MarkerLayer = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
`

// Corner brackets around the target, sized by ShipTargeting each frame; off
// screen it becomes an arrow on the edge pointing the way to turn.
const BRACKET = 'linear-gradient(currentColor, currentColor)'
const ARM = '10px'
const Marker = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  color: #8fd8ff;
  will-change: transform;

  &[hidden] {
    display: none;
  }

  &[data-mode='bracket'] {
    background:
      ${BRACKET} top left / ${ARM} 2px no-repeat,
      ${BRACKET} top left / 2px ${ARM} no-repeat,
      ${BRACKET} top right / ${ARM} 2px no-repeat,
      ${BRACKET} top right / 2px ${ARM} no-repeat,
      ${BRACKET} bottom left / ${ARM} 2px no-repeat,
      ${BRACKET} bottom left / 2px ${ARM} no-repeat,
      ${BRACKET} bottom right / ${ARM} 2px no-repeat,
      ${BRACKET} bottom right / 2px ${ARM} no-repeat;
    filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.8));
  }

  &[data-mode='edge'] {
    width: 28px;
    height: 28px;
    margin: -14px 0 0 -14px;
  }
`

const MarkerLabel = styled.span`
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
  text-shadow: 0 0 3px #000;

  [data-mode='edge'] > & {
    display: none;
  }
`

const EdgeArrow = styled(IconChevronRight)`
  display: none;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.8));

  [data-mode='edge'] > & {
    display: block;
  }
`

const VisuallyHidden = styled.p`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`
