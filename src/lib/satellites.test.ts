import { describe, it, expect } from 'vitest'
import {
  parseTLEData,
  propagateAll,
  packSatellitePositions,
  buildISSTrail,
  SATELLITE_GROUPS,
  GROUP_INDEX,
} from './satellites'
import type { SatTLEEntry, SatPosition, ParsedSatellite, SatGroup } from './satellites'

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

  it('ISS shares the same render profile as `active` (no longer a hero)', () => {
    expect(SATELLITE_GROUPS.iss.dotRadius).toBe(SATELLITE_GROUPS.active.dotRadius)
    expect(SATELLITE_GROUPS.iss.glowRadius).toBe(SATELLITE_GROUPS.active.glowRadius)
    expect(SATELLITE_GROUPS.iss.opacity).toBe(SATELLITE_GROUPS.active.opacity)
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

// ── GROUP_INDEX ──────────────────────────────────────────────────────────────

describe('GROUP_INDEX', () => {
  it('every SATELLITE_GROUPS key has a unique index', () => {
    const indices = Object.values(GROUP_INDEX)
    expect(new Set(indices).size).toBe(indices.length)
  })

  it('indices 0..5 match the wire format (GROUP_BY_U8 in orbitStream)', () => {
    // Wire u8: 0:iss, 1:station, 2:gps, 3:geo, 4:debris, 5:active
    expect(GROUP_INDEX.iss).toBe(0)
    expect(GROUP_INDEX.station).toBe(1)
    expect(GROUP_INDEX.gps).toBe(2)
    expect(GROUP_INDEX.geo).toBe(3)
    expect(GROUP_INDEX.debris).toBe(4)
    expect(GROUP_INDEX.active).toBe(5)
  })

  it('starlink (fallback-only) sits at the tail without colliding with wire indices', () => {
    expect(GROUP_INDEX.starlink).toBe(6)
  })

  it('covers every group declared in SATELLITE_GROUPS', () => {
    for (const key of Object.keys(SATELLITE_GROUPS)) {
      expect(GROUP_INDEX).toHaveProperty(key)
    }
  })
})

// ── packSatellitePositions ────────────────────────────────────────────────────

describe('packSatellitePositions', () => {
  const POSITIONS: SatPosition[] = [
    { name: 'ISS (ZARYA)', group: 'iss', lng: 45.5, lat: 30.2, altitudeKm: 408.3 },
    { name: 'STARLINK-1', group: 'active', lng: -120.1, lat: -15.7, altitudeKm: 550.0 },
  ]

  it('returns posBuffer length = count × 3 and metaBuffer length = count', () => {
    const packed = packSatellitePositions(POSITIONS)
    expect(packed.count).toBe(2)
    expect(packed.posBuffer).toHaveLength(6)
    expect(packed.metaBuffer).toHaveLength(2)
  })

  it('handles an empty input', () => {
    const packed = packSatellitePositions([])
    expect(packed.count).toBe(0)
    expect(packed.posBuffer).toHaveLength(0)
    expect(packed.metaBuffer).toHaveLength(0)
  })

  it('(lng=0, lat=0) maps to mercator (0.5, 0.5)', () => {
    const packed = packSatellitePositions([
      { name: 'origin', group: 'iss', lng: 0, lat: 0, altitudeKm: 0 },
    ])
    expect(packed.posBuffer[0]).toBeCloseTo(0.5, 5)
    expect(packed.posBuffer[1]).toBeCloseTo(0.5, 5)
  })

  it('(lng=180, lat=0) maps to mercator x=1', () => {
    const packed = packSatellitePositions([
      { name: 'antimeridian', group: 'iss', lng: 180, lat: 0, altitudeKm: 0 },
    ])
    expect(packed.posBuffer[0]).toBeCloseTo(1.0, 5)
    expect(packed.posBuffer[1]).toBeCloseTo(0.5, 5)
  })

  it('(lng=-180, lat=0) maps to mercator x=0', () => {
    const packed = packSatellitePositions([
      { name: 'antimeridian-w', group: 'iss', lng: -180, lat: 0, altitudeKm: 0 },
    ])
    expect(packed.posBuffer[0]).toBeCloseTo(0.0, 5)
  })

  it('mercator y monotonically decreases as latitude increases (north → smaller y)', () => {
    const packed = packSatellitePositions([
      { name: 'south', group: 'iss', lng: 0, lat: -45, altitudeKm: 0 },
      { name: 'eq',    group: 'iss', lng: 0, lat: 0,   altitudeKm: 0 },
      { name: 'north', group: 'iss', lng: 0, lat: 45,  altitudeKm: 0 },
    ])
    const ySouth = packed.posBuffer[1]
    const yEq = packed.posBuffer[1 + 3]
    const yNorth = packed.posBuffer[1 + 6]
    expect(ySouth).toBeGreaterThan(yEq)
    expect(yEq).toBeGreaterThan(yNorth)
  })

  it('altitude is converted from km to meters', () => {
    const packed = packSatellitePositions([POSITIONS[0]])
    expect(packed.posBuffer[2]).toBeCloseTo(408_300, 1) // 408.3 km × 1000
  })

  it('group byte matches GROUP_INDEX', () => {
    const packed = packSatellitePositions(POSITIONS)
    expect(packed.metaBuffer[0]).toBe(GROUP_INDEX.iss)
    expect(packed.metaBuffer[1]).toBe(GROUP_INDEX.active)
  })

  it('falls back to active for an unknown group string', () => {
    const packed = packSatellitePositions([
      { name: 'odd', group: 'unknown' as SatGroup, lng: 0, lat: 0, altitudeKm: 0 },
    ])
    expect(packed.metaBuffer[0]).toBe(GROUP_INDEX.active)
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
