import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSatelliteHoverTracker, SCENE_REPICK_MS } from './satelliteHoverTracker'
import type { SatelliteHover } from './satelliteHoverTracker'
import type { SatPosition } from './satellites'

function sat(norad: number): SatPosition {
  return { norad, name: String(norad), group: 'starlink', lng: 0, lat: 0, altitudeKm: 550 }
}

// Animation frames that only run when the test says so.
function manualFrames() {
  let next = 1
  const queue = new Map<number, () => void>()
  return {
    request: (cb: () => void) => {
      const id = next++
      queue.set(id, cb)
      return id
    },
    cancel: (id: number) => {
      queue.delete(id)
    },
    pending: () => queue.size,
    flush: () => {
      const cbs = [...queue.values()]
      queue.clear()
      cbs.forEach((cb) => cb())
    },
  }
}

function setup(initial: SatPosition | null = sat(1)) {
  const frames = manualFrames()
  let under: SatPosition | null = initial
  const pick = vi.fn((_point: { x: number; y: number }) => under)
  const changes: (SatelliteHover | null)[] = []
  const tracker = createSatelliteHoverTracker({
    pick,
    onChange: (h) => changes.push(h),
    frames,
  })
  return {
    tracker,
    frames,
    pick,
    changes,
    setUnder: (s: SatPosition | null) => {
      under = s
    },
  }
}

describe('createSatelliteHoverTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('picks on the next frame after a pointer move', () => {
    const { tracker, frames, pick, changes } = setup()
    tracker.pointerMove({ x: 10, y: 20 })
    expect(pick).not.toHaveBeenCalled()
    frames.flush()
    expect(pick).toHaveBeenCalledWith({ x: 10, y: 20 })
    expect(changes).toEqual([{ sat: sat(1), point: { x: 10, y: 20 } }])
  })

  it('picks once per frame, at the latest pointer', () => {
    const { tracker, frames, pick } = setup()
    tracker.pointerMove({ x: 1, y: 1 })
    tracker.pointerMove({ x: 2, y: 2 })
    tracker.pointerMove({ x: 3, y: 3 })
    expect(frames.pending()).toBe(1)
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(1)
    expect(pick).toHaveBeenCalledWith({ x: 3, y: 3 })
  })

  it('reports only when the hovered satellite or the pointer changes', () => {
    const { tracker, frames, changes, setUnder } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush()
    // Same satellite, same pointer: nothing new.
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    tracker.sceneChanged()
    frames.flush()
    expect(changes).toHaveLength(1)
    // Same satellite, pointer moved: the tooltip follows the pointer.
    tracker.pointerMove({ x: 12, y: 10 })
    frames.flush()
    expect(changes).toHaveLength(2)
    // Another satellite under the pointer.
    setUnder(sat(2))
    tracker.pointerMove({ x: 13, y: 10 })
    frames.flush()
    expect(changes[2]?.sat.norad).toBe(2)
  })

  it('with a still pointer, re-picks when the scene moves under it', () => {
    const { tracker, frames, pick, changes, setUnder } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush()
    setUnder(sat(2)) // the globe turned; another dot is under the pointer now
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    tracker.sceneChanged()
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(2)
    expect(pick).toHaveBeenLastCalledWith({ x: 10, y: 10 })
    expect(changes.map((c) => c?.sat.norad)).toEqual([1, 2])
  })

  it(`re-picks for scene changes at most every ${SCENE_REPICK_MS} ms, and catches up at the end of the wait`, () => {
    const { tracker, frames, pick } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush() // pick 1
    vi.advanceTimersByTime(10)
    tracker.sceneChanged()
    vi.advanceTimersByTime(30)
    tracker.sceneChanged()
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(1) // still inside the wait
    vi.advanceTimersByTime(SCENE_REPICK_MS - 40)
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(2) // one trailing pick for both changes
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(2) // nothing changed since
  })

  it('ignores scene changes while the pointer is off the map', () => {
    const { tracker, frames, pick } = setup()
    tracker.sceneChanged()
    frames.flush()
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    frames.flush()
    expect(pick).not.toHaveBeenCalled()

    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush()
    tracker.pointerLeave()
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    tracker.sceneChanged()
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('clears the hover once when nothing is under the pointer any more', () => {
    const { tracker, frames, changes, setUnder } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush()
    setUnder(null)
    tracker.pointerMove({ x: 50, y: 50 })
    frames.flush()
    tracker.pointerMove({ x: 60, y: 60 })
    frames.flush()
    expect(changes).toEqual([{ sat: sat(1), point: { x: 10, y: 10 } }, null])
  })

  it('clears the hover once when the pointer leaves, and drops a pending pick', () => {
    const { tracker, frames, pick, changes } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush()
    tracker.pointerMove({ x: 11, y: 10 }) // pick pending…
    tracker.pointerLeave() // …but the pointer left first
    frames.flush()
    tracker.pointerLeave()
    expect(pick).toHaveBeenCalledTimes(1)
    expect(changes).toEqual([{ sat: sat(1), point: { x: 10, y: 10 } }, null])
  })

  it('reset clears the hover once and forgets the pointer', () => {
    const { tracker, frames, pick, changes } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    frames.flush()
    vi.advanceTimersByTime(10)
    tracker.sceneChanged() // a trailing pick is waiting
    tracker.reset()
    tracker.reset()
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    frames.flush()
    tracker.sceneChanged()
    frames.flush()
    expect(pick).toHaveBeenCalledTimes(1)
    expect(changes).toEqual([{ sat: sat(1), point: { x: 10, y: 10 } }, null])
  })

  it('does nothing after dispose', () => {
    const { tracker, frames, pick, changes } = setup()
    tracker.pointerMove({ x: 10, y: 10 })
    tracker.dispose()
    frames.flush()
    tracker.pointerMove({ x: 20, y: 20 })
    tracker.sceneChanged()
    tracker.pointerLeave()
    vi.advanceTimersByTime(SCENE_REPICK_MS)
    frames.flush()
    expect(pick).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  })
})
