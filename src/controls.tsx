import styled from 'styled-components'
import { useRef, useState, useEffect, useId } from 'react'
import {
  IconClock,
  IconWorld,
  IconSun,
  IconMoon,
  IconMapPin,
  IconPlanet,
  IconPlayerTrackNext,
  IconEye,
  IconSettings,
  IconX,
} from '@tabler/icons-react'
import {
  PLANET_FOCUS_KEYS,
  SYSTEM_AID_KEYS,
  useStore,
  type CameraFocus,
  type Layout,
  type SystemAidKey,
  type WeatherSource,
} from './store'
import { truncateLatLon } from './utils'
import { isMoonKey } from './moons/moon-keys'
import DateTimePicker from './DateTimePicker'
import { glassButton, glassPanel, PHONE } from './glass-styles'
import DockToggle from './DockToggle'
import { opensDownOnPhone, phoneDock, useDockDisclosure } from './dock-disclosure'

const FOCUS_OPTIONS: {
  value: CameraFocus
  Icon: typeof IconClock
  title: string
  /** Starts a new group in the menu, set off by a divider. */
  groupStart?: boolean
}[] = [
  { value: 'clock', Icon: IconClock, title: 'Clock' },
  { value: 'earth', Icon: IconWorld, title: 'Earth' },
  { value: 'sun', Icon: IconSun, title: 'Sun' },
  { value: 'moon', Icon: IconMoon, title: 'Moon' },
]

const PLANET_FOCUS_OPTIONS: typeof FOCUS_OPTIONS = PLANET_FOCUS_KEYS.map(
  (value, i) => ({
    value,
    Icon: IconPlanet,
    title: value[0].toUpperCase() + value.slice(1),
    groupStart: i === 0,
  })
)

export default function Controls() {
  // Per-field selectors: the whole store changes every frame (timestamp).
  const timeScale = useStore((s) => s.timeScale)
  const setTimeScale = useStore((s) => s.setTimeScale)
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const setLocation = useStore((s) => s.setLocation)
  const location = useStore((s) => s.location)
  const showPlanets = useStore((s) => s.showPlanets)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { dockRef, dockProps, toggleProps } = useDockDisclosure()

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
    <ControlContainer
      ref={dockRef}
      {...dockProps}
    >
      <DockToggle {...toggleProps} />
      <FocusDropdown
        value={cameraFocus}
        onChange={setCameraFocus}
        options={[
          ...(location
            ? [
                ...FOCUS_OPTIONS,
                {
                  value: 'location' as const,
                  Icon: IconMapPin,
                  title: 'My Location',
                },
              ]
            : FOCUS_OPTIONS),
          ...(showPlanets ? PLANET_FOCUS_OPTIONS : []),
        ]}
      />
      <SpeedDropdown
        value={timeScale}
        onChange={setTimeScale}
        options={SPEED_OPTIONS}
      />
      <IconButton
        type="button"
        onClick={handleLocationClick}
        title="Use my location"
        aria-label="Use my location"
      >
        <IconMapPin
          size={20}
          stroke={2}
        />
      </IconButton>
      {locationError && <LocationError>{locationError}</LocationError>}
      <DateTimePicker />
      <IconButton
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="dialog"
      >
        <IconSettings
          size={20}
          stroke={2}
        />
      </IconButton>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </ControlContainer>
  )
}

const WEATHER_OPTIONS: { value: WeatherSource; label: string }[] = [
  { value: 'real', label: 'Real' },
  { value: 'static', label: 'Simulated' },
]

const LAYOUT_OPTIONS: { value: Layout; label: string }[] = [
  { value: 'single', label: 'Single' },
  { value: 'triple', label: 'Triple' },
]

const PLANETS_OPTIONS: { value: 'off' | 'on'; label: string }[] = [
  { value: 'off', label: 'Hide' },
  { value: 'on', label: 'Show' },
]

