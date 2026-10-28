import styled from 'styled-components'
import { useEffect, useId, useRef, useState, type Ref } from 'react'
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from '@tabler/icons-react'
import { useStore } from '../store'
import { glassButton, glassPanel, PHONE } from '../glass-styles'
import { findDemo } from './demos'
import { formatDemoTime, type Demo } from './demo-script'

// After the exit has rendered, focus the demo button the dock came back
// with, or the dock's toggle while the phone dock is folded and hides it.
function focusDemoButton() {
  setTimeout(() => {
    const button = document.querySelector<HTMLElement>('[data-demo-button]')
    const shown = button && getComputedStyle(button).visibility === 'visible'
    const target = shown ? button : document.querySelector<HTMLElement>('[data-dock-toggle]')
    target?.focus({ preventScroll: true })
  })
}

function typingInto(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

const MINUTE = 60_000

/**
 * The running demo's caption and controls, in place of the dock (tides-zec.5).
 * Escape leaves the demo and the arrow keys step through it.
 */
export function DemoBar() {
  const run = useStore((s) => s.demo)
  const playing = useStore((s) => s.timeScale !== 0)
  // By the minute: the whole timestamp changes every frame.
  const minute = useStore((s) => (s.timestamp == null ? null : Math.floor(s.timestamp / MINUTE)))
  const goToDemoStep = useStore((s) => s.goToDemoStep)
  const exitDemo = useStore((s) => s.exitDemo)
  const toggleDemoPlaying = useStore((s) => s.toggleDemoPlaying)
  const nextRef = useRef<HTMLButtonElement>(null)
  const demo = run ? findDemo(run.id) : undefined

  // The menu that started the demo has gone with the dock.
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true })
    return focusDemoButton
  }, [])

  const step = run?.step ?? 0
  const count = demo?.steps.length ?? 0
  const last = step === count - 1

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || typingInto(e.target)) return
      if ((e.target as Element | null)?.closest?.('dialog')) return
      if (e.key === 'Escape') exitDemo()
      else if (e.key === 'ArrowLeft' && step > 0) goToDemoStep(step - 1)
      else if (e.key === 'ArrowRight' && !last) goToDemoStep(step + 1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step, last, exitDemo, goToDemoStep])

  if (!run || !demo) return null
  return (
    <DemoBarView
      demo={demo}
      step={step}
      playing={playing}
      time={minute == null ? null : minute * MINUTE}
      nextRef={nextRef}
      onStep={goToDemoStep}
      onTogglePlaying={toggleDemoPlaying}
      onExit={exitDemo}
    />
  )
}

export interface DemoBarViewProps {
  demo: Demo
  step: number
  playing: boolean
  /** The sim time (epoch ms), or null before the clock starts. */
  time: number | null
  nextRef?: Ref<HTMLButtonElement>
  onStep: (index: number) => void
  onTogglePlaying: () => void
  onExit: () => void
}

/** The bar itself, from props alone. */
export function DemoBarView({
  demo,
  step,
  playing,
  time,
  nextRef,
  onStep,
  onTogglePlaying,
  onExit,
}: DemoBarViewProps) {
  const count = demo.steps.length
  const first = step === 0
  const last = step === count - 1
  const { caption } = demo.steps[step]
  const captionId = useId()
  const bodyRef = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  // A caption that scrolls has to be reachable by keyboard to scroll it.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => setOverflowing(body.scrollHeight > body.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [caption.body])

  return (
    <Bar aria-label={`Demo: ${demo.title}`}>
      {/* Read out on each step; the ticking clock stays out of it. */}
      <Caption id={captionId} aria-live="polite">
        <Heading>
          <Title>{caption.title}</Title>
          <Meta aria-hidden="true">
            {time != null && <span>{formatDemoTime(time)}</span>}
            <span>
              {step + 1} / {count}
            </span>
          </Meta>
        </Heading>
        <VisuallyHidden>
          Step {step + 1} of {count}.
        </VisuallyHidden>
        <Body
          ref={bodyRef}
          tabIndex={overflowing ? 0 : undefined}
        >
          {caption.body}
        </Body>
      </Caption>
      <Buttons>
        {/* aria-disabled, not disabled, so focus stays on it at step 1. */}
        <Button
          type="button"
          onClick={() => {
            if (!first) onStep(step - 1)
          }}
          aria-disabled={first || undefined}
          aria-label="Previous step"
          title="Previous step"
        >
          <IconChevronLeft size={20} stroke={2} />
        </Button>
        <Button
          type="button"
          onClick={onTogglePlaying}
          aria-label={playing ? 'Pause time' : 'Play time'}
          title={playing ? 'Pause time' : 'Play time'}
        >
          {playing ? <IconPlayerPause size={20} stroke={2} /> : <IconPlayerPlay size={20} stroke={2} />}
        </Button>
        {/* One button for both, so focus stays on it into the last step. */}
        <TextButton
          ref={nextRef}
          type="button"
          onClick={() => (last ? onExit() : onStep(step + 1))}
          aria-describedby={captionId}
        >
          {last ? 'Done' : 'Next'}
          {!last && <IconChevronRight size={18} stroke={2} />}
        </TextButton>
        <Spacer />
        <Button type="button" onClick={onExit} aria-label="Exit demo" title="Exit demo">
          <IconX size={20} stroke={2} />
        </Button>
      </Buttons>
    </Bar>
  )
}

// Where the dock sits, a little wider: the dock is hidden while a demo runs.
const Bar = styled.section`
  position: fixed;
  left: var(--dock-inset-left);
  right: var(--dock-inset-right);
  bottom: var(--dock-bottom);
  z-index: 10;
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 8px;
  border-radius: 20px;
  color: rgba(255, 255, 255, 0.9);
  ${glassPanel}
`

const Caption = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 4px;
`

const Heading = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 12px;
  row-gap: 2px;
`

const Title = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
`

const Meta = styled.span`
  display: flex;
  gap: 10px;
  margin-left: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.6);
`

const VisuallyHidden = styled.span`
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

const Body = styled.p`
  margin: 0;
  max-height: 30dvh;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.8);

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 2px;
    border-radius: 4px;
  }

  ${PHONE} {
    font-size: 13px;
  }
`

const Buttons = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const Spacer = styled.div`
  flex: 1;
`

const Button = styled.button`
  ${glassButton}
  width: 44px;
  height: 44px;

  &[aria-disabled='true'] {
    opacity: 0.35;
    cursor: default;
    background-color: transparent;
  }
`

const TextButton = styled.button`
  ${glassButton}
  width: auto;
  height: 44px;
  gap: 2px;
  padding: 0 14px 0 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background-color: rgba(255, 255, 255, 0.12);
`
