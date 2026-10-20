import styled from 'styled-components'
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { IconChevronLeft, IconChevronRight, IconClockPlay } from '@tabler/icons-react'
import { DateTime } from 'luxon'
import { useStore } from './store'
import { JUMP_DURATION_MS } from './sim-clock'
import {
  MASK,
  applyEdit,
  formatMasked,
  isComplete,
  normalize,
  parseMasked,
  pasteText,
  type Edit,
  type Masked,
} from './datetime-mask'
import { monthGrid, type DayCell } from './month-grid'
import { glassButton, glassPanel } from './glass-styles'

type Month = { year: number; month: number }
type Day = { year: number; month: number; day: number }

const MINUTE_MS = 60_000
// Minute- and day-floored selectors: timestamp changes every frame, these don't.
const selectSimMinute = (s: { timestamp: number | null }) =>
  s.timestamp == null ? null : Math.floor(s.timestamp / MINUTE_MS)
// The jump target, not the tween, so the mark doesn't race through the months.
const selectSimDay = (s: { timestamp: number | null; jumpDate: Date | null }) => {
  const ms = s.jumpDate?.getTime() ?? s.timestamp
  if (ms == null) return null
  const d = new Date(ms)
  return `${d.getFullYear()} ${d.getMonth() + 1} ${d.getDate()}`
}
const parseDayKey = (key: string): Day => {
  const [year, month, day] = key.split(' ').map(Number)
  return { year, month, day }
}

/** Sim time, or where a running jump will land. */
const simNow = () => {
  const { jumpDate, timestamp } = useStore.getState()
  return DateTime.fromMillis(jumpDate?.getTime() ?? timestamp ?? Date.now())
}
const sameDay = (a: Day | null, b: Day) =>
  a != null && a.year === b.year && a.month === b.month && a.day === b.day
const dayOf = (dt: DateTime): Day => ({ year: dt.year, month: dt.month, day: dt.day })

