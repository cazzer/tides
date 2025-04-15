import styled from 'styled-components'
import { useStore } from './store'
import { useRef, useState } from 'react'

export default function Controls() {
  const { timeScale, setTimeScale, setJumpDate } = useStore()
  const [date, setDate] = useState<string>()
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

  return (
    <ControlContainer>
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
        />
      </DateForm>
    </ControlContainer>
  )
}

type Speed = {
  value: number | string
  label: string
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
  position: absolute;
  z-index: 1000;
  width: 100vw;
  display: flex;
  justify-content: space-around;
  align-items: center;
`

const DropdownContainer = styled.select`
  padding: 4px;
  margin: 4px;
  font-size: 18px;
  background-color: black;
  color: gray;
  outline: none;
  border: 1px gray solid;
  border-radius: 8px;
  min-width: 0;
`

const DateForm = styled.form`
  margin: 4px;
  min-width: 0;
`

const DateInput = styled.input`
  padding: 4px;
  width: 100%;
  font-size: 18px;
  background-color: black;
  color: gray;
  outline: none;
  border: 1px gray solid;
  border-radius: 8px;
`
