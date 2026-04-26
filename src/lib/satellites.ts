import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLong,
  degreesLat,
} from 'satellite.js'
import type { SatRec } from 'satellite.js'
import type { FeatureCollection, Feature, LineString } from 'geojson'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SatGroup =
  | 'iss'
  | 'starlink'
  | 'gps'
  | 'station'
  | 'geo'
  | 'debris'
  | 'active'

export interface SatTLEEntry {
  name: string
  group: SatGroup
  tle1: string
  tle2: string
}

export interface ParsedSatellite {
  name: string
  group: SatGroup
  satrec: SatRec
}

export interface SatPosition {
  norad: number
  name: string
  group: SatGroup
  lng: number
  lat: number
  altitudeKm: number
}

// ─── Group styling config ────────────────────────────────────────────────────

export const SATELLITE_GROUPS = {
  iss:      { color: '#FFFFFF', dotRadius: 1.2, glowRadius: 3,  opacity: 0.55 },
  station:  { color: '#FFFFFF', dotRadius: 2,   glowRadius: 4,  opacity: 0.6  },
  starlink: { color: '#00E5FF', dotRadius: 1,   glowRadius: 2,  opacity: 0.5  },
  gps:      { color: '#4DD0E1', dotRadius: 2,   glowRadius: 4,  opacity: 0.7  },
  geo:      { color: '#B388FF', dotRadius: 2,   glowRadius: 4,  opacity: 0.7  },
  debris:   { color: '#FF5252', dotRadius: 1,   glowRadius: 2,  opacity: 0.45 },
  active:   { color: '#82B1FF', dotRadius: 1.2, glowRadius: 3,  opacity: 0.55 },
} as const

// Indices 0..5 must match GROUP_BY_U8 in orbitStream.ts (the wire format).
// `starlink` only appears in the bundled fallback JSON, so it tails at index 6.
export const GROUP_INDEX: Record<SatGroup, number> = {
  iss: 0,
  station: 1,
  gps: 2,
  geo: 3,
  debris: 4,
  active: 5,
  starlink: 6,
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

export function parseTLEData(entries: SatTLEEntry[]): ParsedSatellite[] {
  const result: ParsedSatellite[] = []
  for (const entry of entries) {
    try {
      const satrec = twoline2satrec(entry.tle1, entry.tle2)
      if (satrec.error === 0) {
        result.push({ name: entry.name, group: entry.group, satrec })
      }
    } catch {
      // Skip invalid TLE entries silently
    }
  }
  return result
}

// ─── Propagation ─────────────────────────────────────────────────────────────

export function propagateAll(
  satellites: ParsedSatellite[],
  date: Date,
): SatPosition[] {
  const gmst = gstime(date)
  const positions: SatPosition[] = []

  for (const sat of satellites) {
    try {
      const pv = propagate(sat.satrec, date)
      if (!pv) continue
      const pos = pv.position
      if (typeof pos === 'boolean' || !pos) continue

      const geodetic = eciToGeodetic(pos, gmst)
      const lng = degreesLong(geodetic.longitude)
      const lat = degreesLat(geodetic.latitude)
      const altitudeKm = geodetic.height

      // Sanity check
      if (isNaN(lng) || isNaN(lat) || isNaN(altitudeKm)) continue

      positions.push({
        norad: parseInt(sat.satrec.satnum, 10) || 0,
        name: sat.name,
        group: sat.group,
        lng,
        lat,
        altitudeKm,
      })
    } catch {
      // Propagation can fail for stale TLEs — skip silently
    }
  }

  return positions
}

// ─── Renderer packer ─────────────────────────────────────────────────────────

export interface PackedSatellites {
  // 3 floats per vertex: [mercX, mercY, altitudeMeters]
  posBuffer: Float32Array
  // 1 byte per vertex: group index (matches GROUP_INDEX)
  metaBuffer: Uint8Array
  count: number
}

/**
 * Pack positions into typed arrays for the SatelliteLayer custom WebGL layer.
 * Mercator x/y math matches `MercatorCoordinate.fromLngLat`, expanded inline
 * to avoid pulling in maplibregl per vertex at 5 Hz × ~17k satellites.
 */
export function packSatellitePositions(positions: SatPosition[]): PackedSatellites {
  const count = positions.length
  const posBuffer = new Float32Array(count * 3)
  const metaBuffer = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const p = positions[i]
    const x = (p.lng + 180) / 360
    const sinLat = Math.sin((p.lat * Math.PI) / 180)
    const y = 0.5 - (0.25 * Math.log((1 + sinLat) / (1 - sinLat))) / Math.PI
    posBuffer[i * 3 + 0] = x
    posBuffer[i * 3 + 1] = y
    posBuffer[i * 3 + 2] = p.altitudeKm * 1000
    metaBuffer[i] = GROUP_INDEX[p.group] ?? GROUP_INDEX.active
  }
  return { posBuffer, metaBuffer, count }
}

// ─── GeoJSON builders ────────────────────────────────────────────────────────

export function buildISSTrail(
  satellites: ParsedSatellite[],
  date: Date,
): FeatureCollection<LineString> {
  const iss = satellites.find(
    (s) => s.group === 'iss' || (s.group === 'station' && s.name.includes('ISS')),
  )
  if (!iss) return { type: 'FeatureCollection', features: [] }

  // Propagate ~90 minutes forward (one full orbit), every 30 seconds
  const points: [number, number][] = []
  const orbitMs = 92 * 60 * 1000 // ~92 min for ISS
  const stepMs = 30 * 1000

  for (let t = 0; t <= orbitMs; t += stepMs) {
    const futureDate = new Date(date.getTime() + t)
    const gmst = gstime(futureDate)
    try {
      const pv = propagate(iss.satrec, futureDate)
      if (!pv) continue
      const pos = pv.position
      if (typeof pos === 'boolean' || !pos) continue
      const geodetic = eciToGeodetic(pos, gmst)
      const lng = degreesLong(geodetic.longitude)
      const lat = degreesLat(geodetic.latitude)
      if (!isNaN(lng) && !isNaN(lat)) {
        points.push([lng, lat])
      }
    } catch {
      // skip
    }
  }

  if (points.length < 2) return { type: 'FeatureCollection', features: [] }

  // Split into segments where longitude doesn't jump > 180 (anti-meridian)
  const segments: [number, number][][] = [[points[0]]]
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    if (Math.abs(curr[0] - prev[0]) > 180) {
      segments.push([curr])
    } else {
      segments[segments.length - 1].push(curr)
    }
  }

  const features: Feature<LineString>[] = segments
    .filter((seg) => seg.length >= 2)
    .map((seg) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: seg },
    }))

  return { type: 'FeatureCollection', features }
}
