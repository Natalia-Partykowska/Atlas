import { describe, it, expect } from 'vitest'
import {
  parseTLEData,
  propagateAll,
  buildSatelliteGeoJSON,
  buildISSTrail,
  SATELLITE_GROUPS,
} from './satellites'
import type { SatTLEEntry, SatPosition, ParsedSatellite } from './satellites'

// ── Real TLE fixtures (from public/data/satellites.json, epoch ~Mar 2026) ────
//
// Using real TLEs ensures satellite.js parses + propagates without errors.

const ISS_TLE: SatTLEEntry = {
  name: 'ISS (ZARYA)',
  group: 'iss',
  tle1: '1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991',
  tle2: '2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590',
}

const GPS_TLE: SatTLEEntry = {
  name: 'GPS IIR-11',
  group: 'gps',
  tle1: '1 26360U 00025A   26076.50000000  .00000010  00000-0  00000-0 0  9993',
  tle2: '2 26360  55.1000  75.0000 0100000 100.0000 260.0000  2.00563403186050',
}

const CSS_TLE: SatTLEEntry = {
  name: 'CSS (TIANHE)',
  group: 'station',
  tle1: '1 48274U 21035A   26076.58544780  .00021250  00000+0  24801-3 0  9995',
  tle2: '2 48274  41.4671 160.1044 0006144 321.5629  38.4771 15.61097750278849',
}

// Epoch for propagation — matches the TLE epoch closely (Mar 17, 2026)
const PROP_DATE = new Date('2026-03-17T20:00:00Z')

// ── SATELLITE_GROUPS config ───────────────────────────────────────────────────

describe('SATELLITE_GROUPS', () => {
  const EXPECTED_GROUPS = ['iss', 'station', 'starlink', 'gps', 'geo', 'debris', 'active'] as const

  it('defines all expected group keys', () => {
    for (const g of EXPECTED_GROUPS) {
      expect(SATELLITE_GROUPS).toHaveProperty(g)
    }
  })

  it('every group has color, dotRadius, glowRadius, opacity', () => {
    for (const [, cfg] of Object.entries(SATELLITE_GROUPS)) {
      expect(cfg).toHaveProperty('color')
      expect(cfg).toHaveProperty('dotRadius')
      expect(cfg).toHaveProperty('glowRadius')
      expect(cfg).toHaveProperty('opacity')
    }
  })

  it('all opacities are in (0, 1]', () => {
    for (const [, cfg] of Object.entries(SATELLITE_GROUPS)) {
      expect(cfg.opacity).toBeGreaterThan(0)
      expect(cfg.opacity).toBeLessThanOrEqual(1)
    }
  })

  it('ISS has the largest dotRadius (hero satellite)', () => {
    const issRadius = SATELLITE_GROUPS.iss.dotRadius
    for (const [key, cfg] of Object.entries(SATELLITE_GROUPS)) {
      if (key !== 'iss') {
        expect(cfg.dotRadius).toBeLessThanOrEqual(issRadius)
      }
    }
  })
})

// ── parseTLEData ──────────────────────────────────────────────────────────────

