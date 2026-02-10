import styled from 'styled-components'
import { useRef, useState, useEffect } from 'react'
import { IconClock, IconWorld, IconSun, IconMoon } from '@tabler/icons-react'
import { useStore, type CameraFocus } from './store'

const FOCUS_OPTIONS: {
  value: CameraFocus
  Icon: typeof IconClock
  title: string
}[] = [
  { value: 'clock', Icon: IconClock, title: 'Clock' },
  { value: 'earth', Icon: IconWorld, title: 'Earth' },
  { value: 'sun', Icon: IconSun, title: 'Sun' },
  { value: 'moon', Icon: IconMoon, title: 'Moon' },
]

export default function Controls() {
  const { timeScale, setTimeScale, setJumpDate, cameraFocus, setCameraFocus } =
    useStore()
  const [date, setDate] = useState<string>()
  const [isFocused, setIsFocused] = useState(false)
  const dateRef = useRef<HTMLInputElement>(null)

  const onDateChange = (event) => {
    setDate(event.target.value)
  }

  const handleDateSubmit = (event) => {
    event.stopPropagation()
    event.preventDefault()
    setJumpDate(new Date(date))

    if (dateRef.current) {
      dateRef.current.blur()
    }
  }

  const handleFocus = () => {
    setIsFocused(true)
  }
  const handleBlur = () => {
    setIsFocused(false)
  }

  return (
    <ControlContainer>
      <FocusDropdown
        value={cameraFocus}
        onChange={setCameraFocus}
        options={FOCUS_OPTIONS}
      />
      <Dropdown
        currentValue={timeScale}
        onChange={setTimeScale}
        values={[
          { value: 1, label: 'Real Time' },
          { value: 60 * 60, label: '1 Hour per Second' },
          { value: 60 * 60 * 24, label: '1 Day per Second' },
          { value: 60 * 60 * 24 * 30, label: '1 Month per Second' },
        ]}
      />
      <DateForm onSubmit={handleDateSubmit}>
        <DateInput
          ref={dateRef}
          type="text"
          placeholder="date (mm/dd/yyyy)"
          onChange={onDateChange}
          value={date}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        <Tooltip visible={isFocused}>
          <p>Enter date in mm/dd/yyyy format and hit "return"</p>
        </Tooltip>
      </DateForm>
    </ControlContainer>
  )
}

type Speed = {
  value: number | string
  label: string
}

function FocusDropdown({
  value,
  onChange,
  options,
}: {
  value: CameraFocus
  options: { value: CameraFocus; Icon: typeof IconClock; title: string }[]
  onChange: (value: CameraFocus) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  const [hoveredOption, setHoveredOption] = useState<CameraFocus | null>(null)
  const current = options.find((o) => o.value === value)
  const CurrentIcon = current?.Icon ?? IconClock
  const label = current?.title ?? 'Clock'

  return (
    <FocusDropdownWrap ref={ref}>
      <FocusTrigger
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Camera focus: ${label}`}
      >
        <CurrentIcon size={20} stroke={2} />
      </FocusTrigger>
      {open && (
        <FocusMenu>
          {options.map(({ value: v, Icon, title }) => (
            <FocusOptionWrap
              key={v}
              onMouseEnter={() => setHoveredOption(v)}
              onMouseLeave={() => setHoveredOption(null)}
            >
              <FocusOption
                type="button"
                onClick={() => {
                  onChange(v)
                  setOpen(false)
                }}
                aria-label={title}
              >
                <Icon size={20} stroke={2} />
              </FocusOption>
              {hoveredOption === v && (
                <FocusOptionTooltip>{title}</FocusOptionTooltip>
              )}
            </FocusOptionWrap>
          ))}
        </FocusMenu>
      )}
    </FocusDropdownWrap>
  )
}

function Dropdown({
  currentValue,
  values,
  onChange,
  disabled = false,
}: {
  currentValue: number | string
  values: Speed[]
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const handleChange = (event) => {
    onChange(event.target.value as number)
  }

  return (
    <DropdownContainer
      onChange={handleChange}
      value={currentValue}
      disabled={disabled}
    >
      {values.map(({ value, label }) => (
        <option
          key={value}
          value={value}
        >
          {label}
        </option>
      ))}
    </DropdownContainer>
  )
}

const ControlContainer = styled.section`
  position: relative;
  z-index: 10;
  height: 58px;
  flex-shrink: 0;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background-color: #1a1a1a;
  border-bottom: 1px solid #333;
`

const DropdownContainer = styled.select`
  padding: 6px 10px;
  margin: 0;
  font-size: 16px;
  background-color: black;
  color: gray;
  outline: none;
  border: 1px gray solid;
  border-radius: 8px;
  min-width: 0;
`

const FocusDropdownWrap = styled.div`
  position: relative;
`

const FocusOptionWrap = styled.div`
  position: relative;
`

const FocusOptionTooltip = styled.div`
  position: absolute;
  top: 50%;
  left: 100%;
  transform: translateY(-50%);
  margin-left: 8px;
  padding: 4px 8px;
  font-size: 12px;
  white-space: nowrap;
  background-color: darkslategray;
  color: #eee;
  border-radius: 6px;
  pointer-events: none;
  z-index: 1001;

  &::before {
    content: '';
    position: absolute;
    top: 50%;
    right: 100%;
    margin-top: -4px;
    border-width: 4px;
    border-style: solid;
    border-color: transparent darkslategray transparent transparent;
  }
`

const FocusTrigger = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0;
  background-color: black;
  color: gray;
  border: 1px gray solid;
  border-radius: 8px;
  cursor: pointer;

  &:hover {
    color: #aaa;
  }
`

const FocusMenu = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background-color: black;
  border: 1px gray solid;
  border-radius: 8px;
  z-index: 100;
`

const FocusOption = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0;
  background: transparent;
  color: gray;
  border: none;
  border-radius: 6px;
  cursor: pointer;

  &:hover {
    background-color: #222;
    color: #aaa;
  }
`

const DateForm = styled.form`
  margin: 0;
  min-width: 0;
  position: relative;
`

const DateInput = styled.input`
  padding: 6px 10px;
  width: 180px;
  font-size: 16px;
  background-color: black;
  color: gray;
  outline: none;
  border: 1px gray solid;
  border-radius: 8px;
`

const Tooltip = styled.div<{ visible: boolean }>`
  display: ${({ visible }) => (visible ? 'block' : 'none')};
  opacity: ${({ visible }) => (visible ? 1 : 0)};
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  padding: 6px 10px;
  background-color: darkslategray;
  color: #eee;
  max-width: 60vw;
  border-radius: 8px;
  z-index: 1000;

  &::before {
    content: '';
    position: absolute;
    bottom: 100%;
    left: 16px;
    margin-left: -4px;
    border-width: 4px;
    border-style: solid;
    border-color: transparent transparent darkslategray transparent;
  }
`