/** The dock's date pill; opens a panel with the masked field, a calendar and Now. */
export default function DateTimePicker() {
  const [open, setOpen] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      if (slotRef.current && !slotRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  return (
    <Slot ref={slotRef}>
      <Trigger
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <SimTimeLabel />
      </Trigger>
      {open && (
        <PickerPanel
          id={panelId}
          onClose={() => {
            setOpen(false)
            triggerRef.current?.focus()
          }}
        />
      )}
    </Slot>
  )
}

function SimTimeLabel() {
  const minute = useStore(selectSimMinute)
  if (minute == null) return <TriggerDate>Date</TriggerDate>
  const dt = DateTime.fromMillis(minute * MINUTE_MS)
  return (
    <>
      <VisuallyHidden>Date and time: </VisuallyHidden>
      <TriggerDate>{dt.toFormat('LLL d, yyyy')}</TriggerDate>
      <VisuallyHidden>, </VisuallyHidden>
      <TriggerTime>{dt.toFormat('HH:mm')}</TriggerTime>
    </>
  )
}

function PickerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const setJumpDate = useStore((s) => s.setJumpDate)
  const setTimeScale = useStore((s) => s.setTimeScale)
  /** What the field shows while it is being edited; null shows the live sim time. */
  const [draft, setDraft] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** Tells screen readers where a jump went. */
  const [announcement, setAnnouncement] = useState('')
  const [view, setView] = useState<Month>(() => {
    const now = simNow()
    return { year: now.year, month: now.month }
  })
  /** Sim time when editing began: supplies fields the draft leaves out. */
  const [anchor, setAnchor] = useState<DateTime | null>(null)
  const fallback = () => anchor ?? simNow()
  const inputRef = useRef<HTMLInputElement>(null)
  /** The value focus began with, or the last one jumped to: blur discards a draft equal to it. */
  const baselineRef = useRef('')

  const parsed = draft == null ? null : parseMasked(draft, fallback())
  const draftDay = parsed?.ok ? dayOf(parsed.dt) : null
  // Impossible dates show as soon as they're typed; a half-typed field only on submit.
  const error = submitError ?? (parsed?.ok === false && parsed.kind === 'impossible' ? parsed.reason : null)

  const editDraft = (value: string | null) => {
    setDraft(value)
    setSubmitError(null)
    setAnnouncement('')
    const p = value == null ? null : parseMasked(value, fallback())
    if (p?.ok) setView({ year: p.dt.year, month: p.dt.month })
  }

  // A focused field holds the target: the live value would tween under the caret.
  const settle = (target: DateTime, message: string) => {
    if (inputRef.current && document.activeElement === inputRef.current) {
      const value = formatMasked(target.toMillis())
      baselineRef.current = value
      setDraft(value)
    } else {
      setDraft(null)
    }
    setSubmitError(null)
    setAnnouncement(message)
    setView({ year: target.year, month: target.month })
  }

  const jump = (dt: DateTime) => {
    const date = dt.toJSDate()
    setJumpDate(date)
    // Only jumps write ?t=; the running clock would change it every frame.
    const params = new URLSearchParams(window.location.search)
    params.set('t', date.toISOString())
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    settle(dt, `Jumping to ${dt.toFormat('LLL d, yyyy HH:mm')}`)
  }

  const submit = (value: string) => {
    // Untouched, the frozen value is behind the running clock; don't jump back to it.
    if (value === baselineRef.current) return
    const p = parseMasked(value, fallback())
    if (p.ok) jump(p.dt)
    else setSubmitError(p.reason)
  }

  const pickDay = ({ year, month, day }: Day) => {
    const time = parsed?.ok ? parsed.dt : simNow()
    jump(time.set({ year, month, day }))
  }

  const goLive = () => {
    setTimeScale(1)
    // The jump tweens for JUMP_DURATION_MS, so aim where live time will be when it lands.
    const target = DateTime.fromMillis(Date.now() + JUMP_DURATION_MS)
    setJumpDate(target.toJSDate())
    const params = new URLSearchParams(window.location.search)
    params.delete('t')
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    settle(target, 'Back to the current time at real-time speed')
  }

  return (
    <Panel
      id={id}
      role="dialog"
      aria-label="Choose date and time"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <Calendar
        view={view}
        onViewChange={setView}
        selected={draftDay}
        onPick={pickDay}
        onNow={goLive}
      />
      <MaskedField
        inputRef={inputRef}
        baselineRef={baselineRef}
        draft={draft}
        error={error}
        announcement={announcement}
        onDraftChange={editDraft}
        onEditStart={() => setAnchor(simNow())}
        onSubmit={submit}
      />
    </Panel>
  )
}

