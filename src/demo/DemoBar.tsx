import styled from 'styled-components'
import { useEffect, useRef, type Ref } from 'react'
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
import type { Demo } from './demo-script'

// After the exit has rendered, focus the demo button the dock came back with.
function focusDemoButton() {
  setTimeout(() =>
    document.querySelector<HTMLElement>('[data-demo-button]')?.focus({ preventScroll: true })
  )
}

function typingInto(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/**
 * The running demo's caption and controls, in place of the dock (tides-zec.5).
 * Escape leaves the demo and the arrow keys step through it.
 */
export function DemoBar() {
  const run = useStore((s) => s.demo)
  const playing = useStore((s) => s.timeScale !== 0)
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
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingInto(e.target)) return
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
  nextRef,
  onStep,
  onTogglePlaying,
  onExit,
}: DemoBarViewProps) {
  const count = demo.steps.length
  const last = step === count - 1
  const { caption } = demo.steps[step]

  return (
    <Bar aria-label={`Demo: ${demo.title}`}>
      <Caption aria-live="polite">
        <Heading>
          <Title>{caption.title}</Title>
          <Count>
            {step + 1} / {count}
          </Count>
        </Heading>
        <Body>{caption.body}</Body>
      </Caption>
      <Buttons>
        <Button
          type="button"
          onClick={() => onStep(step - 1)}
          disabled={step === 0}
          aria-label="Previous step"
          title="Previous step"
        >
          <IconChevronLeft size={20} stroke={2} />
        </Button>
        <Button
          type="button"
          onClick={onTogglePlaying}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <IconPlayerPause size={20} stroke={2} /> : <IconPlayerPlay size={20} stroke={2} />}
        </Button>
        {/* One button for both, so focus stays on it into the last step. */}
        <TextButton
          ref={nextRef}
          type="button"
          onClick={() => (last ? onExit() : onStep(step + 1))}
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
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
`

const Title = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
`

const Count = styled.span`
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.6);
`

const Body = styled.p`
  margin: 0;
  max-height: 30dvh;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.8);

  ${PHONE} {
    font-size: 13px;
  }
`

const Buttons = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`

const Spacer = styled.div`
  flex: 1;
`

const Button = styled.button`
  ${glassButton}

  &:disabled {
    opacity: 0.35;
    cursor: default;
    background-color: transparent;
  }
`

const TextButton = styled.button`
  ${glassButton}
  width: auto;
  gap: 2px;
  padding: 0 12px 0 14px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background-color: rgba(255, 255, 255, 0.12);
`