const SYSTEM_AID_LABELS: Record<SystemAidKey, string> = {
  orbits: 'Orbits',
  grid: 'Grid',
  labels: 'Labels',
  belts: 'Belts',
  scale: 'Scale',
  trails: 'Trails',
}

const CONSTELLATIONS_OPTIONS: { value: 'off' | 'lines' | 'art'; label: string }[] = [
  { value: 'off', label: 'Hide' },
  { value: 'lines', label: 'Lines' },
  { value: 'art', label: 'Lines + art' },
]

const STELLARIUM_URL = 'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern'
const FREE_ART_LICENSE_URL = 'https://artlibre.org/licence/lal/en/'

/** A native modal dialog: showModal() supplies the focus trap, Esc, and focus return. */
function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const pressedBackdrop = useRef(false)
  const titleId = useId()
  const weatherHintId = useId()
  const weatherSource = useStore((s) => s.weatherSource)
  const setWeatherSource = useStore((s) => s.setWeatherSource)
  const layout = useStore((s) => s.layout)
  const setLayout = useStore((s) => s.setLayout)
  const showPlanets = useStore((s) => s.showPlanets)
  const setShowPlanets = useStore((s) => s.setShowPlanets)
  const guidesHintId = useId()
  const systemAids = useStore((s) => s.systemAids)
  const setSystemAid = useStore((s) => s.setSystemAid)
  const constellationsHintId = useId()
  const showConstellations = useStore((s) => s.showConstellations)
  const setShowConstellations = useStore((s) => s.setShowConstellations)
  const showConstellationArt = useStore((s) => s.showConstellationArt)
  const setShowConstellationArt = useStore((s) => s.setShowConstellationArt)
  const showLunar = useStore((s) => s.showLunar)
  const setShowLunar = useStore((s) => s.setShowLunar)
  const showZodiac = useStore((s) => s.showZodiac)
  const setShowZodiac = useStore((s) => s.setShowZodiac)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // The dialog element itself is only hit through its backdrop; the content
  // fills it. Both press and release must land there, so a drag that ends
  // outside doesn't close it.
  const isBackdrop = (e: React.MouseEvent) => e.target === e.currentTarget

  return (
    <Dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        pressedBackdrop.current = isBackdrop(e)
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && isBackdrop(e)) onClose()
      }}
    >
      <DialogBody>
        <DialogHeader>
          <DialogTitle id={titleId}>Settings</DialogTitle>
          <CloseButton
            type="button"
            onClick={onClose}
            aria-label="Close settings"
          >
            <IconX
              size={18}
              stroke={2}
            />
          </CloseButton>
        </DialogHeader>
        <SettingGroup aria-describedby={weatherHintId}>
          <SettingLegend>Weather</SettingLegend>
          <SegmentedControl
            name="weather"
            value={weatherSource}
            options={WEATHER_OPTIONS}
            onChange={setWeatherSource}
          />
          <SettingHint id={weatherHintId}>
            Real shows daily NASA satellite clouds from 2000-02-24 to
            yesterday, and simulated clouds otherwise.
          </SettingHint>
        </SettingGroup>
        <SettingGroup>
          <SettingLegend>Layout</SettingLegend>
          <SegmentedControl
            name="layout"
            value={layout}
            options={LAYOUT_OPTIONS}
            onChange={setLayout}
          />
        </SettingGroup>
        <SettingGroup>
          <SettingLegend>Planets</SettingLegend>
          <SegmentedControl
            name="planets"
            value={showPlanets ? 'on' : 'off'}
            options={PLANETS_OPTIONS}
            onChange={(value) => setShowPlanets(value === 'on')}
          />
        </SettingGroup>
        {/* The aids only draw beside the planets, so they go with them. */}
        {showPlanets && (
          <SettingGroup aria-describedby={guidesHintId}>
            <SettingLegend>Guides</SettingLegend>
            <ToggleChips>
              {SYSTEM_AID_KEYS.map((key) => (
                <Segment key={key}>
                  <input
                    type="checkbox"
                    name={`aid-${key}`}
                    checked={systemAids[key]}
                    onChange={(e) => setSystemAid(key, e.target.checked)}
                  />
                  <span>{SYSTEM_AID_LABELS[key]}</span>
                </Segment>
              ))}
            </ToggleChips>
            <SettingHint id={guidesHintId}>
              Aids in the Three Body System view.
            </SettingHint>
          </SettingGroup>
        )}
        <SettingGroup aria-describedby={constellationsHintId}>
          <SettingLegend>Constellations</SettingLegend>
          <SegmentedControl
            name="constellations"
            value={showConstellations ? (showConstellationArt ? 'art' : 'lines') : 'off'}
            options={CONSTELLATIONS_OPTIONS}
            onChange={(value) => {
              setShowConstellations(value !== 'off')
              setShowConstellationArt(value === 'art')
            }}
          />
          <SettingHint id={constellationsHintId}>
            Lines for the major constellations in the View from Earth panel.
            Art by Johan Meuris for{' '}
            <a
              href={STELLARIUM_URL}
              target="_blank"
              rel="noreferrer"
            >
              Stellarium
            </a>{' '}
            (
            <a
              href={FREE_ART_LICENSE_URL}
              target="_blank"
              rel="noreferrer"
            >
              Free Art License
            </a>
            ).
          </SettingHint>
        </SettingGroup>
        <SettingGroup>
          <SettingLegend>Moon phases</SettingLegend>
          <SegmentedControl
            name="lunar"
            value={showLunar ? 'on' : 'off'}
            options={PLANETS_OPTIONS}
            onChange={(value) => setShowLunar(value === 'on')}
          />
        </SettingGroup>
        <SettingGroup>
          <SettingLegend>Zodiac</SettingLegend>
          <SegmentedControl
            name="zodiac"
            value={showZodiac ? 'on' : 'off'}
            options={PLANETS_OPTIONS}
            onChange={(value) => setShowZodiac(value === 'on')}
          />
        </SettingGroup>
      </DialogBody>
    </Dialog>
  )
}

