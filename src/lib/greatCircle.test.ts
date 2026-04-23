import { describe, it, expect } from 'vitest'
import {
  haversineDistance,
  rhumbDistance,
  interpolateGreatCircle,
  unwrapPath,
  splitAtAntiMeridian,
} from './greatCircle'

// Tolerance helpers
const CLOSE = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

describe('haversineDistance', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistance([0, 0], [0, 0])).toBe(0)
  })

  it('returns ~20,015 km for antipodal equatorial points (π × R, R=6371)', () => {
    const d = haversineDistance([0, 0], [180, 0])
    // π × 6371 km ≈ 20,015 km
    expect(CLOSE(d, 20_015, 5)).toBe(true)
  })

  it('NYC → London ≈ 5,571 km', () => {
    // New York (-74, 40.7), London (-0.13, 51.5)
    const d = haversineDistance([-74, 40.7], [-0.13, 51.5])
    expect(CLOSE(d, 5571, 30)).toBe(true)
  })

  it('is symmetric', () => {
    const a: [number, number] = [10, 20]
    const b: [number, number] = [50, 60]
    expect(haversineDistance(a, b)).toBeCloseTo(haversineDistance(b, a), 5)
  })

  it('pole-to-pole ≈ 20,015 km (π × R, R=6371)', () => {
    const d = haversineDistance([0, 90], [0, -90])
    expect(CLOSE(d, 20_015, 5)).toBe(true)
  })
})

describe('rhumbDistance', () => {
  it('returns 0 for identical points', () => {
    expect(rhumbDistance([0, 0], [0, 0])).toBeCloseTo(0, 3)
  })

  it('along equator equals haversine (same result for E-W travel)', () => {
    const a: [number, number] = [0, 0]
    const b: [number, number] = [90, 0]
    expect(rhumbDistance(a, b)).toBeCloseTo(haversineDistance(a, b), 0)
  })

  it('normalizes anti-meridian: same result regardless of crossing direction', () => {
    // Sydney to LA crossing anti-meridian vs going the "wrong" way
    const sydney: [number, number] = [151, -33.9]
    const la: [number, number] = [-118, 34]
    const d1 = rhumbDistance(sydney, la)
    const d2 = rhumbDistance(la, sydney)
    expect(d1).toBeCloseTo(d2, 0)
  })
})

describe('interpolateGreatCircle', () => {
  it('returns two points for identical inputs (d < 1e-10 threshold)', () => {
    const pts = interpolateGreatCircle([0, 0], [0, 0])
    expect(pts.length).toBe(2)
  })

  it('returns numPoints+1 points by default (100 segments = 101 points)', () => {
    const pts = interpolateGreatCircle([0, 0], [90, 0])
    expect(pts.length).toBe(101)
  })

  it('first and last points match the inputs (within float error)', () => {
    const p1: [number, number] = [-74, 40.7]
    const p2: [number, number] = [139.7, 35.7]
    const pts = interpolateGreatCircle(p1, p2, 50)
    expect(pts[0][0]).toBeCloseTo(p1[0], 4)
    expect(pts[0][1]).toBeCloseTo(p1[1], 4)
    expect(pts[pts.length - 1][0]).toBeCloseTo(p2[0], 4)
    expect(pts[pts.length - 1][1]).toBeCloseTo(p2[1], 4)
  })

  it('arc through equator stays near equator for equatorial input', () => {
    const pts = interpolateGreatCircle([0, 0], [180, 0], 10)
    for (const [, lat] of pts) {
      expect(Math.abs(lat)).toBeLessThan(1) // all lats near 0
    }
  })

  it('respects custom numPoints', () => {
    const pts = interpolateGreatCircle([0, 0], [90, 0], 20)
    expect(pts.length).toBe(21)
  })
})

describe('unwrapPath', () => {
  it('returns empty array for empty input', () => {
    expect(unwrapPath([])).toEqual([])
  })

  it('passes through a single point unchanged', () => {
    expect(unwrapPath([[10, 20]])).toEqual([[10, 20]])
  })

  it('does not modify a path with no anti-meridian crossing', () => {
    const pts: [number, number][] = [[0, 0], [90, 45], [170, -30]]
    const result = unwrapPath(pts)
    expect(result).toEqual(pts)
  })

  it('unwraps a path crossing the anti-meridian eastward', () => {
    // Path: 170 → -170 (a +20° jump that looks like a -340° jump without unwrapping)
    const pts: [number, number][] = [[170, 0], [-170, 0]]
    const result = unwrapPath(pts)
    expect(result[1][0]).toBeCloseTo(190, 3) // unwrapped to 190°
  })

  it('unwraps a path crossing the anti-meridian westward', () => {
    const pts: [number, number][] = [[-170, 0], [170, 0]]
    const result = unwrapPath(pts)
    expect(result[1][0]).toBeCloseTo(-190, 3)
  })

  it('handles a path that keeps crossing eastward', () => {
    // Each step crosses the anti-meridian going east: 170 → -170 → -150
    // After unwrapping: 170 → 190 → 210
    const pts: [number, number][] = [[170, 0], [-170, 0], [-150, 0]]
    const result = unwrapPath(pts)
    expect(result[0][0]).toBeCloseTo(170, 3)
    expect(result[1][0]).toBeCloseTo(190, 3)
    expect(result[2][0]).toBeCloseTo(210, 3)
  })
})

describe('splitAtAntiMeridian', () => {
  it('returns a single segment for a path that does not cross', () => {
    const pts: [number, number][] = [[0, 0], [90, 0], [170, 0]]
    expect(splitAtAntiMeridian(pts)).toHaveLength(1)
  })

  it('splits a path that crosses the anti-meridian into two segments', () => {
    // Each segment needs ≥2 points to survive the filter
    const pts: [number, number][] = [[160, 0], [170, 0], [190, 0], [200, 0]]
    const segs = splitAtAntiMeridian(pts)
    expect(segs).toHaveLength(2)
  })

  it('each segment has at least 2 points', () => {
    const pts: [number, number][] = [[170, 10], [190, 10], [210, 10]]
    const segs = splitAtAntiMeridian(pts)
    for (const seg of segs) {
      expect(seg.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('returns [[]] for empty input (early-return branch)', () => {
    expect(splitAtAntiMeridian([])).toEqual([[]])
  })

  it('returns a single-item array for a single-point input (early-return branch)', () => {
    // pts.length < 2 → returns [pts] immediately, no filtering
    const result = splitAtAntiMeridian([[0, 0]])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual([[0, 0]])
  })

  it('all output coordinates are normalised to [-180, 180]', () => {
    const pts: [number, number][] = [[170, 0], [195, 0], [220, 0]]
    const segs = splitAtAntiMeridian(pts)
    for (const seg of segs) {
      for (const [lng] of seg) {
        expect(lng).toBeGreaterThanOrEqual(-180)
        expect(lng).toBeLessThanOrEqual(180)
      }
    }
  })
})
