import { describe, it, expect } from 'vitest'
import {
  RETRY_BASE_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
  retryDelayMs,
} from './orbitReconnect'

// random = 0.5 is the midpoint of [0, 1): no jitter either way.
const MID = 0.5

describe('retryDelayMs', () => {
  it('doubles from 1 s and holds at 60 s', () => {
    const delays = Array.from({ length: 9 }, (_, attempt) => retryDelayMs(attempt, MID))
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ])
  })

  it('jitters by at most ±20 %', () => {
    expect(RETRY_JITTER).toBe(0.2)
    for (const attempt of [0, 3, 10]) {
      const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
      expect(retryDelayMs(attempt, 0)).toBeCloseTo(base * 0.8)
      // random is in [0, 1), so the top of the range is approached, not hit.
      expect(retryDelayMs(attempt, 0.999_999)).toBeLessThan(base * 1.2)
      expect(retryDelayMs(attempt, 0.999_999)).toBeGreaterThan(base * 1.19)
    }
  })

  it('stays within the jitter band for any random value', () => {
    for (let i = 0; i <= 100; i++) {
      const r = i / 101
      const d = retryDelayMs(6, r)
      expect(d).toBeGreaterThanOrEqual(RETRY_MAX_MS * 0.8)
      expect(d).toBeLessThan(RETRY_MAX_MS * 1.2)
    }
  })

  // No cap on attempts: the counter keeps climbing for as long as the
  // satellite view is open, so huge values must still give the 60 s step.
  it('holds at the cap for very large attempt numbers', () => {
    expect(retryDelayMs(1_000, MID)).toBe(RETRY_MAX_MS)
    expect(retryDelayMs(Number.MAX_SAFE_INTEGER, MID)).toBe(RETRY_MAX_MS)
  })

  it('treats a negative or NaN attempt as the first one', () => {
    expect(retryDelayMs(-3, MID)).toBe(RETRY_BASE_MS)
    expect(retryDelayMs(Number.NaN, MID)).toBe(RETRY_BASE_MS)
  })

  it('never returns a negative or non-finite delay', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999_999]) {
      for (const attempt of [0, 1, 5, 50, Number.POSITIVE_INFINITY]) {
        const d = retryDelayMs(attempt, r)
        expect(Number.isFinite(d)).toBe(true)
        expect(d).toBeGreaterThan(0)
      }
    }
  })

  it('uses Math.random when no random value is passed', () => {
    const d = retryDelayMs(0)
    expect(d).toBeGreaterThanOrEqual(RETRY_BASE_MS * 0.8)
    expect(d).toBeLessThan(RETRY_BASE_MS * 1.2)
  })
})