function SegmentedControl<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <Segments>
      {options.map((option) => (
        <Segment key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </Segment>
      ))}
    </Segments>
  )
}

/** Escape closes an open menu, and only the menu: the phone dock stays open. */
function closeOnEscape(
  e: React.KeyboardEvent,
  open: boolean,
  setOpen: (open: boolean) => void
) {
  if (e.key !== 'Escape' || !open) return
  e.preventDefault()
  setOpen(false)
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
    <FocusDropdownWrap
      ref={ref}
      onKeyDown={(e) => closeOnEscape(e, open, setOpen)}
    >
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
  options: typeof FOCUS_OPTIONS
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

  // A moon is focused by tapping it and has no menu entry; name it anyway.
  const current =
    options.find((o) => o.value === value) ??
    (isMoonKey(value) ? { Icon: IconMoon, title: value[0].toUpperCase() + value.slice(1) } : undefined)
  const CurrentIcon = current?.Icon ?? IconClock
  const label = current?.title ?? 'Clock'

  return (
    <FocusDropdownWrap
      ref={ref}
      onKeyDown={(e) => closeOnEscape(e, open, setOpen)}
    >
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
          {options.map(({ value: v, Icon, title, groupStart }) => (
            <FocusOption
              key={v}
              type="button"
              data-group-start={groupStart || undefined}
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

// A floating glass capsule; --dock-* live in index.css so panel labels can clear it.
const ControlContainer = styled.section`
  position: fixed;
  left: 0;
  right: 0;
  bottom: var(--dock-bottom);
  z-index: 10;
  width: max-content;
  max-width: calc(100% - 24px);
  height: var(--dock-height);
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px;
  border-radius: 999px;
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.35),
    0 2px 8px rgba(0, 0, 0, 0.25);

  /* The glass sits on a pseudo-element: backdrop-filter on the bar itself would
   * make it the backdrop root, and the menus inside could only blur the bar. */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.04)),
      rgba(30, 30, 34, 0.38);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    backdrop-filter: blur(20px) saturate(180%);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.3),
      inset 0 -1px 1px rgba(255, 255, 255, 0.06);
    pointer-events: none;
  }

  /* Specular rim: a 1px gradient ring, brightest where light catches the top-left edge. */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    padding: 1px;
    border-radius: inherit;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.55),
      rgba(255, 255, 255, 0.1) 35%,
      rgba(255, 255, 255, 0.04) 65%,
      rgba(255, 255, 255, 0.28)
    );
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  /* Five controls fit a 320px phone only with tighter spacing. */
  @media (max-width: 360px) {
    gap: 4px;
  }

  ${phoneDock}
`

const FocusDropdownWrap = styled.div`
  position: relative;
`

const FocusTrigger = styled.button`
  ${glassButton}
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

const IconButton = styled.button`
  ${glassButton}
`

// Floats above the bar so a long message never widens it past a phone screen.
const LocationError = styled.span`
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100vw - 32px);
  padding: 6px 12px;
  font-size: 12px;
  color: #f99;
  border-radius: 12px;
  ${glassPanel}

  ${PHONE} {
    top: calc(100% + 8px);
    bottom: auto;
  }
`

// Opens upward: the bar sits on the bottom edge. The margin clears the bar's rim.
const FocusMenu = styled.div`
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  max-height: calc(100dvh - 72px);
  overflow-y: auto;
  border-radius: 18px;
  z-index: 100;
  ${glassPanel}
  ${opensDownOnPhone}

  /* Scroll rather than squash the options when the menu is taller than the view. */
  & > * {
    flex-shrink: 0;
  }

  & > [data-group-start] {
    position: relative;
    margin-top: 5px;
  }

  & > [data-group-start]::before {
    content: '';
    position: absolute;
    top: -4px;
    left: 6px;
    right: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
  }
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
  color: rgba(255, 255, 255, 0.78);
  border: none;
  border-radius: 12px;
  cursor: pointer;

  &:hover {
    background-color: rgba(255, 255, 255, 0.14);
    color: #fff;
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
  color: rgba(255, 255, 255, 0.78);
  border: none;
  border-radius: 12px;
  cursor: pointer;

  &:hover {
    background-color: rgba(255, 255, 255, 0.14);
    color: #fff;
  }
`

const Dialog = styled.dialog`
  width: min(360px, calc(100vw - 32px));
  padding: 0;
  background-color: #1a1a1a;
  color: #aaa;
  border: 1px solid #333;
  border-radius: 12px;

  &::backdrop {
    background-color: rgba(0, 0, 0, 0.6);
  }
`

const DialogBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 20px 20px;
`

const DialogHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const DialogTitle = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ddd;
`

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  color: gray;
  border: none;
  border-radius: 8px;
  cursor: pointer;

  &:hover {
    background-color: #222;
    color: #aaa;
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 1px;
  }
`

const SettingGroup = styled.fieldset`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
`

const SettingLegend = styled.legend`
  padding: 0;
  margin-bottom: 8px;
  font-size: 13px;
  color: #888;
`

const SettingHint = styled.p`
  margin: 0;
  font-size: 12px;
  color: #888;

  a {
    color: inherit;
  }

  a:hover {
    color: #bbb;
  }
`

const Segments = styled.div`
  display: flex;
  padding: 3px;
  gap: 3px;
  background-color: black;
  border: 1px gray solid;
  border-radius: 8px;
`

// On/off chips in the segmented control's frame, three to a row; each chip is
// a Segment holding a checkbox, so checked reads as a selected segment.
const ToggleChips = styled(Segments)`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
`

const Segment = styled.label`
  position: relative;
  flex: 1;

  input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  span {
    display: block;
    padding: 6px 12px;
    text-align: center;
    font-size: 14px;
    color: gray;
    border-radius: 6px;
  }

  input:hover + span {
    color: #aaa;
  }

  input:checked + span {
    background-color: #333;
    color: #ddd;
  }

  input:focus-visible + span {
    outline: 2px solid #4c9ffe;
    outline-offset: 1px;
  }
`