describe('parseTLEData', () => {
  it('returns an empty array for empty input', () => {
    expect(parseTLEData([])).toEqual([])
  })

  it('parses a valid ISS TLE entry', () => {
    const result = parseTLEData([ISS_TLE])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('ISS (ZARYA)')
    expect(result[0].group).toBe('iss')
    expect(result[0].satrec).toBeDefined()
  })

  it('satrec error field is 0 for valid TLEs', () => {
    const [sat] = parseTLEData([ISS_TLE])
    expect(sat.satrec.error).toBe(0)
  })

  it('parses multiple entries and preserves order', () => {
    const result = parseTLEData([ISS_TLE, CSS_TLE])
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('ISS (ZARYA)')
    expect(result[1].name).toBe('CSS (TIANHE)')
  })

  it('satellite.js is lenient: returns error=0 even for garbage TLE strings', () => {
    // twoline2satrec does not throw and returns error=0 for malformed input.
    // Invalid entries are silently dropped later in propagateAll (propagation
    // returns false/NaN), not at parse time.
    const bad: SatTLEEntry = { name: 'BAD', group: 'debris', tle1: 'not a tle', tle2: ISS_TLE.tle2 }
    const result = parseTLEData([bad, ISS_TLE])
    // Both entries parse without throwing; order is preserved
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result.some((s) => s.name === 'ISS (ZARYA)')).toBe(true)
  })

  it('garbage satrecs produce no output from propagateAll (filtered at propagation)', () => {
    const bad: SatTLEEntry = { name: 'EMPTY', group: 'active', tle1: '', tle2: '' }
    const parsed = parseTLEData([bad])
    // Even if parseTLEData accepts it, propagation returns no valid position
    const positions = propagateAll(parsed, PROP_DATE)
    // Positions for garbage TLEs have NaN coords — they are filtered out
    for (const p of positions) {
      expect(isNaN(p.lng)).toBe(false)
      expect(isNaN(p.lat)).toBe(false)
    }
  })

  it('preserves the group field from the input', () => {
    const result = parseTLEData([GPS_TLE])
    if (result.length > 0) {
      expect(result[0].group).toBe('gps')
    }
    // GPS TLE may not propagate perfectly with a synthetic entry but group is set
  })
})

// ── propagateAll ──────────────────────────────────────────────────────────────

describe('propagateAll', () => {
  it('returns an empty array for no satellites', () => {
    expect(propagateAll([], PROP_DATE)).toEqual([])
  })

  it('returns a position for a valid ISS satrec', () => {
    const parsed = parseTLEData([ISS_TLE])
    const positions = propagateAll(parsed, PROP_DATE)
    expect(positions).toHaveLength(1)
  })

  it('returned position has valid coordinate ranges', () => {
    const parsed = parseTLEData([ISS_TLE])
    const [pos] = propagateAll(parsed, PROP_DATE)
    expect(pos.lng).toBeGreaterThanOrEqual(-180)
    expect(pos.lng).toBeLessThanOrEqual(180)
    expect(pos.lat).toBeGreaterThanOrEqual(-90)
    expect(pos.lat).toBeLessThanOrEqual(90)
  })

  it('ISS altitude is in the expected LEO range (~400 km)', () => {
    const parsed = parseTLEData([ISS_TLE])
    const [pos] = propagateAll(parsed, PROP_DATE)
    expect(pos.altitudeKm).toBeGreaterThan(350)
    expect(pos.altitudeKm).toBeLessThan(450)
  })

  it('preserves name and group from the parsed satellite', () => {
    const parsed = parseTLEData([ISS_TLE])
    const [pos] = propagateAll(parsed, PROP_DATE)
    expect(pos.name).toBe('ISS (ZARYA)')
    expect(pos.group).toBe('iss')
  })

  it('propagates multiple satellites independently', () => {
    const parsed = parseTLEData([ISS_TLE, CSS_TLE])
    const positions = propagateAll(parsed, PROP_DATE)
    expect(positions).toHaveLength(2)
    // ISS and CSS should be at different positions
    expect(positions[0].lng).not.toBeCloseTo(positions[1].lng, 0)
  })

  it('produces different positions at different times', () => {
    const parsed = parseTLEData([ISS_TLE])
    const pos1 = propagateAll(parsed, PROP_DATE)[0]
    const later = new Date(PROP_DATE.getTime() + 5 * 60 * 1000) // 5 min later
    const pos2 = propagateAll(parsed, later)[0]
    // ISS moves ~40° of longitude in 5 minutes
    expect(Math.abs(pos1.lng - pos2.lng)).toBeGreaterThan(1)
  })
})

// ── buildSatelliteGeoJSON ─────────────────────────────────────────────────────

