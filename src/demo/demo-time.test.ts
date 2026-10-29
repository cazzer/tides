import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { subscribeDemoTime } from './demo-time'

describe('subscribeDemoTime', () => {
  const start = Date.parse('2026-03-03T08:30:00Z')
  beforeEach(() => useStore.setState({ timestamp: start }))

  it('writes the time on subscribing, then only as the minute turns', () => {
    const writes: string[] = []
    const unsubscribe = subscribeDemoTime((text) => writes.push(text))
    expect(writes).toEqual(['3 Mar 2026, 08:30 UTC'])

    for (let s = 1; s < 60; s++) useStore.setState({ timestamp: start + s * 1000 })
    expect(writes).toHaveLength(1)

    useStore.setState({ timestamp: start + 60_000 })
    expect(writes).toEqual(['3 Mar 2026, 08:30 UTC', '3 Mar 2026, 08:31 UTC'])

    useStore.setState({ timestamp: null })
    expect(writes[writes.length - 1]).toBe('')

    unsubscribe()
    useStore.setState({ timestamp: start + 120_000 })
    expect(writes).toHaveLength(3)
  })

  it('writes once per minute stepped through', () => {
    const writes: string[] = []
    const unsubscribe = subscribeDemoTime((text) => writes.push(text))
    for (let i = 1; i <= 5; i++) useStore.setState({ timestamp: start + i * 61_000 })
    unsubscribe()
    // The first write is on subscribing.
    expect(writes).toHaveLength(6)
  })
})