function MaskedField({
  inputRef,
  baselineRef,
  draft,
  error,
  announcement,
  onDraftChange,
  onEditStart,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  baselineRef: React.RefObject<string>
  draft: string | null
  error: string | null
  announcement: string
  onDraftChange: (value: string | null) => void
  onEditStart: () => void
  onSubmit: (value: string) => void
}) {
  const minute = useStore(selectSimMinute)
  const live = minute == null ? '' : formatMasked(minute * MINUTE_MS)
  const value = draft ?? live
  const pendingCaret = useRef<number | null>(null)
  const hintId = useId()
  const statusId = useId()

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
  }, [inputRef])

  useLayoutEffect(() => {
    const input = inputRef.current
    if (pendingCaret.current == null || !input) return
    if (document.activeElement === input) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current)
    }
    pendingCaret.current = null
  })

  const apply = (next: Masked, typed: boolean) => {
    const input = inputRef.current
    if (!input) return
    if (next.value === input.value) {
      // Nothing re-renders, so place the caret here.
      input.setSelectionRange(next.caret, next.caret)
      return
    }
    pendingCaret.current = next.caret
    onDraftChange(next.value)
    // Typing the last digit jumps; there is no return key on iOS's number pad.
    const completed =
      typed && isComplete(next.value) && !isComplete(input.value) && next.caret === next.value.length
    if (completed) onSubmit(next.value)
  }

  const onBeforeInput = useEffectEvent((e: InputEvent) => {
    const input = inputRef.current
    if (!input) return
    let edit: Edit
    switch (e.inputType) {
      case 'insertText':
        edit = { kind: 'insert', text: e.data ?? '' }
        break
      case 'deleteContentBackward':
      case 'deleteWordBackward':
      case 'deleteSoftLineBackward':
      case 'deleteByCut':
        edit = { kind: 'deleteBackward' }
        break
      case 'deleteContentForward':
      case 'deleteWordForward':
        edit = { kind: 'deleteForward' }
        break
      case 'historyUndo':
      case 'historyRedo':
        e.preventDefault()
        return
      default:
        // Composition, autofill and drops can't always be cancelled; onChange normalizes them.
        return
    }
    e.preventDefault()
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    apply(applyEdit(input.value, start, end, edit), e.inputType === 'insertText')
  })

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const listener = (e: Event) => onBeforeInput(e as InputEvent)
    input.addEventListener('beforeinput', listener)
    return () => input.removeEventListener('beforeinput', listener)
  }, [inputRef])

  return (
    <FieldForm
      onSubmit={(e) => {
        e.preventDefault()
        if (draft != null) onSubmit(draft)
      }}
    >
      <FieldRow>
        <FieldBox data-invalid={error ? true : undefined}>
          <Ghost aria-hidden="true">
            <GhostTyped>{value}</GhostTyped>
            {MASK.slice(value.length)}
          </Ghost>
          <Input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Date and time, month day year hours minutes"
            aria-describedby={`${hintId} ${statusId}`}
            aria-invalid={error ? true : undefined}
            value={value}
            onFocus={(e) => {
              onEditStart()
              if (draft == null) {
                baselineRef.current = value
                onDraftChange(value)
              }
              // iOS ignores a select() made during focus.
              const input = e.currentTarget
              requestAnimationFrame(() => {
                if (document.activeElement === input) input.select()
              })
            }}
            onBlur={() => {
              if (draft === baselineRef.current) onDraftChange(null)
            }}
            onChange={(e) => {
              const raw = e.target.value
              apply(normalize(raw, e.target.selectionStart ?? raw.length), false)
            }}
            onPaste={(e) => {
              e.preventDefault()
              const input = e.currentTarget
              const start = input.selectionStart ?? input.value.length
              apply(
                pasteText(input.value, start, input.selectionEnd ?? start, e.clipboardData.getData('text')),
                false
              )
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && draft != null && draft !== baselineRef.current) {
                e.stopPropagation()
                onDraftChange(baselineRef.current)
              }
            }}
          />
        </FieldBox>
        <GoButton type="submit">Go</GoButton>
      </FieldRow>
      <Hint id={hintId}>Type digits; local time, 24-hour.</Hint>
      <StatusText id={statusId} role="status" data-error={error ? true : undefined}>
        {error ?? announcement}
      </StatusText>
    </FieldForm>
  )
}

const WEEKDAYS = [
  ['S', 'Sunday'],
  ['M', 'Monday'],
  ['T', 'Tuesday'],
  ['W', 'Wednesday'],
  ['T', 'Thursday'],
  ['F', 'Friday'],
  ['S', 'Saturday'],
] as const

