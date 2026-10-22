import { useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { IconChevronRight, IconQuestionMark, IconX } from '@tabler/icons-react'
import { glassButton, glassFloatingButton, glassPanel, PHONE } from '../glass-styles'
import { BLUE_ZONE } from './flight'
import { shipInput, THROTTLE_MAX, THROTTLE_MIN } from './ship-input'
import { getShipTarget, setShipTarget, shipTelemetry } from './ship-telemetry'
import { bodyName, formatDistance, formatEta, formatSpeed } from './ship-distances'
import { shipNav, targetMarker } from './ship-targeting'
import { ShipControlsDialog } from './ShipControlsDialog'

// Text redraws this often; the throttle bar follows every frame. Faster text
// is unreadable and flickers in the last digit.
const TEXT_INTERVAL_MS = 100

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
  throttle: HTMLElement | null
  forward: HTMLElement | null
  reverse: HTMLElement | null
  assist: HTMLButtonElement | null
  assistValue: HTMLElement | null
  nearest: HTMLElement | null
  targetCell: HTMLElement | null
  target: HTMLElement | null
  eta: HTMLElement | null
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
    throttle: null,
    forward: null,
    reverse: null,
    assist: null,
    assistValue: null,
    nearest: null,
    targetCell: null,
    target: null,
    eta: null,
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
      const assist = shipInput.flightAssist
      if (assist !== assistShown && r.assist) {
        assistShown = assist
        r.assist.setAttribute('aria-pressed', String(assist))
        set(r.assistValue, assist ? 'On' : 'Off')
      }
      const nearest = shipTelemetry.nearest.key
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
        set(r.target, `${bodyName(target)} · ${formatDistance(shipNav.targetKm)}`)
        set(r.eta, formatEta(shipTelemetry.target?.etaSeconds ?? Infinity))
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
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
      <MarkerLayer aria-hidden>
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
        ref={(element) => {
          targetMarker.hud = element
          return () => {
            targetMarker.hud = null
          }
        }}
        role="group"
        aria-label="Flight instruments"
        data-ship-ui
      >
        <Row>
          <Cell>
            <Label>Speed</Label>
            <Value ref={bind('speed')}>—</Value>
          </Cell>
          <Cell $grow>
            <Label>
              Throttle <span ref={bind('throttle')}>0%</span>
            </Label>
            <Bar aria-hidden>
              <BlueZone />
              <ZeroMark />
              <Reverse ref={bind('reverse')} />
              <Forward ref={bind('forward')} />
            </Bar>
          </Cell>
          <AssistButton
            ref={bind('assist')}
            type="button"
            onClick={toggleAssist}
            aria-pressed="true"
            title="Flight assist (Z)"
          >
            <Label as="span">Flight assist</Label>
            <Value
              as="span"
              ref={bind('assistValue')}
            >
              On
            </Value>
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
            <Label>
              Target · ETA <span ref={bind('eta')}>—</span>
            </Label>
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
  font-size: 10px;
  line-height: 13px;
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

const AssistButton = styled.button`
  ${glassButton}
  width: auto;
  height: auto;
  min-height: 32px;
  flex-direction: column;
  align-items: flex-start;
  padding: 0 10px;
  margin-left: auto;
  border-radius: 10px;
  font: inherit;
  color: rgba(255, 255, 255, 0.92);
  line-height: 16px;
  text-align: left;

  &[aria-pressed='false'] {
    color: #f0a640;
  }

  &[aria-pressed='false'] > :first-child {
    color: rgba(240, 166, 64, 0.8);
  }

  @media (hover: none) {
    &:hover {
      background-color: transparent;
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
