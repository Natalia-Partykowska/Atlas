import {
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
} from 'satellite.js'
import type { SatRec } from 'satellite.js'

const EARTH_RADIUS_KM = 6378.137

export interface OrbitSample {
  lng: number
  lat: number
  altKm: number
}

export function periodMinutes(meanMotionRadPerMin: number): number {
  return (2 * Math.PI) / meanMotionRadPerMin
}

export function inclinationDegrees(inclinationRad: number): number {
  return (inclinationRad * 180) / Math.PI
}

export function apsidesKm(satrec: SatRec): { perigeeKm: number; apogeeKm: number } {
  const a = satrec.a
  const e = satrec.ecco
  return {
    perigeeKm: EARTH_RADIUS_KM * (a * (1 - e) - 1),
    apogeeKm: EARTH_RADIUS_KM * (a * (1 + e) - 1),
  }
}

export function velocityKmS(velocity: { x: number; y: number; z: number }): number {
  return Math.hypot(velocity.x, velocity.y, velocity.z)
}

/**
 * One full orbit of the satellite, projected onto Earth at the *current*
 * sidereal moment. All samples share a single `gstime(now)` so the line is the
 * orbital ellipse in current ECEF coordinates — a closed ring on the globe
 * (first and last samples coincide because the orbit is periodic in ECI and
 * the conversion is identical for both). Refresh on each position batch to
 * keep the ring oriented to current Earth rotation.
 */
export function generateOrbitPoints(
  satrec: SatRec,
  now: Date,
  samples = 180,
): OrbitSample[] {
  const periodMs = ((2 * Math.PI) / satrec.no) * 60 * 1000
  const gmst = gstime(now)
  const points: OrbitSample[] = []
  for (let i = 0; i <= samples; i++) {
    const t = new Date(now.getTime() + (i / samples) * periodMs)
    const pv = propagate(satrec, t)
    if (!pv) continue
    const pos = pv.position
    if (typeof pos === 'boolean' || !pos) continue
    const geo = eciToGeodetic(pos, gmst)
    const lng = degreesLong(geo.longitude)
    const lat = degreesLat(geo.latitude)
    const altKm = geo.height
    if (Number.isFinite(lng) && Number.isFinite(lat) && Number.isFinite(altKm)) {
      points.push({ lng, lat, altKm })
    }
  }
  // Force exact closure. SGP4 secular perturbations push sample N off sample 0
  // by ~0.2° per orbit — invisible most of the time but breaks the visual loop
  // right where the selection halo masks it. Snapping the last vertex to the
  // first guarantees the line closes cleanly under the halo.
  if (points.length > 1) {
    points[points.length - 1] = { ...points[0] }
  }
  return points
}
