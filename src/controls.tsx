import styled from 'styled-components'
import { useRef, useState, useEffect } from 'react'
import {
  IconClock,
  IconWorld,
  IconSun,
  IconMoon,
  IconMapPin,
  IconPlayerTrackNext,
  IconEye,
} from '@tabler/icons-react'
import { DateTime } from 'luxon'
import { useStore, type CameraFocus } from './store'
import { truncateLatLon } from './utils'

function formatDateInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

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
  const {
    timeScale,
    setTimeScale,
    setJumpDate,
    cameraFocus,
    setCameraFocus,
    setLocation,
    location,
  } = useStore()
  const [locationError, setLocationError] = useState<string | null>(null)
  const [dateInput, setDateInput] = useState('')

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDateInput(formatDateInput(e.target.value))
  }

  const handleDateSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const dt = DateTime.fromFormat(dateInput, 'MM/dd/yyyy')
    if (dt.isValid) {
      setJumpDate(dt.toJSDate())
    }
  }

  const handleLocationClick = () => {
    setLocationError(null)
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: truncateLatLon(pos.coords.latitude),
          lon: truncateLatLon(pos.coords.longitude),
        })
      },
      (err) => setLocationError(err.message),
      { enableHighAccuracy: true }
    )
  }

  return (
    <ControlContainer>
      <FocusDropdown
        value={cameraFocus}
        onChange={setCameraFocus}
        options={
          location
            ? [
                ...FOCUS_OPTIONS,
                {
                  value: 'location' as const,
                  Icon: IconMapPin,
                  title: 'My Location',
                },
              ]
            : FOCUS_OPTIONS
        }
      />
      <SpeedDropdown
        value={timeScale}
        onChange={setTimeScale}
        options={SPEED_OPTIONS}
      />
      <LocationButton
        type="button"
        onClick={handleLocationClick}
        title="Use my location"
        aria-label="Use my location"
      >
        <IconMapPin
          size={20}
          stroke={2}
        />
      </LocationButton>
      {locationError && <LocationError>{locationError}</LocationError>}
      <DateForm onSubmit={handleDateSubmit}>
        <DateInput
          type="text"
          inputMode="numeric"
          placeholder="mm/dd/yyyy"
          value={dateInput}
          onChange={handleDateChange}
          maxLength={10}
        />
      </DateForm>
    </ControlContainer>
  )
}

const SPEED_OPTIONS = [
  { value: 1, label: 'Real Time' },
  { value: 60 * 60, label: '1 Hour per Second' },
  { value: 60 * 60 * 24, label: '1 Day per Second' },
  { value: 60 * 60 * 24 * 30, label: '1 Month per Second' },
] as const

type SpeedOption = (typeof SPEED_OPTIONS)[number]

function SpeedDropdown({
  value,
  onChange,
  options,
}: {
  value: number
  options: readonly SpeedOption[]
  onChange: (value: number) => void
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

  const current = options.find((o) => o.value === value)
  const label = current?.label ?? 'Real Time'

  return (
    <FocusDropdownWrap ref={ref}>
      <FocusTrigger
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Time speed: ${label}`}
        title={label}
      >
        <IconPlayerTrackNext
          size={20}
          stroke={2}
        />
      </FocusTrigger>
      {open && (
        <FocusMenu>
          {options.map(({ value: v, label: l }) => (
            <SpeedOptionButton
              key={v}
              type="button"
              onClick={() => {
                onChange(v)
                setOpen(false)
              }}
            >
              {l}
            </SpeedOptionButton>
          ))}
        </FocusMenu>
      )}
    </FocusDropdownWrap>
  )
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
        <FocusTriggerIconWrap>
          <IconEye
            size={20}
            stroke={2}
          />
          <FocusTriggerBadge>
            <CurrentIcon
              size={12}
              stroke={2}
            />
          </FocusTriggerBadge>
        </FocusTriggerIconWrap>
      </FocusTrigger>
      {open && (
        <FocusMenu>
          {options.map(({ value: v, Icon, title }) => (
            <FocusOption
              key={v}
              type="button"
              onClick={() => {
                onChange(v)
                setOpen(false)
              }}
              aria-label={title}
            >
              <Icon
                size={18}
                stroke={2}
              />
              <span>{title}</span>
            </FocusOption>
          ))}
        </FocusMenu>
      )}
    </FocusDropdownWrap>
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

const FocusDropdownWrap = styled.div`
  position: relative;
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

const FocusTriggerIconWrap = styled.span`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
`

const FocusTriggerBadge = styled.span`
  position: absolute;
  right: -4px;
  bottom: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
`

const LocationButton = styled.button`
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

const LocationError = styled.span`
  font-size: 12px;
  color: #c66;
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
  justify-content: flex-start;
  gap: 8px;
  min-width: 120px;
  height: 36px;
  padding: 0 10px;
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

const SpeedOptionButton = styled.button`
  display: block;
  width: 100%;
  min-width: 160px;
  padding: 8px 12px;
  text-align: left;
  font-size: 14px;
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
`

const DateInput = styled.input`
  padding: 6px 10px;
  width: 120px;
  font-size: 16px;
  background-color: black;
  color: gray;
  outline: none;
  border: 1px gray solid;
  border-radius: 8px;

  &::placeholder {
    color: #555;
  }
`
