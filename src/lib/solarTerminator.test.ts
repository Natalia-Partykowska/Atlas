import { describe, it, expect } from 'vitest'
import {
  getDayOfYear,
  subsolarPoint,
  computeTerminator,
  computeTerminatorCurve,
} from './solarTerminator'

// ── getDayOfYear ──────────────────────────────────────────────────────────────

describe('getDayOfYear', () => {
  it('returns 1 for Jan 1', () => {
    expect(getDayOfYear(new Date('2024-01-01T00:00:00Z'))).toBe(1)
  })

  it('returns 365 for Dec 31 (non-leap year)', () => {
    expect(getDayOfYear(new Date('2023-12-31T00:00:00Z'))).toBe(365)
  })

  it('returns 366 for Dec 31 (leap year)', () => {
    expect(getDayOfYear(new Date('2024-12-31T00:00:00Z'))).toBe(366)
  })

  it('returns ~172 for the summer solstice (June 21)', () => {
    const doy = getDayOfYear(new Date('2024-06-21T00:00:00Z'))
    expect(doy).toBeGreaterThan(170)
    expect(doy).toBeLessThan(175)
  })
})

// ── subsolarPoint ─────────────────────────────────────────────────────────────

describe('subsolarPoint', () => {
  it('returns [lng, lat] with lng in [-180, 180]', () => {
    const [lng] = subsolarPoint(new Date())
    expect(lng).toBeGreaterThanOrEqual(-180)
    expect(lng).toBeLessThanOrEqual(180)
  })

  it('declination near +23.44° at summer solstice (Jun 21)', () => {
    const [, lat] = subsolarPoint(new Date('2024-06-21T12:00:00Z'))
    expect(lat).toBeGreaterThan(22)
    expect(lat).toBeLessThan(24)
  })

  it('declination near -23.44° at winter solstice (Dec 21)', () => {
    const [, lat] = subsolarPoint(new Date('2024-12-21T12:00:00Z'))
    expect(lat).toBeLessThan(-22)
    expect(lat).toBeGreaterThan(-24)
  })

  it('declination near 0° around vernal equinox (Mar 20)', () => {
    const [, lat] = subsolarPoint(new Date('2024-03-20T12:00:00Z'))
    expect(Math.abs(lat)).toBeLessThan(2)
  })

  it('subsolar longitude is near 0° at UTC noon on a meridian day', () => {
    // At UTC 12:00 the sun is over roughly 0° longitude
    const [lng] = subsolarPoint(new Date('2024-06-21T12:00:00Z'))
    expect(Math.abs(lng)).toBeLessThan(15) // within one time-zone's width
  })

  it('subsolar longitude shifts by ~180° between UTC midnight and noon', () => {
    const [lngNoon] = subsolarPoint(new Date('2024-03-20T12:00:00Z'))
    const [lngMidnight] = subsolarPoint(new Date('2024-03-20T00:00:00Z'))
    const diff = Math.abs(lngNoon - lngMidnight)
    // Should be ~180° apart (allow some calendar rounding)
    expect(diff).toBeGreaterThan(170)
    expect(diff).toBeLessThan(190)
  })
})

// ── computeTerminator ─────────────────────────────────────────────────────────

describe('computeTerminator', () => {
  const date = new Date('2024-06-21T12:00:00Z')

  it('returns a GeoJSON Feature<Polygon>', () => {
    const f = computeTerminator(date)
    expect(f.type).toBe('Feature')
    expect(f.geometry.type).toBe('Polygon')
  })

  it('polygon ring is closed (first === last vertex)', () => {
    const ring = computeTerminator(date).geometry.coordinates[0]
    const first = ring[0]
    const last = ring[ring.length - 1]
    expect(first[0]).toBeCloseTo(last[0], 5)
    expect(first[1]).toBeCloseTo(last[1], 5)
  })

  it('ring has the expected number of vertices (numPoints + 4 for closure edges)', () => {
    const f = computeTerminator(date, 360)
    const ring = f.geometry.coordinates[0]
    // [-180,nightPole], 361 terminator pts, [180,nightPole], close = 364
    expect(ring.length).toBe(364)
  })

  it('night pole is south (-90) when sun is in north', () => {
    // Summer solstice — sun is north, so night pole should be south
    const ring = computeTerminator(date).geometry.coordinates[0]
    // First vertex is [-180, nightPole]
    expect(ring[0][1]).toBe(-90)
  })

  it('night pole is north (+90) when sun is in south', () => {
    const winterDate = new Date('2024-12-21T12:00:00Z')
    const ring = computeTerminator(winterDate).geometry.coordinates[0]
    expect(ring[0][1]).toBe(90)
  })

  it('all longitudes are in [-180, 180]', () => {
    const ring = computeTerminator(date).geometry.coordinates[0]
    for (const [lng] of ring) {
      expect(lng).toBeGreaterThanOrEqual(-180)
      expect(lng).toBeLessThanOrEqual(180)
    }
  })
})

// ── computeTerminatorCurve ────────────────────────────────────────────────────

describe('computeTerminatorCurve', () => {
  const date = new Date('2024-06-21T12:00:00Z')

  it('returns a GeoJSON Feature<LineString>', () => {
    const f = computeTerminatorCurve(date)
    expect(f.type).toBe('Feature')
    expect(f.geometry.type).toBe('LineString')
  })

  it('has numPoints+1 coordinates', () => {
    const f = computeTerminatorCurve(date, 360)
    expect(f.geometry.coordinates).toHaveLength(361)
  })

  it('does NOT start or end at ±180 with a pole latitude (no seam)', () => {
    // The seam bug produced coords like [-180, ±90] — verify curve latitudes
    // stay in the normal terminator latitude band (not jumping to ±90 at ends)
    const coords = computeTerminatorCurve(date).geometry.coordinates
    const firstLat = coords[0][1]
    const lastLat = coords[coords.length - 1][1]
    // Terminator lats for summer solstice should be within ~[-90, 90]
    // but should NOT be an exact pole except near equinox
    expect(Math.abs(firstLat)).toBeLessThan(89)
    expect(Math.abs(lastLat)).toBeLessThan(89)
  })

  it('all latitudes are in [-90, 90]', () => {
    const coords = computeTerminatorCurve(date).geometry.coordinates
    for (const [, lat] of coords) {
      expect(lat).toBeGreaterThanOrEqual(-90)
      expect(lat).toBeLessThanOrEqual(90)
    }
  })
})