function Calendar({
  view,
  onViewChange,
  selected,
  onPick,
  onNow,
}: {
  view: Month
  onViewChange: (view: Month) => void
  /** The draft's day, when it has one; otherwise the sim day is marked. */
  selected: Day | null
  onPick: (day: Day) => void
  onNow: () => void
}) {
  const simDayKey = useStore(selectSimDay)
  const simDay = simDayKey == null ? null : parseDayKey(simDayKey)
  const marked = selected ?? simDay
  const today = dayOf(DateTime.local())
  const titleId = useId()
  const [active, setActive] = useState<Day | null>(null)
  const gridRef = useRef<HTMLTableElement>(null)
  const focusActive = useRef(false)

  const cells = monthGrid(view.year, view.month)
  const inView = (d: Day | null) => d != null && d.year === view.year && d.month === view.month
  // The one day in the tab order: the arrow-key target, else the marked day, else the 1st.
  const tabDay: Day = inView(active)
    ? active!
    : inView(marked)
      ? marked!
      : { ...view, day: 1 }

  useEffect(() => {
    if (!focusActive.current) return
    focusActive.current = false
    gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus()
  })

  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) {
      gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus()
    }
  }, [])

  const moveTo = (dt: DateTime) => {
    const day = dayOf(dt)
    setActive(day)
    onViewChange({ year: day.year, month: day.month })
    focusActive.current = true
  }

  const shiftMonth = (months: number) => {
    const dt = DateTime.local(view.year, view.month, 1).plus({ months })
    onViewChange({ year: dt.year, month: dt.month })
  }

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const from = DateTime.local(tabDay.year, tabDay.month, tabDay.day)
    const weekday = from.weekday % 7
    const moves: Record<string, () => DateTime> = {
      ArrowLeft: () => from.minus({ days: 1 }),
      ArrowRight: () => from.plus({ days: 1 }),
      ArrowUp: () => from.minus({ weeks: 1 }),
      ArrowDown: () => from.plus({ weeks: 1 }),
      Home: () => from.minus({ days: weekday }),
      End: () => from.plus({ days: 6 - weekday }),
      PageUp: () => from.minus(e.shiftKey ? { years: 1 } : { months: 1 }),
      PageDown: () => from.plus(e.shiftKey ? { years: 1 } : { months: 1 }),
    }
    const move = moves[e.key]
    if (!move) return
    e.preventDefault()
    moveTo(move())
  }

  const monthLabel = DateTime.local(view.year, view.month, 1).toFormat('LLLL yyyy')
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7))

  return (
    <>
      <CalendarHeader>
        <NavButton type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <IconChevronLeft size={18} stroke={2} />
        </NavButton>
        <MonthTitle id={titleId} aria-live="polite">
          {monthLabel}
        </MonthTitle>
        <NavButton type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
          <IconChevronRight size={18} stroke={2} />
        </NavButton>
        <NowButton
          type="button"
          onClick={onNow}
          aria-label="Now, at real-time speed"
          title="Jump back to the current time at real-time speed"
        >
          <IconClockPlay size={16} stroke={2} />
          Now
        </NowButton>
      </CalendarHeader>
      <Grid ref={gridRef} role="grid" aria-labelledby={titleId} onKeyDown={onGridKeyDown}>
        <thead>
          <tr>
            {WEEKDAYS.map(([letter, name]) => (
              <Weekday key={name} scope="col" abbr={name}>
                {letter}
              </Weekday>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={`${week[0].year}-${week[0].month}-${week[0].day}`}>
              {week.map((cell) => (
                <DayGridCell
                  key={`${cell.month}-${cell.day}`}
                  cell={cell}
                  marked={sameDay(marked, cell)}
                  today={sameDay(today, cell)}
                  tabbable={sameDay(tabDay, cell)}
                  onPick={() => {
                    setActive(cell)
                    onPick(cell)
                  }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </Grid>
    </>
  )
}

function DayGridCell({
  cell,
  marked,
  today,
  tabbable,
  onPick,
}: {
  cell: DayCell
  marked: boolean
  today: boolean
  tabbable: boolean
  onPick: () => void
}) {
  const date = DateTime.local(cell.year, cell.month, cell.day).toFormat('cccc, LLLL d, yyyy')
  // aria-selected sits on the cell, which most screen readers skip when the button has focus.
  const label = marked ? `${date}, selected` : date
  return (
    <td role="gridcell" aria-selected={marked}>
      <DayButton
        type="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={label}
        aria-current={today ? 'date' : undefined}
        data-outside={cell.inMonth ? undefined : true}
        data-marked={marked || undefined}
        data-today={today || undefined}
        onClick={onPick}
      >
        {cell.day}
      </DayButton>
    </td>
  )
}

// Fills with white text at 4.5:1 or better; the dock's #4c9ffe is for outlines.
const ACCENT = '#2563eb'
const ACCENT_HOVER = '#1d4fd8'

// Static, so the panel positions against the dock and centers on it, not on the pill.
const Slot = styled.div`
  position: static;
  flex: 0 1 120px;
  min-width: 96px;
`

const Trigger = styled.button`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  margin: 0;
  gap: 1px;
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  white-space: nowrap;
  background-color: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;

  &:hover,
  &[aria-expanded='true'] {
    background-color: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.35);
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 1px;
  }
`

const TriggerDate = styled.span`
  font-size: 12px;
  font-weight: 500;
`

const TriggerTime = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
`

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

// Opens upward over the bar, like the dock's menus, and scrolls if the view is short.
const Panel = styled.div`
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 14px;
  width: min(340px, calc(100vw - 24px));
  max-height: calc(100dvh - 72px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 22px;
  z-index: 100;
  color: rgba(255, 255, 255, 0.85);
  ${glassPanel}
`

const CalendarHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
`

const NavButton = styled.button`
  ${glassButton}
  width: 32px;
  height: 32px;

  @media (pointer: coarse) {
    width: 40px;
    height: 40px;
  }
`

const MonthTitle = styled.h2`
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  text-align: center;
  color: #fff;
`

const NowButton = styled.button`
  ${glassButton}
  width: auto;
  height: 32px;
  gap: 4px;
  margin-left: 6px;
  padding: 0 12px 0 10px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  background-color: rgba(255, 255, 255, 0.1);

  @media (pointer: coarse) {
    height: 40px;
  }
`

const Grid = styled.table`
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;

  td {
    padding: 1px;
  }
`

const Weekday = styled.th`
  padding: 4px 0;
  font-size: 11px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.55);
`

const DayButton = styled.button`
  display: block;
  width: 100%;
  height: 36px;
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;

  &[data-outside] {
    color: rgba(255, 255, 255, 0.5);
  }

  &[data-today] {
    border-color: rgba(255, 255, 255, 0.35);
  }

  &:hover {
    background-color: rgba(255, 255, 255, 0.14);
    color: #fff;
  }

  &[data-marked] {
    background-color: ${ACCENT};
    color: #fff;
    font-weight: 600;
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 1px;
  }

  &[data-marked]:focus-visible {
    outline-color: #fff;
  }
`

const FieldForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 0;
`

const FieldRow = styled.div`
  display: flex;
  gap: 8px;
`

const fieldText = `
  padding: 0 14px;
  font-family: inherit;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  line-height: 42px;
  white-space: pre;

  @media (max-width: 360px) {
    padding: 0 10px;
    font-size: 18px;
    letter-spacing: 0;
  }
`

const FieldBox = styled.div`
  position: relative;
  flex: 1;
  min-width: 0;
  height: 44px;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  overflow: hidden;

  &:focus-within {
    background-color: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.35);
  }

  &[data-invalid] {
    border-color: #f99;
  }
`

// The mask's unfilled tail, drawn behind the input after an invisible copy of the typed text.
const Ghost = styled.div`
  position: absolute;
  inset: 0;
  ${fieldText}
  color: rgba(255, 255, 255, 0.5);
  pointer-events: none;
  overflow: hidden;
`

const GhostTyped = styled.span`
  visibility: hidden;
`

const Input = styled.input`
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  margin: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #fff;
  ${fieldText}
`

const GoButton = styled.button`
  flex-shrink: 0;
  height: 44px;
  padding: 0 14px;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  background-color: ${ACCENT};
  color: #fff;
  border: none;
  border-radius: 14px;
  cursor: pointer;

  &:hover {
    background-color: ${ACCENT_HOVER};
  }

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
`

const Hint = styled.p`
  margin: 0 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
`

const StatusText = styled.p`
  margin: 0 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);

  &[data-error] {
    color: #f99;
  }
`
