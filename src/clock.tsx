import { useStore } from './store'

export default function Clock() {
  const { timeScale, setTimeScale } = useStore()

  const onChangeTimeScale = (event) => {
    setTimeScale(event.target.value)
  }

  return (
    <section>
      <input
        value={timeScale}
        onChange={onChangeTimeScale}
        type="number"
        style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          width: '200px',
          zIndex: '10000',
        }}
      />
    </section>
  )
}
