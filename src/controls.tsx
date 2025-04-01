import styled from 'styled-components'
import { useStore } from './store'

export default function Controls() {
  const { timeScale, setTimeScale } = useStore()

  return (
    <ControlContainer>
      <Dropdown
        currentValue={timeScale}
        onChange={setTimeScale}
        values={[
          { value: 1, label: 'Real Time' },
          { value: 60 * 60, label: '1 Hours per Second' },
          { value: 60 * 60 * 24, label: '1 Day per Second' },
          { value: 60 * 60 * 24 * 30, label: '1 Month per Second' },
        ]}
      />
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
}: {
  currentValue: number | string
  values: Speed[]
  onChange: (value: number) => void
}) {
  const handleChange = (event) => {
    onChange(event.target.value as number)
  }

  return (
    <DropdownContainer
      onChange={handleChange}
      value={currentValue}
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
  margin: 10px;
  width: 100vw;
  display: flex;
  justify-content: space-around;
  align-items: 'center';
`

const DropdownContainer = styled.select`
  padding: 4px;
  font-size: 16px;
  background-color: transparent;
  color: gray;
  outline: none;
  border: 1px gray solid;
  border-radius: 8px;
`
