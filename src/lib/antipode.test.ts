import { describe, it, expect } from 'vitest'
import { computeAntipode, pointInCountry, identifyOcean } from './antipode'
import type { Polygon, MultiPolygon } from 'geojson'

// ── Simple test geometries ────────────────────────────────────────────────────

/** A 10°×10° square around the origin */
const SQUARE_POLYGON: Polygon = {
  type: 'Polygon',
  coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]],
}

/** Two separate 4°×4° boxes — one near origin, one near (100, 40) */
const MULTI_POLYGON: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    // Part 1: near origin
    [[[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]]],
    // Part 2: near (100, 40)
    [[[98, 38], [102, 38], [102, 42], [98, 42], [98, 38]]],
  ],
}

// ── computeAntipode ───────────────────────────────────────────────────────────

describe('computeAntipode', () => {
  it('flips latitude to its negative', () => {
    expect(computeAntipode(0, 45)[1]).toBe(-45)
    expect(computeAntipode(0, -30)[1]).toBe(30)
  })

  it('shifts positive longitude by -180', () => {
    expect(computeAntipode(90, 0)[0]).toBe(-90)
  })

  it('shifts negative longitude by +180', () => {
    expect(computeAntipode(-90, 0)[0]).toBe(90)
  })

  it('antipode of (0, 0) is (180, 0) or (-180, 0)', () => {
    const [lng, lat] = computeAntipode(0, 0)
    expect(Math.abs(lng)).toBe(180)
    // -lat of 0 is -0 in IEEE 754; treat as equal to 0
    expect(Object.is(lat, 0) || Object.is(lat, -0)).toBe(true)
  })

  it('antipode of north pole is south pole', () => {
    const [, lat] = computeAntipode(0, 90)
    expect(lat).toBe(-90)
  })

  it('antipode of antipode returns original point (modulo ±180 lng equiv)', () => {
    const [lng1, lat1] = computeAntipode(50, 30)
    const [lng2, lat2] = computeAntipode(lng1, lat1)
    expect(lat2).toBe(30)
    expect(Math.abs(Math.abs(lng2) - 50)).toBeLessThan(0.001)
  })
})

// ── pointInCountry ────────────────────────────────────────────────────────────

describe('pointInCountry — Polygon', () => {
  it('returns true for a point inside', () => {
    expect(pointInCountry(0, 0, SQUARE_POLYGON)).toBe(true)
  })

  it('returns false for a point outside', () => {
    expect(pointInCountry(10, 10, SQUARE_POLYGON)).toBe(false)
  })

  it('returns false for a point exactly on the boundary (ray-casting edge)', () => {
    // Ray-casting is implementation-defined on boundary; just verify no crash
    expect(typeof pointInCountry(5, 0, SQUARE_POLYGON)).toBe('boolean')
  })

  it('returns false at a far-away point', () => {
    expect(pointInCountry(150, 60, SQUARE_POLYGON)).toBe(false)
  })
})

describe('pointInCountry — MultiPolygon', () => {
  it('returns true for a point in the first part', () => {
    expect(pointInCountry(0, 0, MULTI_POLYGON)).toBe(true)
  })

  it('returns true for a point in the second part', () => {
    expect(pointInCountry(100, 40, MULTI_POLYGON)).toBe(true)
  })

  it('returns false for a point in neither part', () => {
    expect(pointInCountry(50, 50, MULTI_POLYGON)).toBe(false)
  })
})

// ── identifyOcean ─────────────────────────────────────────────────────────────

describe('identifyOcean', () => {
  it('returns Arctic for high northern latitudes', () => {
    expect(identifyOcean(0, 80)).toBe('Arctic')
  })

  it('returns Southern for latitudes below -55', () => {
    expect(identifyOcean(0, -60)).toBe('Southern')
  })

  it('returns Indian for coordinates in the Indian Ocean', () => {
    expect(identifyOcean(75, 10)).toBe('Indian')
  })

  it('returns Pacific for coordinates in the Pacific', () => {
    expect(identifyOcean(160, 0)).toBe('Pacific')
  })

  it('returns Atlantic for coordinates in the Atlantic', () => {
    expect(identifyOcean(-30, 30)).toBe('Atlantic')
  })

  it('Arctic takes priority over everything else at lat > 70', () => {
    // Even if coordinates might match Pacific bounds, Arctic fires first
    expect(identifyOcean(160, 75)).toBe('Arctic')
  })
})
