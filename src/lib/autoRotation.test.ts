import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AUTO_ROTATION_DEG_PER_S,
  ROTATION_RESUME_MS,
  autoRotationSpeed,
  createRotationHolds,
} from './autoRotation'

describe('autoRotationSpeed', () => {
  it('turns at full speed up to the default globe zoom', () => {
    expect(autoRotationSpeed(0.5)).toBe(AUTO_ROTATION_DEG_PER_S)
    expect(autoRotationSpeed(2.5)).toBe(AUTO_ROTATION_DEG_PER_S)
  })

  it('slows as you zoom in, keeping the same speed on screen', () => {
    expect(autoRotationSpeed(4.5)).toBeCloseTo(1, 10)
    expect(autoRotationSpeed(6.5)).toBeCloseTo(0.25, 10)
    expect(autoRotationSpeed(8)).toBeCloseTo(4 * 2 ** -5.5, 10)
    // Pixels per degree double with each zoom level.
    for (const z of [2.5, 3.7, 5, 8]) {
      expect(autoRotationSpeed(z) * 2 ** z).toBeCloseTo(autoRotationSpeed(2.5) * 2 ** 2.5, 8)
    }
  })
})

describe('createRotationHolds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spins with nothing holding it', () => {
    expect(createRotationHolds().isSpinning()).toBe(true)
  })

  it(`holds while the pointer is pressed and resumes ${ROTATION_RESUME_MS / 1000} s after release`, () => {
    const r = createRotationHolds()
    r.press()
    vi.advanceTimersByTime(60_000)
    expect(r.isSpinning()).toBe(false)
    r.release(true)
    vi.advanceTimersByTime(ROTATION_RESUME_MS - 1)
    expect(r.isSpinning()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(r.isSpinning()).toBe(true)
  })

  it('stays held after a release that asks not to resume (an interactive mode is on)', () => {
    const r = createRotationHolds()
    r.press()
    r.release(false)
    vi.advanceTimersByTime(60_000)
    expect(r.isSpinning()).toBe(false)
  })

  it('a press cancels a resume that was waiting', () => {
    const r = createRotationHolds()
    r.pauseFor(1_000)
    r.press()
    vi.advanceTimersByTime(10_000)
    expect(r.isSpinning()).toBe(false)
  })

  it(`holds while a satellite is hovered and resumes ${ROTATION_RESUME_MS / 1000} s after the hover ends`, () => {
    const r = createRotationHolds()
    r.hover(true)
    vi.advanceTimersByTime(60_000)
    expect(r.isSpinning()).toBe(false)
    r.hover(false)
    vi.advanceTimersByTime(ROTATION_RESUME_MS - 1)
    expect(r.isSpinning()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(r.isSpinning()).toBe(true)
  })

  it('a hover that ends mid-drag leaves the resume to the release', () => {
    const r = createRotationHolds()
    r.press()
    r.hover(true)
    r.hover(false)
    vi.advanceTimersByTime(60_000) // a long drag
    expect(r.isSpinning()).toBe(false)
    r.release(true)
    vi.advanceTimersByTime(ROTATION_RESUME_MS)
    expect(r.isSpinning()).toBe(true)
  })

  it('other resumes (after a release or a timed pause) wait for the hover to end', () => {
    const r = createRotationHolds()
    r.hover(true)
    r.pauseFor(700) // e.g. entering the globe
    r.press()
    r.release(true)
    vi.advanceTimersByTime(60_000)
    expect(r.isSpinning()).toBe(false)
    r.hover(false)
    vi.advanceTimersByTime(ROTATION_RESUME_MS)
    expect(r.isSpinning()).toBe(true)
  })

  it('a repeated hover report changes nothing', () => {
    const r = createRotationHolds()
    r.hover(false) // no hover to end: no pause
    expect(r.isSpinning()).toBe(true)
    r.hover(true)
    r.hover(true)
    r.hover(false)
    vi.advanceTimersByTime(ROTATION_RESUME_MS)
    expect(r.isSpinning()).toBe(true)
  })

  it('dispose drops a pending resume', () => {
    const r = createRotationHolds()
    r.pauseFor(1_000)
    r.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