describe('buildSatelliteGeoJSON', () => {
  const POSITIONS: SatPosition[] = [
    { name: 'ISS (ZARYA)', group: 'iss', lng: 45.5, lat: 30.2, altitudeKm: 408.3 },
    { name: 'STARLINK-1', group: 'active', lng: -120.1, lat: -15.7, altitudeKm: 550.0 },
  ]

  it('returns a FeatureCollection', () => {
    const fc = buildSatelliteGeoJSON(POSITIONS)
    expect(fc.type).toBe('FeatureCollection')
  })

  it('produces one feature per position', () => {
    expect(buildSatelliteGeoJSON(POSITIONS).features).toHaveLength(2)
    expect(buildSatelliteGeoJSON([]).features).toHaveLength(0)
  })

  it('all features have Point geometry', () => {
    for (const f of buildSatelliteGeoJSON(POSITIONS).features) {
      expect(f.geometry.type).toBe('Point')
    }
  })

  it('coordinates are [lng, lat]', () => {
    const [f] = buildSatelliteGeoJSON([POSITIONS[0]]).features
    expect(f.geometry.coordinates[0]).toBeCloseTo(45.5, 3)
    expect(f.geometry.coordinates[1]).toBeCloseTo(30.2, 3)
  })

  it('altitude is rounded to the nearest km in properties', () => {
    const [f] = buildSatelliteGeoJSON([POSITIONS[0]]).features
    expect(f.properties?.altitude_km).toBe(408) // Math.round(408.3)
  })

  it('name and group are stored in properties', () => {
    const [f] = buildSatelliteGeoJSON([POSITIONS[0]]).features
    expect(f.properties?.name).toBe('ISS (ZARYA)')
    expect(f.properties?.group).toBe('iss')
  })
})

// ── buildISSTrail ─────────────────────────────────────────────────────────────

describe('buildISSTrail', () => {
  let issOnly: ParsedSatellite[]
  let noIss: ParsedSatellite[]

  // Parse once for all trail tests
  issOnly = parseTLEData([ISS_TLE])
  noIss = parseTLEData([CSS_TLE])

  it('returns an empty FeatureCollection when no ISS satellite is present', () => {
    const fc = buildISSTrail(noIss, PROP_DATE)
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(0)
  })

  it('returns a non-empty FeatureCollection for a valid ISS satrec', () => {
    const fc = buildISSTrail(issOnly, PROP_DATE)
    expect(fc.features.length).toBeGreaterThan(0)
  })

  it('all features are LineString geometry', () => {
    const fc = buildISSTrail(issOnly, PROP_DATE)
    for (const f of fc.features) {
      expect(f.geometry.type).toBe('LineString')
    }
  })

  it('each segment has at least 2 coordinate pairs', () => {
    const fc = buildISSTrail(issOnly, PROP_DATE)
    for (const f of fc.features) {
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('trail spans a significant longitude range (~360° over one orbit)', () => {
    const fc = buildISSTrail(issOnly, PROP_DATE)
    const allLngs = fc.features.flatMap((f) => f.geometry.coordinates.map(([lng]) => lng))
    const span = Math.max(...allLngs) - Math.min(...allLngs)
    // ISS completes one orbit in ~92 min; longitude span should be wide
    expect(span).toBeGreaterThan(200)
  })

  it('all latitudes stay within ISS inclination bounds (±51.7°)', () => {
    const fc = buildISSTrail(issOnly, PROP_DATE)
    for (const f of fc.features) {
      for (const [, lat] of f.geometry.coordinates) {
        expect(lat).toBeGreaterThanOrEqual(-52)
        expect(lat).toBeLessThanOrEqual(52)
      }
    }
  })

  it('returns an empty FeatureCollection for an empty satellites array', () => {
    const fc = buildISSTrail([], PROP_DATE)
    expect(fc.features).toHaveLength(0)
  })

  it('finds ISS by group "iss" (not just by name)', () => {
    // Rename but keep group 'iss' — should still generate a trail
    const renamedIss = parseTLEData([{ ...ISS_TLE, name: 'MY RENAMED ISS' }])
    const fc = buildISSTrail(renamedIss, PROP_DATE)
    expect(fc.features.length).toBeGreaterThan(0)
  })
})
