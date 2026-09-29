import { describe, it, expect } from 'vitest'
import type { ConjunctionEvent } from './orbitStream'
import {
  PASSED_GRACE_MS,
  conjunctionPairKey,
  isSamePair,
  mergeConjunctionEvents,
  pruneConjunctionEvents,
} from './conjunctionEvents'

const NOW = 1_790_000_000_000
const MIN = 60_000

function event(noradA: number, noradB: number, tcaInMin: number, missKm = 1): ConjunctionEvent {
  return {
    noradA,
    noradB,
    tcaEpochMs: NOW + tcaInMin * MIN,
    missKm,
    relVelKms: 10,
    groupA: 'active',
    groupB: 'debris',
    midLat: 0,
    midLng: 0,
    midAltKm: 550,
  }
}

const pairs = (events: ConjunctionEvent[]) => events.map((e) => `${e.noradA}-${e.noradB}`)

describe('conjunctionPairKey / isSamePair', () => {
  it('ignores the order of the two satellites', () => {
    expect(conjunctionPairKey(2, 1)).toBe(conjunctionPairKey(1, 2))
    expect(isSamePair(event(1, 2, 10), { noradA: 2, noradB: 1 })).toBe(true)
    expect(isSamePair(event(1, 2, 10), { noradA: 1, noradB: 3 })).toBe(false)
    expect(isSamePair(event(1, 2, 10), null)).toBe(false)
  })
})

describe('mergeConjunctionEvents', () => {
  it('keeps a pair the new batch left out', () => {
    const merged = mergeConjunctionEvents([event(1, 2, 10)], [event(3, 4, 20)], NOW, null)
    expect(pairs(merged)).toEqual(['1-2', '3-4'])
  })

  it('refreshes a pair with the newer estimate of the same approach', () => {
    const merged = mergeConjunctionEvents(
      [event(1, 2, 10, 3.0)],
      [event(1, 2, 12, 0.4)],
      NOW,
      null,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].missKm).toBe(0.4)
    expect(merged[0].tcaEpochMs).toBe(NOW + 12 * MIN)
  })

  it('matches a pair reported with A and B swapped', () => {
    const merged = mergeConjunctionEvents([event(1, 2, 10)], [event(2, 1, 11)], NOW, null)
    expect(merged).toHaveLength(1)
  })

  it("doesn't let a later pass of the pair replace the sooner one", () => {
    const merged = mergeConjunctionEvents([event(1, 2, 10)], [event(1, 2, 100)], NOW, null)
    expect(merged).toHaveLength(1)
    expect(merged[0].tcaEpochMs).toBe(NOW + 10 * MIN)
  })

  it('lets a sooner pass of the pair replace a later one', () => {
    const merged = mergeConjunctionEvents([event(1, 2, 100)], [event(1, 2, 10)], NOW, null)
    expect(merged[0].tcaEpochMs).toBe(NOW + 10 * MIN)
  })

  it('drops an event once it is past its closest approach by more than the grace', () => {
    const justPassed = event(1, 2, -0.5)
    const longPassed = { ...event(3, 4, 0), tcaEpochMs: NOW - PASSED_GRACE_MS - 1 }
    const merged = mergeConjunctionEvents([justPassed, longPassed], [], NOW, null)
    expect(pairs(merged)).toEqual(['1-2'])
  })

  it('keeps the selected pair after its closest approach', () => {
    const passed = event(1, 2, -30)
    const merged = mergeConjunctionEvents([passed], [], NOW, { noradA: 1, noradB: 2 })
    expect(merged).toEqual([passed])
  })

  it('replaces a finished, unselected pass with the next one', () => {
    const merged = mergeConjunctionEvents([event(1, 2, -30)], [event(1, 2, 60)], NOW, null)
    expect(merged).toHaveLength(1)
    expect(merged[0].tcaEpochMs).toBe(NOW + 60 * MIN)
  })

  it('keeps a finished pass while it is selected, even when the next one arrives', () => {
    const passed = event(1, 2, -30)
    const merged = mergeConjunctionEvents([passed], [event(1, 2, 60)], NOW, {
      noradA: 1,
      noradB: 2,
    })
    expect(merged).toEqual([passed])
  })

  it('returns the list sorted by closest approach', () => {
    const merged = mergeConjunctionEvents(
      [event(1, 2, 50), event(3, 4, 5)],
      [event(5, 6, 20)],
      NOW,
      null,
    )
    expect(pairs(merged)).toEqual(['3-4', '5-6', '1-2'])
  })
})

describe('pruneConjunctionEvents', () => {
  it('returns the same array when nothing is dropped', () => {
    const events = [event(1, 2, 10)]
    expect(pruneConjunctionEvents(events, NOW, null)).toBe(events)
  })

  it('drops passed events unless selected', () => {
    const events = [event(1, 2, -5), event(3, 4, -5), event(5, 6, 10)]
    expect(pairs(pruneConjunctionEvents(events, NOW, { noradA: 3, noradB: 4 }))).toEqual([
      '3-4',
      '5-6',
    ])
  })
})
