import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLong,
  degreesLat,
} from 'satellite.js'
import type { SatRec } from 'satellite.js'
import type { FeatureCollection, Feature, Point, LineString } from 'geojson'

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
  name: string
  group: SatGroup
  lng: number
  lat: number
  altitudeKm: number
}

// ─── Group styling config ────────────────────────────────────────────────────

export const SATELLITE_GROUPS = {
  iss:      { color: '#FFD700', dotRadius: 5,   glowRadius: 12, opacity: 1.0  },
  station:  { color: '#FFD700', dotRadius: 2,   glowRadius: 4,  opacity: 0.6  },
  starlink: { color: '#00E5FF', dotRadius: 1,   glowRadius: 2,  opacity: 0.5  },
  gps:      { color: '#69F0AE', dotRadius: 2,   glowRadius: 4,  opacity: 0.7  },
  geo:      { color: '#B388FF', dotRadius: 2,   glowRadius: 4,  opacity: 0.7  },
  debris:   { color: '#FF7043', dotRadius: 1,   glowRadius: 2,  opacity: 0.45 },
  active:   { color: '#82B1FF', dotRadius: 1.2, glowRadius: 3,  opacity: 0.55 },
} as const

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

// ─── GeoJSON builders ────────────────────────────────────────────────────────

export function buildSatelliteGeoJSON(
  positions: SatPosition[],
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: positions.map((pos) => ({
      type: 'Feature',
      properties: {
        name: pos.name,
        group: pos.group,
        altitude_km: Math.round(pos.altitudeKm),
      },
      geometry: {
        type: 'Point',
        coordinates: [pos.lng, pos.lat],
      },
    })),
  }
}

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
